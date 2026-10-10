const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const { JobError, requireKey, providerRequest, getModels, preferredModel, callSettings, TranscriptAssembler } = require("./ultravox");
const { evaluatorInput } = require("./evaluation");
const { getRubric, evaluatorPrompt, config: rubricConfig } = require("./rubric");
const { validateEvaluation } = require("./rubric-validation");
const { buildPromptUpdates, buildPromptProposal } = require("./prompt-updates");
const { friendlyMessage } = require("./messages");
const { BASELINE_PROMPT } = require("./ultravox");
const { metricInputs, performance, sameAudio } = require("./performance");
const INTERNAL_REVIEW = Symbol("sandbox review");
const { decodeExcerpt, fileHash } = require("./audio");

const TERMINAL = new Set(["finished", "partial", "failed", "cancelled"]);
const RESULTS = path.join(__dirname, "..", "var", "results");
const privateJoinUrls = new Set();

function redact(value) {
  if (typeof value === "string") {
    let text = value;
    const key = process.env.ULTRAVOX_API_KEY;
    if (key) text = text.split(key).join("[REDACTED]");
    for (const url of privateJoinUrls) text = text.split(url).join("[REDACTED JOIN URL]");
    return text.replace(/wss?:\/\/[^\s"'<>]+/gi, "[REDACTED WEBSOCKET URL]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/join.?url|api.?key|authorization/i.test(key)).map(([key, item]) => [key, redact(item)]));
  return value;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const done = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function closeSocket(socket) {
  if(!socket)return;
  await new Promise(resolve=>{
    if(socket.readyState===WebSocket.CLOSED){resolve();return;}
    const timer=setTimeout(()=>{socket.terminate();resolve();},1500);
    socket.once("close",()=>{clearTimeout(timer);resolve();});
    if(socket.readyState===WebSocket.OPEN){socket.send(JSON.stringify({type:"hang_up"}));socket.close();}
    else socket.terminate();
  });
}

function setupContext(raw = {}) {
  return {
    agentName: typeof raw.agentName === "string" ? raw.agentName : "",
    purpose: typeof raw.purpose === "string" ? raw.purpose : "",
    speechProfileTags: Array.isArray(raw.speechProfileTags) ? raw.speechProfileTags.filter(tag => typeof tag === "string") : [],
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : "",
  };
}

function useCaseMetadata(sample) {
  return typeof sample?.use_case_label === "string" && sample.use_case_label
    ? { id: sample.id, label: sample.use_case_label, summary: sample.use_case_summary || "" }
    : null;
}

class Jobs {
  constructor(resolveSample, { directory = RESULTS, services = {}, timeouts = {} } = {}) {
    this.resolveSample = resolveSample;
    this.directory = directory;
    // Constructor-only dependency injection lets tests exercise the real runner without paid calls.
    // There are no HTTP endpoints, env flags or client settings for replacing these services.
    this.services = {
      decodeExcerpt, fileHash, getModels, providerRequest,
      createSocket: url => new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 2000000 }),
      ...services,
    };
    this.timeouts = { baselineOverall: 260000, evaluationOverall: 95000, baselineFinal: 25000, evaluationFinal: 60000, ...timeouts };
    this.records = new Map();
    this.runtime = new Map();
    this.activeId = null;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(this.directory).filter(file => /^[a-f0-9-]+\.json$/.test(file))) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.directory, file), "utf8"));
        if (!record.id || !record.ownerHash) continue;
        if (!TERMINAL.has(record.status)) {
          record.status = "cancelled";
          record.endedAt = new Date().toISOString();
          record.outputPartial = !!record.rawOutput;
          record.error = { code: "SERVER_RESTARTED", message: friendlyMessage("SERVER_RESTARTED") };
          this.persist(record);
        }
        this.records.set(record.id, record);
      } catch {
        // A damaged result is never silently treated as an active job or retried.
        this.storageWarning = "One or more saved runs could not be read.";
      }
    }
  }
  persist(record) {
    try {
      const file = path.join(this.directory, `${record.id}.json`);
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(redact(record), null, 2), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {
      throw new JobError("STORAGE_FAILURE", "The run could not be saved to disk. Check server storage before starting another paid call.", 500);
    }
  }
  public(record) {
    const { ownerHash, ...safe } = record;
    return redact({ ...safe, elapsedMs: TERMINAL.has(record.status) ? record.elapsedMs : Date.now() - Date.parse(record.createdAt) });
  }
  list(ownerHash) {
    return [...this.records.values()].filter(record => record.ownerHash === ownerHash).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(record => this.public(record));
  }
  owned(id, ownerHash) {
    const record = this.records.get(id);
    if (!record || record.ownerHash !== ownerHash) throw new JobError("NOT_FOUND", "Run not found in this browser session.", 404);
    return record;
  }
  start(kind, input, ownerHash, internal) {
    requireKey();
    if (this.activeId && internal !== INTERNAL_REVIEW) throw new JobError("RUN_ACTIVE", "Another run is already active. Wait for it to finish or stop it before starting another.", 409);
    const audio = kind === "baseline" || kind === "candidate";
    const model = typeof input.model === "string" && input.model.length <= 128 ? input.model : null;
    let sampleInfo, baseline, context, useCase, rubric, referenceMaterial = "", pairedBaseline, sandbox;
    if (kind === "candidate" && input.sandboxEvaluationId) {
      const review = this.owned(String(input.sandboxEvaluationId),ownerHash);
      if(review.kind!=="evaluation"||review.status!=="finished"||!review.parsedResult)throw new JobError("SANDBOX_FAILED","A completed review is required.",409);
      if(input.currentPrompt!==undefined&&input.currentPrompt!==review.context.systemPrompt)throw new JobError("SNAPSHOT_REQUIRED","Prompt changed.",409);
      const base=this.owned(review.baselineId,ownerHash);
      const selected=Array.isArray(input.selectedEditIds)?input.selectedEditIds:null;
      const edits=(review.parsedResult.promptEdits||[]).filter(edit=>!selected||selected.includes(edit.id));
      if(input.promptPreset!=null&&input.promptPreset!=="readable-transcript-v1")throw new JobError("INVALID_REQUEST","Unknown prompt improvement.",400);
      const proposal=buildPromptProposal(review.context.systemPrompt,edits,review,base.rawOutput,review.referenceMaterial,input.promptPreset);
      if(!proposal.suggestedPrompt||!proposal.promptUpdates.length)throw new JobError("NO_SUGGESTED_PROMPT","No applicable edits selected.",409);
      const before=[...this.records.values()].find(run=>run.ownerHash===ownerHash&&run.kind==="candidate"&&run.status==="finished"&&sameAudio(base,run)&&run.promptUsed===review.context.systemPrompt&&(!input.beforeRunId||run.id===input.beforeRunId));
      if(!before)throw new JobError("BEFORE_REQUIRED","No matching current-prompt run.",409);
      sandbox={sourceEvaluationId:review.id,beforeRunId:before.id,selectedEditIds:proposal.promptUpdates.map(edit=>edit.id),promptPreset:proposal.promptPreset,originalPrompt:review.context.systemPrompt,proposedPrompt:proposal.suggestedPrompt,stage:"testing"};
      input={...input,sampleId:base.sampleId,startOffset:base.excerpt.startOffset,excerptLength:base.excerpt.excerptLength,model:base.requestedModel,pairedBaselineId:base.id,context:{...review.context,systemPrompt:proposal.suggestedPrompt},referenceMaterial:review.referenceMaterial};
    }
    if (audio) {
      sampleInfo = this.resolveSample(String(input.sampleId || ""));
      if (!sampleInfo?.file) throw new JobError("DECODE_FAILURE", "Select an available demo sample before running a baseline.", 400);
      context = setupContext(input.context || {
        agentName: sampleInfo.sample.agent_name, purpose: sampleInfo.sample.agent_purpose,
        speechProfileTags: sampleInfo.sample.speech_profile_tags, systemPrompt: sampleInfo.sample.system_prompt,
      });
      useCase = useCaseMetadata(sampleInfo.sample);
      referenceMaterial = typeof input.referenceMaterial === "string" ? input.referenceMaterial : "";
      if(referenceMaterial.length>100000)throw new JobError("INVALID_CONTEXT","Reference material too long.",400);
      if(kind==="candidate"&&(!context.systemPrompt.trim()||context.systemPrompt.length>20000))throw new JobError("INVALID_CONTEXT","Add a system prompt within 20,000 characters.",400);
      if(input.pairedBaselineId){pairedBaseline=this.owned(String(input.pairedBaselineId),ownerHash);if(pairedBaseline.kind!=="baseline"||pairedBaseline.status!=="finished")throw new JobError("PAIR_MISMATCH","Matching complete baseline required.",409);}
      const duration = Number(sampleInfo.sample.duration_seconds);
      const startOffset = input.startOffset == null ? 0 : Number(input.startOffset);
      const requestedLength = input.excerptLength == null ? 15 : input.excerptLength === "rest" ? duration - startOffset : Number(input.excerptLength);
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(startOffset) || startOffset < 0 || startOffset >= duration || !Number.isFinite(requestedLength) || requestedLength <= 0 || requestedLength > 180) {
        throw new JobError("INVALID_EXCERPT", "Choose a start offset inside the recording and an excerpt between 0 and 180 seconds.", 400);
      }
      input = { sampleId: sampleInfo.sample.id,model:input.model,startOffset,excerptLength:input.excerptLength ?? "15",requestedLength,length:Math.min(requestedLength,duration-startOffset) };
    } else {
      baseline = this.owned(String(input.baselineId || ""), ownerHash);
      if ((baseline.kind !== "baseline" && !(internal===INTERNAL_REVIEW&&baseline.kind==="candidate")) || !["finished", "partial"].includes(baseline.status) || !baseline.rawOutput.trim()) throw new JobError("BASELINE_REQUIRED", "A finished baseline or explicitly selected partial transcript is required before evaluation.", 400);
      context = setupContext(input.context);
      useCase = useCaseMetadata(this.resolveSample(baseline.sampleId)?.sample);
      rubric = getRubric(useCase);
      referenceMaterial = typeof input.referenceMaterial === "string" ? input.referenceMaterial : "";
      if (referenceMaterial.length > 100000) throw new JobError("INVALID_CONTEXT", "Reference material exceeds the 100,000-character server validation limit.", 400);
      if (JSON.stringify(context).length > 100000 || !context.systemPrompt.trim()) throw new JobError("INVALID_CONTEXT", "Provide a nonempty system prompt in the editor (maximum context size: 100,000 characters).", 400);
    }
    if (JSON.stringify(context).length > 100000) throw new JobError("INVALID_CONTEXT", "Setup metadata exceeds the 100,000-character limit.", 400);
    const record = {
      id: crypto.randomUUID(), ownerHash, kind,
      sampleId: audio ? input.sampleId : baseline.sampleId,
      baselineId: baseline?.id,
      createdAt: new Date().toISOString(), endedAt: null,
      status: "preparing", elapsedMs: 0, outputPartial: false,
      requestedModel: sandbox ? input.model : model || baseline?.requestedModel || null, resolvedModel: null, settings: null,
      progress: { audioSecondsSent: 0, audioSecondsTotal: audio ? input.length : 0, percent: 0 },
      rawOutput: "", userInputTranscript: "", transcripts: [],
      diagnostics: [], timings: {}, error: null,
      context, useCase, // Snapshots/metadata only; useCase never enters any provider prompt.
      ...(audio ? {
        excerpt: { startOffset: Number(input.startOffset || 0), excerptLength: String(input.excerptLength || "15"),length:input.length },
        promptUsed:kind==="baseline"?BASELINE_PROMPT:context.systemPrompt,
        inputSnapshot:{systemPrompt:kind==="baseline"?BASELINE_PROMPT:context.systemPrompt,referenceMaterialSuppliedToModel:false},
        recording:{id:sampleInfo.sample.id,label:sampleInfo.sample.title||sampleInfo.sample.id,audioUrl:sampleInfo.sample.audio_url||`/api/demo-samples/${encodeURIComponent(sampleInfo.sample.id)}/audio`,fileName:sampleInfo.sample.prototype_audio_file||path.basename(sampleInfo.file),durationSeconds:Number(sampleInfo.sample.duration_seconds)},
        referenceMaterial,pairedBaselineId:pairedBaseline?.id,sandbox,
        metricInputSnapshot:pairedBaseline?.metricInputSnapshot||metricInputs(sampleInfo.sample),performance:null,
        sampleMetadata: {
        agentName: context.agentName,
        purpose: context.purpose,
        speechProfileTags: context.speechProfileTags,
      } } : {
        rubric_version: rubricConfig.rubric_version,
        computedScores: null, parsedResult: null, parseError: null,
        rubric: { ...rubric, themes: rubricConfig.themes, severityPoints: rubricConfig.severity_points, confidencePercent: rubricConfig.confidence_percent, coveragePercent: rubricConfig.coverage_percent },
        evaluatorInput: evaluatorInput(context, baseline.rawOutput),
        evaluatorSystemPrompt: evaluatorPrompt(rubric),
        referenceMaterial, // Server edit-source validation only; never added to evaluator input.
      }),
    };
    this.persist(record); // Verify durable storage before creating a paid call.
    this.records.set(record.id, record);
    const controller = new AbortController();
    this.runtime.set(record.id, { controller });
    this.activeId = record.id;
    setImmediate(() => this.execute(record, sampleInfo, controller).catch(() => {
      // execute contains its own sanitized error handling. No exception content is logged.
      this.activeId = null;
      this.runtime.delete(record.id);
    }));
    return this.public(record);
  }
  stop(id, ownerHash) {
    const record = this.owned(id, ownerHash);
    const runtime = this.runtime.get(id);
    if (runtime) runtime.controller.abort(new JobError("CANCELLED", "Stopped by the user. Any captured output is partial."));
    return this.public(record);
  }
  update(record, status) {
    if (status && record.status !== status) {
      record.status = status;
      record.timings[`${status}At`] = new Date().toISOString();
      record.diagnostics.push({ event: status, elapsedMs: Date.now() - Date.parse(record.createdAt) });
    }
    const runtime = this.runtime.get(record.id);
    if (runtime && (!runtime.lastSave || Date.now() - runtime.lastSave > 1000)) {
      this.persist(record);
      runtime.lastSave = Date.now();
    }
  }
  async execute(record, sampleInfo, controller) {
    const signal = controller.signal;
    const audio=record.kind==="baseline"||record.kind==="candidate";
    const overall = setTimeout(() => controller.abort(new JobError("TIMEOUT", "The run exceeded its bounded total timeout. No automatic retry was attempted.")), audio ? this.timeouts.baselineOverall+(record.sandbox?this.timeouts.evaluationOverall:0) : this.timeouts.evaluationOverall);
    let socket, joinUrl;
    try {
      let pcm;
      if (audio) {
        pcm = await this.services.decodeExcerpt(sampleInfo.file, record.excerpt.startOffset, record.excerpt.length, signal);
        record.audioHashes = {
          sourceSha256: await this.services.fileHash(sampleInfo.file),
          excerptPcmSha256: crypto.createHash("sha256").update(pcm).digest("hex"),
        };
        record.progress.audioSecondsTotal = pcm.length / 32000;
        record.audioFormat = { sampleRate: 16000, channels: 1, bitsPerSample: 16, encoding: "s16le", byteLength: pcm.length };
      }
      if (signal.aborted) throw signal.reason;
      this.update(record, "connecting");
      const models = await this.services.getModels(signal, record.kind === "evaluation");
      record.requestedModel ||= preferredModel(models);
      let selectedModel = record.requestedModel;
      if (!models.some(model => model.id === selectedModel)) {
        if (record.kind !== "evaluation") throw new JobError("MODEL_UNAVAILABLE", `Requested model ${record.requestedModel} is not in Ultravox's available model list.`);
        selectedModel = preferredModel(models);
        record.diagnostics.push({ event: "requested_evaluator_model_unavailable_using_available_model", model: selectedModel });
      }
      record.settings = callSettings(record.kind, selectedModel, record.progress.audioSecondsTotal, audio?record.promptUsed:record.evaluatorSystemPrompt, record.evaluatorInput);
      if(record.pairedBaselineId){
        const base=this.records.get(record.pairedBaselineId);
        const common=settings=>{const {systemPrompt,...rest}=settings||{};return JSON.stringify(rest);};
        if(!sameAudio(base,record)||base.promptUsed!==BASELINE_PROMPT||common(base.settings)!==common(record.settings))throw new JobError("PAIR_MISMATCH","Audio, range, model, baseline prompt or settings changed.",409);
      }
      this.persist(record);
      const call = await this.services.providerRequest("/calls?enableGreetingPrompt=false", { method: "POST", body: record.settings, signal });
      record.resolvedModel = typeof call.model === "string" ? call.model : null;
      record.providerCallId = typeof call.callId === "string" ? call.callId : null;
      if (!record.resolvedModel) throw new JobError("NETWORK_FAILURE", "Ultravox did not report a resolved model.");
      joinUrl = call.joinUrl;
      if (typeof joinUrl !== "string" || !joinUrl.startsWith("wss://")) throw new JobError("NETWORK_FAILURE", "Ultravox did not return a valid server WebSocket connection.");
      privateJoinUrls.add(joinUrl);
      socket = this.services.createSocket(joinUrl);
      this.runtime.get(record.id).socket = socket;
      const assembler = new TranscriptAssembler();
      let providerState = "idle", lastAgentAt = 0, disconnected = false, connectionError = false;
      socket.on("message", (data, isBinary) => {
        if (isBinary || signal.aborted || TERMINAL.has(record.status)) return;
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (message.type === "state" && ["idle", "listening", "thinking", "speaking"].includes(message.state)) {
          providerState = message.state;
          record.diagnostics.push({ event: "provider_state", state: message.state, elapsedMs: Date.now() - Date.parse(record.createdAt) });
        }
        if (assembler.accept(message)) {
          record.transcripts = assembler.entries();
          record.rawOutput = assembler.text("agent");
          record.userInputTranscript = assembler.text("user");
          if (message.role === "agent") lastAgentAt = Date.now();
        }
      });
      socket.on("error", () => { connectionError = true; });
      socket.on("close", () => { disconnected = true; });
      await new Promise((resolve, reject) => {
        let settled=false;
        const finish=error=>{if(settled)return;settled=true;signal.removeEventListener("abort",abort);error?reject(error):resolve();};
        const abort = () => { if(settled)return;socket.terminate();finish(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        socket.once("open", () => finish());
        socket.once("error", () => { if(!settled)finish(new JobError("NETWORK_FAILURE", "The Ultravox WebSocket connection failed.")); });
        socket.once("close", () => { if(!settled)finish(new JobError("NETWORK_FAILURE", "Ultravox closed the WebSocket before joining.")); });
        if (signal.aborted) abort();
      });
      record.timings.joinedAt = new Date().toISOString();
      const send = data => {
        if (signal.aborted) throw signal.reason;
        if (socket.readyState !== WebSocket.OPEN || disconnected || connectionError) throw new JobError("NETWORK_FAILURE", "The Ultravox connection was lost. Captured output has not been retried.");
        if (socket.bufferedAmount > 256000) throw new JobError("NETWORK_FAILURE", "The WebSocket audio buffer exceeded its safe limit.");
        socket.send(data);
      };
      const silence = Buffer.alloc(640);
      if (audio) {
        this.update(record, "streaming");
        for (let offset = 0; offset < pcm.length; offset += 640) {
          const chunk = pcm.subarray(offset, offset + 640);
          send(chunk);
          record.progress.audioSecondsSent = Math.min(pcm.length, offset + chunk.length) / 32000;
          record.progress.percent = Math.round(record.progress.audioSecondsSent / record.progress.audioSecondsTotal * 100);
          this.update(record);
          await sleep(chunk.length / 32, signal); // 16 kHz mono s16le: exactly 32 bytes per ms; no burst replay.
        }
        for (let i = 0; i < 100; i++) { send(silence); await sleep(20, signal); }
      } else {
        this.update(record, "sending");
        record.timings.seededAt = record.createdAt;
      }
      this.update(record, "waiting");
      const waitingAt = Date.now();
      let fallbackSent = false;
      const waitLimit = audio ? this.timeouts.baselineFinal : this.timeouts.evaluationFinal;
      while (true) {
        if (signal.aborted) throw signal.reason;
        if (assembler.final() && Date.now() - lastAgentAt >= 750 && !["thinking", "speaking"].includes(providerState)) break;
        if (disconnected || connectionError) throw new JobError("NETWORK_FAILURE", "Ultravox disconnected before final output was confirmed.");
        if (Date.now() - waitingAt > waitLimit) {
          throw new JobError(record.rawOutput.trim() ? "TIMEOUT" : "EMPTY_RESPONSE", record.rawOutput.trim() ? "Final output was not confirmed before the timeout. Captured text is partial." : "Ultravox returned no agent output before the response deadline. No automatic retry was attempted.");
        }
        if (record.kind === "evaluation") {
          if (!fallbackSent && Date.now() - waitingAt > 4000 && !assembler.entries("agent").length && !["thinking", "speaking"].includes(providerState)) {
            send(JSON.stringify({ type: "user_text_message", text: record.evaluatorInput, urgency: "soon" }));
            fallbackSent = true;
            record.timings.fallbackSentAt = new Date().toISOString();
            record.diagnostics.push({ event: "seed_did_not_trigger_answer_user_text_sent", elapsedMs: Date.now() - Date.parse(record.createdAt) });
          }
          send(silence); // Liveness only: no recording audio is sent to the evaluator.
          await sleep(20, signal);
        } else await sleep(100, signal);
        this.update(record);
      }
      if (!record.rawOutput.trim()) throw new JobError("EMPTY_RESPONSE", "Ultravox returned an empty agent response.");
      record.timings.finalConfirmedAt = new Date().toISOString();
      if (record.kind === "evaluation") {
        const baseline = this.records.get(record.baselineId);
        const review = validateEvaluation(record.rawOutput, baseline, record.context.systemPrompt, record.rubric);
        Object.assign(record, review);
        if (review.parsedResult) {
          const updates = buildPromptUpdates(record.context.systemPrompt, review.parsedResult.promptEdits, review, baseline.rawOutput, record.referenceMaterial);
          const flags = [...record.validationFlags, ...updates.validationFlags];
          Object.assign(record, updates, { validationFlags: flags });
        }
      }
      if(audio)record.performance=performance(record.rawOutput,record.metricInputSnapshot);
      if(record.sandbox){
        record.sandbox.audioFinished=true;
        await closeSocket(socket);socket=null;
        record.status="finished"; // Completed audio is now valid input for the explicit sandbox review.
        const child=this.start("evaluation",{baselineId:record.id,context:record.context,model:record.requestedModel,referenceMaterial:record.referenceMaterial},record.ownerHash,INTERNAL_REVIEW);
        const childRecord=this.records.get(child.id);
        childRecord.parentRunId=record.id;childRecord.reviewStage="after";childRecord.sourceEvaluationId=record.sandbox.sourceEvaluationId;this.persist(childRecord);
        record.sandbox.afterEvaluationId=child.id;record.sandbox.stage="reviewing";this.update(record,"waiting");
        const cancel=()=>this.runtime.get(child.id)?.controller.abort(signal.reason);
        signal.addEventListener("abort",cancel,{once:true});
        try{while(this.runtime.has(child.id))await new Promise(resolve=>setTimeout(resolve,20));}
        finally{signal.removeEventListener("abort",cancel);}
        record.sandbox.reviewStatus=childRecord.status;record.sandbox.reviewError=childRecord.error;record.sandbox.stage="complete";
      }
      record.status = "finished";
    } catch (error) {
      const safe = error instanceof JobError ? error : new JobError("NETWORK_FAILURE", "The run failed unexpectedly. No automatic retry was attempted.");
      record.status = safe.code === "CANCELLED" ? "cancelled" : record.rawOutput.trim() ? "partial" : "failed";
      record.outputPartial = !!record.rawOutput;
      record.error = { code: safe.code, message: safe.message };
      record.diagnostics.push({ event: "error", code: safe.code, elapsedMs: Date.now() - Date.parse(record.createdAt) });
    } finally {
      clearTimeout(overall);
      await closeSocket(socket);
      record.endedAt = new Date().toISOString();
      record.elapsedMs = Date.now() - Date.parse(record.createdAt);
      try { this.persist(record); } catch (error) {
        record.status = "failed";
        record.error = { code: "STORAGE_FAILURE", message: friendlyMessage("STORAGE_FAILURE") };
      }
      if (joinUrl) privateJoinUrls.delete(joinUrl);
      this.runtime.delete(record.id);
      if (this.activeId === record.id) this.activeId = record.parentRunId && this.runtime.has(record.parentRunId) ? record.parentRunId : null;
    }
  }
  shutdown() {
    for (const { controller } of this.runtime.values()) controller.abort(new JobError("CANCELLED", "Server is shutting down. Any captured output is partial."));
  }
}

module.exports = { Jobs, TERMINAL, redact };
