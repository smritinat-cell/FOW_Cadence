const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { JobError, BASELINE_PROMPT, preferredModel } = require("./ultravox");
const { LiveAuth } = require("./live-auth");
const { createLiveStore } = require("./live-store");
const { createLiveProvider } = require("./live-provider");
const { getRecordingComparisonProfile, prepareRecordingMetricInputs, prepareRecordingRunInputs } = require("./recording-comparison");
const { sameAudio, performance } = require("./performance");
const preset = require("../config/transcript-improvement.json");
const COMPLETE = record => record?.status === "finished" && !record.outputPartial && !record.error && Boolean(record.rawOutput?.trim());
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class LivePilot {
  constructor(jobs, resolveSample, { store = createLiveStore(), provider = createLiveProvider(), auth = new LiveAuth(), importFile = process.env.CADENCE_LIVE_PREPARED_FILE || require("node:path").join(__dirname, "..", "config", "live-prepared-history.json") } = {}) {
    this.jobs = jobs; this.resolveSample = resolveSample; this.store = store; this.provider = provider; this.auth = auth;
    this.references = new Map(); this.profiles = new Map(); this.packs = new Map(); this.preparations = new Map();
    this.models = []; this.storageError = null;
    jobs.liveStore = store; jobs.liveServices = provider;
    jobs.liveProfile = id => {
      const profile = this.profiles.get(String(id));
      if (!profile) throw new JobError("INVALID_RECORDING", "Choose an available recording before starting a live run.", 409);
      return profile;
    };
    this.ready = this.initialize(importFile).catch(() => { this.storageError = "STORAGE_FAILURE"; });
  }
  async initialize(importFile) {
    if (!this.store) return;
    await this.store.init();
    for (const record of await this.store.records()) {
      if (record.workflow !== "recording-comparison" || !record.id || !record.ownerHash) continue;
      if (!["finished", "partial", "failed", "cancelled"].includes(record.status)) {
        record.status = "cancelled"; record.endedAt = new Date().toISOString(); record.outputPartial = Boolean(record.rawOutput);
        record.error = { code: "SERVER_RESTARTED", message: "This run was interrupted. Start a new run when ready." };
        await this.store.save(record);
      }
      this.jobs.records.set(record.id, record);
    }
    for (const reference of await this.store.references()) this.references.set(reference.sampleId, reference);
    for (const pack of await this.store.packs()) if (this.validPack(pack)) this.packs.set(pack.id, pack);
    if (importFile) {
      let data;
      try { data = JSON.parse(await fs.readFile(importFile, "utf8")); }
      catch (error) { if (error.code === "ENOENT") data = { pairs: [] }; else throw error; }
      for (const pack of data.pairs || []) {
        if (!this.validPack(pack)) throw new Error("Imported live pair is not a complete, matching server artifact.");
        // Import only immutable server-side artifacts, never client-supplied outputs.
        for (const record of [pack.before, pack.after, pack.review].filter(Boolean)) delete record.demoPerformance;
        await this.store.savePack(pack); this.packs.set(pack.id, pack);
      }
    }
    for (const id of ["sample-01", "sample-02", "sample-03"]) {
      try { await this.profile(id); } catch { /* Unavailable or changed audio cannot be run. */ }
    }
    this.models = [...new Set([...this.packs.values()].map(pack => pack.before.requestedModel).filter(Boolean))].map(id => ({ id }));
  }
  require(req, owner) { this.auth.require(req, owner); }
  async ensureStore() { await this.ready; if (!this.store || this.storageError) throw new JobError("STORAGE_FAILURE", "Configure durable live storage before continuing.", 503); }
  async profile(id) {
    const sampleInfo = this.resolveSample(String(id));
    if (!sampleInfo?.file) throw new JobError("DECODE_FAILURE", "The recording is not available on the live server.", 409);
    const draft = getRecordingComparisonProfile(id);
    const reference = this.references.get(String(id));
    const profile = reference ? { ...draft, excerpt: reference.excerpt, reference: reference.reference, reference_transcript: reference.referenceTranscript, critical_items: reference.criticalItems } : draft;
    const source = await this.jobs.services.fileHash(sampleInfo.file);
    if (!profile.reference.excerptPcmSha256) {
      const pcm = await this.jobs.services.decodeExcerpt(sampleInfo.file, profile.excerpt.startOffset, 15, new AbortController().signal);
      profile.reference.excerptPcmSha256 = hash(pcm);
    }
    const metricInputSnapshot = prepareRecordingRunInputs(profile, source);
    const ready = { ...profile, metricInputSnapshot };
    this.profiles.set(String(id), ready);
    return ready;
  }
  async readReference(id) {
    await this.ensureStore();
    const saved = this.references.get(String(id));
    if (saved) return structuredClone(saved);
    const draft = getRecordingComparisonProfile(id);
    return { sampleId: draft.sampleId, referenceTranscript: draft.reference_transcript, criticalItems: draft.critical_items, excerpt: draft.excerpt, verified: false, reference: draft.reference, sourceAudioSha256: draft.reference.sourceAudioSha256 };
  }
  async saveReference(input, owner) {
    await this.ensureStore();
    if (this.jobs.activeId || this.preparations.size) throw new JobError("RUN_ACTIVE", "Stop the active run before changing the reference.", 409);
    const draft = getRecordingComparisonProfile(input.sampleId);
    if (Number(input.startOffset) !== draft.excerpt.startOffset || Number(input.excerptLength) !== 15 || input.verified !== true) throw new JobError("REFERENCE_UNVERIFIED", "Confirm an audio-checked reference for the fixed 15-second excerpt.", 400);
    if (typeof input.referenceTranscript !== "string" || !input.referenceTranscript.trim() || input.referenceTranscript.length > 10000 || !Array.isArray(input.criticalItems) || input.criticalItems.length < 1 || input.criticalItems.length > 20) throw new JobError("INVALID_CONTEXT", "Add a reference transcript and its key details.", 400);
    const criticalItems = input.criticalItems.map((item, index) => {
      if (!item || typeof item.label !== "string" || !item.label.trim() || item.label.length > 200 || !Array.isArray(item.phrases) || !item.phrases.length || item.phrases.length > 10 || item.phrases.some(value => typeof value !== "string" || !value.trim() || value.length > 200)) throw new JobError("INVALID_CONTEXT", "Each key detail needs a label and supported phrases.", 400);
      return { id: `item-${index + 1}`, label: item.label.trim(), phrases: item.phrases.map(value => value.trim()) };
    });
    const sampleInfo = this.resolveSample(draft.sampleId);
    if (!sampleInfo?.file) throw new JobError("DECODE_FAILURE", "The recording is unavailable.", 409);
    const sourceAudioSha256 = await this.jobs.services.fileHash(sampleInfo.file);
    if (sourceAudioSha256 !== draft.reference.sourceAudioSha256) throw new JobError("AUDIO_MISMATCH", "The audio differs from the curated recording.", 409);
    const pcm = await this.jobs.services.decodeExcerpt(sampleInfo.file, draft.excerpt.startOffset, 15, new AbortController().signal);
    const reference = { ...draft.reference, verified: true, verifiedBy: "presenter-audio-review", verifiedAt: new Date().toISOString(), status: "presenter-verified", sourceAudioSha256, excerptPcmSha256: hash(pcm) };
    const saved = { sampleId: draft.sampleId, referenceTranscript: input.referenceTranscript, criticalItems, excerpt: draft.excerpt, verified: true, reference, sourceAudioSha256, assertedByOwnerHash: owner };
    const candidate = { ...draft, reference, reference_transcript: saved.referenceTranscript, critical_items: saved.criticalItems };
    const metricInputSnapshot = prepareRecordingMetricInputs(candidate, sourceAudioSha256);
    await this.store.saveReference(saved); this.references.set(saved.sampleId, saved);
    this.profiles.set(saved.sampleId, { ...candidate, metricInputSnapshot });
    return { ...saved, assertedByOwnerHash: undefined, ready: true };
  }
  async status(req, owner) {
    await this.ready;
    const authorized = this.auth.authorized(req, owner);
    const configured = Boolean(this.store && !this.storageError && this.auth.configured());
    const budget = configured ? await this.store.budget() : { limitSeconds: 1440, reservedSeconds: 0, remainingSeconds: 0, disabledReason: "STORAGE_FAILURE" };
    const clips = ["sample-01", "sample-02", "sample-03"].map(sampleId => {
      const draft = getRecordingComparisonProfile(sampleId), profile = this.profiles.get(sampleId);
      const source = this.resolveSample(sampleId)?.sample;
      const packs = [...this.packs.values()].filter(pack => this.compatible(pack, sampleId));
      return { sampleId, title: draft.title, label: draft.useCase.label, filename: draft.filename, audioSrc: source?.audio_url || `/api/demo-samples/${sampleId}/audio`, excerpt: draft.excerpt, context: draft.context, useCase: draft.useCase, referenceVerified: profile?.reference.verified === true, available: Boolean(profile), ready: packs.length > 0, id: packs[0]?.id, model: packs[0]?.before.requestedModel || "", reason: profile ? packs.length ? null : "NOT_PREPARED" : "AUDIO_UNAVAILABLE" };
    });
    return { authorized, configured, canRun: authorized && configured && this.provider.hasKey() && !budget.disabledReason && budget.remainingSeconds >= 50, prepared: clips, clips, promptPreset: preset, running: authorized ? this.active(owner) : null, models: authorized ? this.models : [], preferred: preferredModel(this.models), budget: authorized ? budget : undefined };
  }
  active(owner) {
    const preparation = [...this.preparations.values()].find(item => item.owner === owner);
    if (preparation) return this.jobs.public(this.jobs.owned(preparation.id, owner));
    const record = this.jobs.activeId && this.jobs.records.get(this.jobs.activeId);
    return record?.ownerHash === owner && record.workflow === "recording-comparison" ? this.jobs.public(record) : null;
  }
  validPack(pack) {
    if (!(typeof pack?.id === "string" && typeof pack.createdAt === "string" && COMPLETE(pack.before) && COMPLETE(pack.after) && sameAudio(pack.before, pack.after) && pack.before.promptUsed === BASELINE_PROMPT && pack.after.promptUsed === preset.prompt && pack.before.requestedModel === pack.after.requestedModel && pack.before.resolvedModel === pack.after.resolvedModel && (!pack.review || COMPLETE(pack.review)))) return false;
    const common = settings => { if (!settings) return null; const { systemPrompt, ...rest } = settings; return JSON.stringify(rest); };
    if (!common(pack.before.settings) || common(pack.before.settings) !== common(pack.after.settings)) return false;
    const left = pack.before.metricInputSnapshot, right = pack.after.metricInputSnapshot;
    if (left || right) {
      if (!left || !right || ["version", "referenceHash", "criticalItemsHash", "referencePolicyHash"].some(field => left[field] !== right[field])) return false;
    }
    for (const record of [pack.before, pack.after]) {
      if (record.performance) {
        if (record.performance.demo || !record.metricInputSnapshot || !Array.isArray(record.metricInputSnapshot.criticalItems)) return false;
        const measured = performance(record.rawOutput, record.metricInputSnapshot);
        if (["accessibilityScore", "wordAccuracy", "keyItemsCaptured", "keyItemsTotal", "keyItemsPercent", "referenceHash", "criticalItemsHash", "referencePolicyHash", "version"].some(field => record.performance[field] !== measured[field])) return false;
      }
    }
    return true;
  }
  compatible(pack, sampleId, model) {
    if (!this.validPack(pack) || sampleId && pack.before.sampleId !== sampleId || model && pack.before.requestedModel !== model) return false;
    const profile = this.profiles.get(pack.before.sampleId);
    return Boolean(profile && pack.before.excerpt.startOffset === profile.excerpt.startOffset && pack.before.excerpt.length === 15 && ["referenceHash", "criticalItemsHash", "referencePolicyHash"].every(field => pack.before.metricInputSnapshot?.[field] === profile.metricInputSnapshot[field]) && pack.before.audioHashes.sourceSha256 === profile.reference.sourceAudioSha256 && pack.before.audioHashes.excerptPcmSha256 === profile.reference.excerptPcmSha256);
  }
  ownedPairs(owner) {
    return [...this.jobs.records.values()].filter(after => after.ownerHash === owner && after.workflow === "recording-comparison" && COMPLETE(after) && after.sandbox?.beforeRunId).map(after => ({ id: after.id, before: this.jobs.records.get(after.sandbox.beforeRunId), after, review: this.jobs.records.get(after.sandbox.sourceEvaluationId), prepared: false, createdAt: after.createdAt })).filter(pack => this.validPack(pack));
  }
  async history(owner, sampleId, model) {
    await this.ensureStore();
    const compatible = [...this.packs.values(), ...this.ownedPairs(owner)].filter(pack => this.compatible(pack, sampleId, model));
    const historical = [...this.packs.values()].filter(pack => !this.compatible(pack, sampleId, model) && (!sampleId || pack.before.sampleId === sampleId));
    const publicPack = pack => ({ id: pack.id, before: this.jobs.public(pack.before), after: this.jobs.public(pack.after), review: pack.review ? this.jobs.public(pack.review) : null, prepared: Boolean(pack.prepared), comparable: true, createdAt: pack.createdAt, historical: !this.compatible(pack, sampleId, model) });
    return { runs: compatible.map(publicPack).sort((a,b) => b.createdAt.localeCompare(a.createdAt)), historicalRuns: historical.map(publicPack), activeRun: this.active(owner) };
  }
  async adopt(id, owner) {
    await this.ensureStore();
    const pack = this.packs.get(id) || this.ownedPairs(owner).find(item => item.id === id);
    if (!this.validPack(pack)) throw new JobError("NOT_FOUND", "Choose a completed previous run.", 404);
    if (!this.packs.has(id)) return { pairId: id, before: this.jobs.public(pack.before), after: this.jobs.public(pack.after), review: pack.review ? this.jobs.public(pack.review) : null };
    const existing = [...this.jobs.records.values()].find(record => record.ownerHash === owner && record.adoptedPackId === id && record.kind === "candidate");
    if (existing) return { pairId: existing.id, before: this.jobs.public(this.jobs.owned(existing.sandbox.beforeRunId, owner)), after: this.jobs.public(existing), review: existing.sandbox.sourceEvaluationId ? this.jobs.public(this.jobs.owned(existing.sandbox.sourceEvaluationId, owner)) : null };
    const mapping = new Map([pack.before, pack.after, pack.review].filter(Boolean).map(record => [record.id, crypto.randomUUID()]));
    const copy = original => {
      if (!original) return null;
      const record = structuredClone(original);
      record.id = mapping.get(original.id); record.ownerHash = owner; record.workflow = "recording-comparison"; record.adoptedPackId = id; record.provenance = { type: "prepared-ultravox-run", originalRunId: original.id, preparedAt: pack.createdAt };
      if (record.baselineId) record.baselineId = mapping.get(record.baselineId);
      if (record.pairedBaselineId) record.pairedBaselineId = mapping.get(record.pairedBaselineId);
      if (record.sandbox) for (const field of ["beforeRunId", "sourceEvaluationId", "afterEvaluationId"]) if (record.sandbox[field]) record.sandbox[field] = mapping.get(record.sandbox[field]);
      return record;
    };
    const before = copy(pack.before), review = copy(pack.review), after = copy(pack.after);
    after.sandbox = { ...(after.sandbox || {}), beforeRunId: before.id, sourceEvaluationId: review?.id || null, promptPreset: preset.id, originalPrompt: before.promptUsed, proposedPrompt: after.promptUsed, stage: "complete" };
    after.pairedBaselineId = before.id;
    if (review) review.baselineId = before.id;
    await this.store.saveMany([before, review, after].filter(Boolean));
    for (const record of [before, review, after].filter(Boolean)) this.jobs.records.set(record.id, record);
    return { pairId: after.id, before: this.jobs.public(before), after: this.jobs.public(after), review: review ? this.jobs.public(review) : null };
  }
  async start(input, owner) {
    await this.ensureStore();
    if (this.preparations.size) throw new JobError("RUN_ACTIVE", "Preparation is still running.", 409);
    const review = input.sandboxEvaluationId ? this.jobs.owned(String(input.sandboxEvaluationId), owner) : null;
    const before = this.jobs.owned(String(input.beforeRunId || ""), owner);
    const profile = await this.profile(before.sampleId);
    if (before.workflow !== "recording-comparison" || before.kind !== "baseline" || !COMPLETE(before) || review && (!COMPLETE(review) || review.baselineId !== before.id) || ["referenceHash", "criticalItemsHash", "referencePolicyHash"].some(field => before.metricInputSnapshot?.[field] !== profile.metricInputSnapshot[field]) || before.excerpt.startOffset !== profile.excerpt.startOffset || before.excerpt.length !== 15 || before.audioHashes?.sourceSha256 !== profile.reference.sourceAudioSha256 || before.audioHashes?.excerptPcmSha256 !== profile.reference.excerptPcmSha256) throw new JobError("PAIR_MISMATCH", "Run the baseline for the current recording before testing improvements.", 409);
    return this.jobs.start("candidate", { ...input, workflow: "recording-comparison", mode: "candidate", promptPreset: preset.id }, owner);
  }
  async baseline(input, owner) {
    await this.ensureStore(); this.provider.requireKey();
    if (this.jobs.activeId || this.preparations.size) throw new JobError("RUN_ACTIVE", "A run is still active.", 409);
    const profile = await this.profile(input.sampleId);
    const budget = await this.store.budget();
    if (budget.disabledReason || budget.remainingSeconds < 50) throw new JobError("LIVE_BUDGET", "The live demo has reached its reserved-minute limit.", 429);
    return this.jobs.start("baseline", { ...input, workflow: "recording-comparison", sampleId: profile.sampleId }, owner);
  }
  async prepare(input, owner) {
    await this.ensureStore(); this.provider.requireKey();
    if (this.jobs.activeId || this.preparations.size) throw new JobError("RUN_ACTIVE", "A run is still active.", 409);
    const profile = await this.profile(input.sampleId);
    this.models = await this.provider.getModels(undefined, true);
    const model = input.model || preferredModel(this.models);
    if (!this.models.some(item => item.id === model)) throw new JobError("MODEL_UNAVAILABLE", "Choose an available model.", 409);
    const budget = await this.store.budget();
    if (budget.disabledReason || budget.remainingSeconds < 165) throw new JobError("LIVE_BUDGET", "The pilot has insufficient reserved minutes for preparation.", 429);
    const id = crypto.randomUUID(), controller = new AbortController();
    const record = { id, ownerHash: owner, workflow: "recording-comparison", kind: "preparation", sampleId: profile.sampleId, createdAt: new Date().toISOString(), status: "preparing", stage: "baseline", rawOutput: "", progress: { percent: 0 }, error: null };
    await this.store.save(record); this.jobs.records.set(id, record); this.jobs.runtime.set(id, { controller });
    this.preparations.set(id, { id, owner, controller, childId: null });
    this.executePreparation(record, profile, model, controller).catch(() => {});
    return { job: this.jobs.public(record), preparationId: id };
  }
  async executePreparation(record, profile, model, controller) {
    const state = this.preparations.get(record.id);
    const run = async (kind, input) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const child = this.jobs.start(kind, { ...input, workflow: "recording-comparison", model, livePreparationId: record.id }, record.ownerHash);
      state.childId = child.id;
      const abort = () => this.jobs.stop(child.id, record.ownerHash);
      controller.signal.addEventListener("abort", abort, { once: true });
      try { while (this.jobs.runtime.has(child.id)) await delay(50); }
      finally { controller.signal.removeEventListener("abort", abort); }
      const result = this.jobs.owned(child.id, record.ownerHash);
      if (!COMPLETE(result) || kind === "evaluation" && !result.parsedResult) throw new JobError(result.error?.code || "SANDBOX_FAILED", "Preparation did not produce a complete result.", 422);
      return result;
    };
    try {
      const before = await run("baseline", { sampleId: profile.sampleId, context: profile.context, startOffset: profile.excerpt.startOffset, excerptLength: "15" });
      record.stage = "review"; record.progress.percent = 33; await this.store.save(record);
      const review = await run("evaluation", { baselineId: before.id, context: profile.context });
      record.stage = "improved"; record.progress.percent = 66; await this.store.save(record);
      const after = await run("candidate", { sandboxEvaluationId: review.id, beforeRunId: before.id, currentPrompt: BASELINE_PROMPT, promptPreset: preset.id });
      const pack = { id: `pack:${crypto.randomUUID()}`, before: structuredClone(before), after: structuredClone(after), review: structuredClone(review), prepared: true, createdAt: new Date().toISOString() };
      if (!this.validPack(pack)) throw new JobError("PAIR_MISMATCH", "Prepared runs do not match.", 409);
      await this.store.savePack(pack); this.packs.set(pack.id, pack);
      record.status = "finished"; record.stage = "complete"; record.packId = pack.id; record.progress.percent = 100;
    } catch (error) { record.status = controller.signal.aborted ? "cancelled" : "failed"; record.error = { code: error.code || "STORAGE_FAILURE", message: error instanceof JobError ? error.message : "Preparation could not be saved." }; }
    finally { record.endedAt = new Date().toISOString(); record.elapsedMs = Date.now() - Date.parse(record.createdAt); await this.store.save(record).catch(() => {}); this.preparations.delete(record.id); this.jobs.runtime.delete(record.id); }
  }
}

module.exports = { LivePilot, COMPLETE };
