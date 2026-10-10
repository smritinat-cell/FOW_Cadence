const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Jobs } = require("../lib/jobs");

// Never consume the real credential in this test process.
process.env.ULTRAVOX_API_KEY = "test-only-not-real";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = new Set(["finished", "failed", "partial", "cancelled"]);

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cadence-runner-"));
  const calls = [], sockets = [],decoded=[];
  class Socket extends EventEmitter {
    constructor(mode) {
      super();
      this.mode = mode;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.binary = [];
      this.text = [];
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
        if (mode === "evaluation" && !options.fallback && !options.emptyEvaluation) setTimeout(() => this.answer(), 20);
      });
    }
    message(value) { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
    answer() {
      const text = this.mode === "evaluation" ? JSON.stringify({
        summary: "Labelled test data review.",
        parameters: [
          { id: "intake.fillers_trailing", theme: "speech_patterns", observed: true, status: "issue" },
          { id: "intake.reason_visit", theme: "task_completeness", observed: true, status: "ok" },
        ],
        findings: [{ id: "i", parameter_id: "intake.fillers_trailing", severity: "low", confidence: "high", prompt_coverage: "none", coverage_quote: "", title: "Hesitation", quote: "um", why_it_matters: "Do not guess." }],
        prompt_edits: [{ id: "e", category: "clarification behaviour", addresses: ["i"], rationale: "Clarify.", type: "append", new_text: "Ask to repeat unclear words.", expected_effect: "Avoid guesses.", verify_by: "Check clarification." }],
      }) : "raw, um... words";
      this.message({ type: "transcript", role: "user", ordinal: 0, text: "Separate provider input", final: true });
      this.message({ type: "transcript", role: "agent", ordinal: 1, delta: "superseded", final: false });
      this.message({ type: "transcript", role: "agent", ordinal: 1, text, final: !options.unfinished });
      this.message({ type: "state", state: "listening" });
    }
    send(data) {
      if (Buffer.isBuffer(data)) {
        this.binary.push({ data: Buffer.from(data), at: Date.now() });
        if (this.mode === "baseline" && this.binary.length === 1) {
          if (options.disconnect) { this.close(); return; }
          if (!options.empty) this.answer();
        }
      } else {
        const message = JSON.parse(data);
        this.text.push(message);
        if (message.type === "user_text_message") this.answer();
      }
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.emit("close"));
    }
    terminate() { this.close(); }
  }
  const jobs = new Jobs(() => ({ file: "test.wav", sample: { id: "sample-01", duration_seconds: 15, agent_name: "Test", agent_purpose: "Test purpose", speech_profile_tags: ["Child"], use_case_label: "Teen pre-visit intake", use_case_summary: "Test use case summary.",...options.sample } }), {
    directory,
    timeouts: { baselineFinal: 60, ...options.timeouts },
    services: {
      decodeExcerpt: async (file,start,length) => {decoded.push({file,start,length});assert.ok(Number.isFinite(length)&&length>0);return Buffer.alloc(1280,1);},
      fileHash: async () => "test-source-hash",
      getModels: async () => options.changeEvaluatorModel && calls.length ? [{ id: "ultravox-v0.6" }] : [{ id: "ultravox-v0.7" }],
      providerRequest: async (route, request) => {
        calls.push({ route, settings: request.body });
        return { joinUrl: "wss://private.tests.invalid/join", model: request.body.model, callId: "test-call" };
      },
      createSocket: () => {
        const kind = calls.at(-1).settings.firstSpeakerSettings.agent ? "evaluation" : "baseline";
        const socket = new Socket(kind);
        sockets.push(socket);
        return socket;
      },
    },
  });
  return { jobs, calls, sockets,decoded,directory,cleanup() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

async function waitJob(jobs, id, expected) {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    const record = jobs.owned(id, "owner");
    if (expected ? record.status === expected : terminal.has(record.status) && !jobs.activeId) return record;
    await pause(10);
  }
  throw new Error("Test job exceeded its bound.");
}

test("candidate streams original audio with exact editor prompt and matched baseline settings",async()=>{
  const f=fixture();try{
    const context={systemPrompt:"Keep this exact prompt.\n  Keep whitespace.",agentName:"Test",purpose:"Test purpose",speechProfileTags:["Child"]};
    const base=await waitJob(f.jobs,f.jobs.start("baseline",{sampleId:"sample-01",startOffset:2,excerptLength:"10",context},"owner").id);
    const candidate=await waitJob(f.jobs,f.jobs.start("candidate",{sampleId:"sample-01",startOffset:2,excerptLength:"10",model:base.requestedModel,pairedBaselineId:base.id,context,referenceMaterial:"Context kept as metadata."},"owner").id);
    assert.equal(candidate.status,"finished");assert.equal(f.calls[1].settings.systemPrompt,context.systemPrompt);
    assert.deepEqual(f.calls[1].settings.firstSpeakerSettings,{user:{}});assert.equal(f.calls[1].settings.initialMessages,undefined);
    assert.deepEqual(f.decoded,[{file:"test.wav",start:2,length:10},{file:"test.wav",start:2,length:10}]);
    assert.deepEqual(f.sockets[0].binary.map(item=>item.data),f.sockets[1].binary.map(item=>item.data));
    assert.equal(candidate.pairedBaselineId,base.id);assert.equal(candidate.performance.accessibilityScore,null);
    assert.equal(candidate.inputSnapshot.referenceMaterialSuppliedToModel,false);assert.equal(candidate.referenceMaterial,"Context kept as metadata.");
    const changed=await waitJob(f.jobs,f.jobs.start("candidate",{sampleId:"sample-01",startOffset:3,excerptLength:"10",model:base.requestedModel,pairedBaselineId:base.id,context},"owner").id);
    assert.equal(changed.error.code,"PAIR_MISMATCH");assert.equal(f.calls.length,2);
  }finally{f.cleanup();}
});
test("explicit sandbox keeps editor context untouched, saves after output and rechecks themes under one lock",async()=>{
  const f=fixture({sample:{reference_transcript:"raw um words",critical_items:["words"]}});
  try{
    const context={systemPrompt:"Keep this rule.",agentName:"Test",purpose:"Test purpose",speechProfileTags:["Child"]};
    const base=await waitJob(f.jobs,f.jobs.start("baseline",{sampleId:"sample-01",context},"owner").id);
    const before=await waitJob(f.jobs,f.jobs.start("candidate",{sampleId:"sample-01",context,model:base.requestedModel,pairedBaselineId:base.id},"owner").id);
    const review=await waitJob(f.jobs,f.jobs.start("evaluation",{baselineId:base.id,context,model:base.requestedModel},"owner").id);
    const after=await waitJob(f.jobs,f.jobs.start("candidate",{sandboxEvaluationId:review.id,beforeRunId:before.id},"owner").id);
    assert.equal(after.status,"finished");assert.equal(after.sandbox.stage,"complete");
    assert.equal(after.sandbox.beforeRunId,before.id);assert.ok(after.sandbox.afterEvaluationId);
    assert.equal(f.calls.length,5);assert.equal(f.calls[3].settings.systemPrompt,review.suggestedPrompt);
    assert.equal(f.calls[4].settings.firstSpeakerSettings.agent!=null,true);
    assert.equal(context.systemPrompt,"Keep this rule.");assert.equal(after.performance.accessibilityScore,100);
    assert.equal(f.jobs.owned(after.sandbox.afterEvaluationId,"owner").reviewStage,"after");
    assert.equal(f.jobs.activeId,null);
  }finally{f.cleanup();}
});

test("real runner streams 1x PCM + two seconds silence, assembles output and saves safe results", async () => {
  const f = fixture();
  try {
    const accepted = f.jobs.start("baseline", { sampleId: "sample-01", model: "ultravox-v0.7", context: { agentName: "Edited name", purpose: "Edited purpose", speechProfileTags: ["Edited tag"], systemPrompt: "Edited draft" }, useCase: { label: "Forged label" } }, "owner");
    assert.equal(accepted.status, "preparing");
    const run = await waitJob(f.jobs, accepted.id);
    assert.equal(run.status, "finished");
    assert.equal(run.rawOutput, "raw, um... words");
    assert.equal(run.userInputTranscript, "Separate provider input");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].route, "/calls?enableGreetingPrompt=false");
    assert.equal(f.calls[0].settings.systemPrompt, "Transcribe the audio. Output only the transcript.");
    assert.equal(run.context.systemPrompt, "Edited draft");
    assert.equal(run.sampleMetadata.agentName, "Edited name");
    assert.equal(run.useCase.label, "Teen pre-visit intake");
    assert.ok(!JSON.stringify(f.calls[0].settings).includes("Teen pre-visit intake"));
    assert.equal(run.resolvedModel, "ultravox-v0.7");
    assert.equal(f.sockets[0].binary.length, 102);
    assert.ok(f.sockets[0].binary.at(-1).at - f.sockets[0].binary[0].at >= 1950);
    assert.ok(f.sockets[0].binary.slice(2).every(frame => frame.data.every(byte => byte === 0)));
    assert.equal(f.sockets[0].readyState, 3);
    const saved = fs.readFileSync(path.join(f.directory, `${run.id}.json`), "utf8");
    assert.ok(!saved.includes("wss://") && !saved.includes("joinUrl") && !saved.includes("test-only-not-real"));
    assert.equal(fs.statSync(path.join(f.directory, `${run.id}.json`)).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test("evaluator seed fallback uses the same input on the same call with only continuous silence", async () => {
  const f = fixture({ fallback: true });
  try {
    const baseline = await waitJob(f.jobs, f.jobs.start("baseline", { sampleId: "sample-01" }, "owner").id);
    const context = { agentName: "Test", purpose: "Help", speechProfileTags: ["Child"], systemPrompt: "  Exact draft\nNever diagnose.  " };
    const evaluation = await waitJob(f.jobs, f.jobs.start("evaluation", { baselineId: baseline.id, context }, "owner").id);
    assert.equal(evaluation.status, "finished");
    assert.equal(evaluation.parsedResult.summary, "Labelled test data review.");
    assert.equal(evaluation.context.systemPrompt, context.systemPrompt);
    assert.equal(f.calls.length, 2);
    const socket = f.sockets[1];
    assert.equal(socket.text.filter(message => message.type === "user_text_message").length, 1);
    assert.equal(socket.text.find(message => message.type === "user_text_message").text, evaluation.evaluatorInput);
    assert.equal(f.calls[1].settings.initialMessages[0].text, evaluation.evaluatorInput);
    assert.equal(evaluation.useCase.label, "Teen pre-visit intake");
    assert.ok(!JSON.stringify(f.calls[1].settings).includes("Teen pre-visit intake"));
    assert.ok(socket.binary.length > 100);
    assert.ok(socket.binary.every(frame => frame.data.every(byte => byte === 0)));
    assert.equal(socket.readyState, 3);
    assert.equal(evaluation.computedScores.overall, 98);
    assert.equal(evaluation.rubric_version, "1.1.0");
    assert.ok(evaluation.suggestedPrompt.startsWith(context.systemPrompt));
    assert.equal(evaluation.diff.filter(line => line.type !== "removed").map(line => line.text).join(""), evaluation.suggestedPrompt);
  } finally { f.cleanup(); }
});

test("an unavailable evaluator model falls back before the single call; requested/resolved model stay distinct", async () => {
  const f = fixture({ changeEvaluatorModel: true });
  try {
    const baseline = await waitJob(f.jobs, f.jobs.start("baseline", { sampleId:"sample-01",model:"ultravox-v0.7" }, "owner").id);
    const evaluation = await waitJob(f.jobs, f.jobs.start("evaluation", { baselineId:baseline.id,context:{systemPrompt:"Never diagnose."} }, "owner").id);
    assert.equal(evaluation.status,"finished");
    assert.equal(evaluation.requestedModel,"ultravox-v0.7");
    assert.equal(evaluation.resolvedModel,"ultravox-v0.6");
    assert.equal(f.calls.length,2);
    assert.equal(f.calls[1].settings.model,"ultravox-v0.6");
  } finally { f.cleanup(); }
});

test("empty and timed-out evaluator responses show no score and are never retried", async () => {
  for (const unfinished of [false,true]) {
    const f = fixture({ emptyEvaluation:!unfinished, unfinished, timeouts:{evaluationFinal:80} });
    try {
      const baseline = await waitJob(f.jobs, f.jobs.start("baseline", { sampleId:"sample-01" }, "owner").id);
      const evaluation = await waitJob(f.jobs, f.jobs.start("evaluation", { baselineId:baseline.id,context:{systemPrompt:"Never diagnose."} }, "owner").id);
      assert.equal(evaluation.error.code,unfinished?"TIMEOUT":"EMPTY_RESPONSE");
      assert.equal(evaluation.computedScores,null);
      assert.equal(f.calls.length,2);
    } finally { f.cleanup(); }
  }
});

test("no overlapping jobs; stopping an active socket preserves labelled partial text and closes it", async () => {
  const f = fixture();
  try {
    const start = f.jobs.start("baseline", { sampleId: "sample-01" }, "owner");
    assert.throws(() => f.jobs.start("baseline", { sampleId: "sample-01" }, "owner"), error => error.code === "RUN_ACTIVE");
    await waitJob(f.jobs, start.id, "streaming");
    f.jobs.stop(start.id, "owner");
    const run = await waitJob(f.jobs, start.id);
    assert.equal(run.status, "cancelled");
    assert.equal(run.outputPartial, true);
    assert.equal(run.error.code, "CANCELLED");
    assert.equal(f.sockets[0].readyState, 3);
    assert.equal(f.calls.length, 1);
  } finally { f.cleanup(); }
});

test("empty response has a bounded explicit failure and never retries", async () => {
  const f = fixture({ empty: true });
  try {
    const run = await waitJob(f.jobs, f.jobs.start("baseline", { sampleId: "sample-01" }, "owner").id);
    assert.equal(run.status, "failed");
    assert.equal(run.error.code, "EMPTY_RESPONSE");
    assert.equal(f.calls.length, 1);
    assert.equal(f.sockets[0].readyState, 3);
  } finally { f.cleanup(); }
});

test("unfinished model text is partial on timeout, never a successful baseline", async () => {
  const f = fixture({ unfinished: true });
  try {
    const run = await waitJob(f.jobs, f.jobs.start("baseline", { sampleId: "sample-01" }, "owner").id);
    assert.equal(run.status, "partial");
    assert.equal(run.outputPartial, true);
    assert.equal(run.rawOutput, "raw, um... words");
    assert.equal(run.error.code, "TIMEOUT");
    assert.equal(f.calls.length, 1);
  } finally { f.cleanup(); }
});

test("network loss and unavailable models give specific failures without retries", async () => {
  const f = fixture({ disconnect: true });
  try {
    const lost = await waitJob(f.jobs, f.jobs.start("baseline", { sampleId: "sample-01" }, "owner").id);
    assert.equal(lost.error.code, "NETWORK_FAILURE");
    const unavailable = await waitJob(f.jobs, f.jobs.start("baseline", { sampleId: "sample-01", model: "unavailable" }, "owner").id);
    assert.equal(unavailable.error.code, "MODEL_UNAVAILABLE");
    assert.equal(f.calls.length, 1);
  } finally { f.cleanup(); }
});
