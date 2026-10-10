// Synthetic runner fixtures only. No provider request or real credential is used.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { FileLiveStore } = require("../lib/live-store");
const { LiveAuth } = require("../lib/live-auth");
const { Jobs } = require("../lib/jobs");
const { LivePilot } = require("../lib/live-pilot");
const { getRecordingComparisonProfile } = require("../lib/recording-comparison");
const preset = require("../config/transcript-improvement.json");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("presenter session is owner-bound, signed, expiring and rate limited", () => {
  let now = 1000000;
  const auth = new LiveAuth({ code: "test-presenter-code", secret: "test-signing-secret".repeat(3), now: () => now });
  let cookies;
  const response = { getHeader: () => undefined, setHeader: (name, value) => { cookies = value; } };
  auth.unlock({ headers: {} }, response, "owner-one", "test-presenter-code");
  const cookie = cookies[0].split(";")[0];
  assert.match(cookies[0], /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(auth.authorized({ headers: { cookie } }, "owner-one"), true);
  assert.equal(auth.authorized({ headers: { cookie } }, "owner-two"), false);
  assert.equal(auth.authorized({ headers: { cookie: cookie.replace(/.$/, "0") } }, "owner-one"), false);
  now += 8 * 60 * 60 * 1000 + 1;
  assert.equal(auth.authorized({ headers: { cookie } }, "owner-one"), false);
  for (let index = 0; index < 5; index++) assert.throws(() => auth.unlock({ headers: {} }, response, "owner-two", "wrong"), error => error.code === "LIVE_AUTH_REQUIRED");
  assert.throws(() => auth.unlock({ headers: {} }, response, "owner-two", "test-presenter-code"), error => error.code === "LIVE_AUTH_LIMIT");
});

test("global conservative reservations are atomic, idempotent and survive reopening", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cadence-live-budget-test-"));
  try {
    const store = new FileLiveStore(path.join(directory, "state.json")); await store.init();
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => store.reserve(`call-${index}`, 100)));
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 14);
    assert.equal((await store.budget()).reservedSeconds, 1400);
    await store.reserve("call-0", 100); assert.equal((await store.budget()).reservedSeconds, 1400);
    await assert.rejects(store.reserve("invalid-reservation", Number.NaN), error => error.code === "LIVE_BUDGET");
    const reopened = new FileLiveStore(path.join(directory, "state.json")); await reopened.init();
    assert.equal((await reopened.budget()).remainingSeconds, 40);
    await reopened.save({ id: "past", workflow: "recording-comparison", status: "finished" });
    await reopened.disable("INVALID_KEY");
    await assert.rejects(reopened.reserve("fresh", 1), error => error.code === "LIVE_BUDGET");
    assert.equal((await reopened.records()).length, 1);
    await fs.writeFile(path.join(directory, "corrupt.json"), JSON.stringify({ records: {}, packs: {}, reservations: { hidden: 100 }, reserved: 0 }));
    await assert.rejects(new FileLiveStore(path.join(directory, "corrupt.json")).init(), /validation failed/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cadence-live-runner-test-"));
  const store = new FileLiveStore(path.join(directory, "state.json")); await store.init();
  const draft = getRecordingComparisonProfile("sample-01");
  const pcm = Buffer.alloc(15 * 32000, 1), sourceHash = draft.reference.sourceAudioSha256;
  const reference = { ...draft.reference, verified: true, verifiedBy: "synthetic-test", verifiedAt: "2026-01-01T00:00:00.000Z", excerptPcmSha256: crypto.createHash("sha256").update(pcm).digest("hex") };
  await store.saveReference({ sampleId: draft.sampleId, referenceTranscript: "raw words", criticalItems: [{ label: "Words", phrases: ["words"] }], excerpt: draft.excerpt, verified: true, sourceAudioSha256: sourceHash, reference });
  const calls = [];
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.bufferedAmount = 0; this.answered = false; queueMicrotask(() => { this.readyState = 1; this.emit("open"); if (calls.at(-1).kind === "evaluation") this.answer(); }); }
    answer() {
      if (this.answered) return; this.answered = true;
      const call = calls.at(-1);
      const text = call.kind === "evaluation" ? JSON.stringify({ summary: "Synthetic transcription review.", parameters: [{ id: "transcription.repetitions", theme: "speech_patterns", observed: true, status: "issue" }], findings: [{ id: "repeat", parameter_id: "transcription.repetitions", title: "Repetition", quote: "um", why_it_matters: "The wording contains hesitation.", severity: "low", confidence: "high", prompt_coverage: "none", coverage_quote: "" }], prompt_edits: [] }) : call.prompt === preset.prompt ? "raw words" : "raw um words";
      this.emit("message", Buffer.from(JSON.stringify({ type: "transcript", role: "agent", ordinal: 1, text, final: true })), false);
      this.emit("message", Buffer.from(JSON.stringify({ type: "state", state: "listening" })), false);
    }
    send(data) { if (Buffer.isBuffer(data)) this.answer(); }
    close() { this.readyState = 3; queueMicrotask(() => this.emit("close")); }
    terminate() { this.close(); }
  }
  const resolve = id => id === "sample-01" ? { file: "synthetic.wav", sample: { id, duration_seconds: 140, prototype_audio_file: "synthetic.wav", use_case_label: "Teen pre-visit intake" } } : null;
  const jobs = new Jobs(resolve, { directory: path.join(directory, "native"), services: { decodeExcerpt: async () => pcm, fileHash: async () => sourceHash, sleep: async () => {}, createSocket: () => new Socket(), providerRequest: async () => { throw new Error("Native provider must never be called."); } } });
  const provider = { hasKey: () => true, requireKey: () => {}, getModels: async () => [{ id: "synthetic-model" }], providerRequest: async (route, request) => { calls.push({ kind: request.body.firstSpeakerSettings.agent ? "evaluation" : "audio", prompt: request.body.systemPrompt }); return { callId: `test-${calls.length}`, model: "synthetic-model", joinUrl: "wss://synthetic.invalid" }; } };
  const auth = new LiveAuth({ code: "test-presenter-code", secret: "synthetic-signing-secret".repeat(3), local: true });
  const pilot = new LivePilot(jobs, resolve, { store, provider, auth, importFile: null }); await pilot.ready;
  return { directory, store, draft, jobs, pilot, calls, async cleanup() { jobs.shutdown(); await fs.rm(directory, { recursive: true, force: true }); } };
}

async function wait(jobs, id) {
  const start = Date.now();
  while (jobs.runtime.has(id) && Date.now() - start < 10000) await pause(10);
  assert.equal(jobs.runtime.has(id), false, "synthetic job must complete within its bound");
  return jobs.records.get(id);
}

test("preparation makes three explicit isolated calls, adoption makes none, fresh test only one audio call", async () => {
  const f = await fixture();
  try {
    const prepared = await f.pilot.prepare({ sampleId: "sample-01", model: "synthetic-model" }, "owner");
    const preparation = await wait(f.jobs, prepared.preparationId);
    assert.equal(preparation.status, "finished", JSON.stringify(preparation.error));
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls.map(call => call.kind), ["audio", "evaluation", "audio"]);
    assert.equal((await f.store.budget()).reservedSeconds, 165);
    const history = await f.pilot.history("other-owner", "sample-01", "synthetic-model");
    assert.equal(history.runs.length, 1);
    const adopted = await f.pilot.adopt(history.runs[0].id, "other-owner");
    assert.equal(f.calls.length, 3);
    assert.notEqual(adopted.before.id, history.runs[0].before.id);
    assert.equal(adopted.review.baselineId, adopted.before.id);
    assert.equal(adopted.after.sandbox.beforeRunId, adopted.before.id);
    assert.equal((await f.pilot.adopt(history.runs[0].id, "other-owner")).pairId, adopted.pairId);
    assert.throws(() => f.jobs.owned(adopted.before.id, "owner"), error => error.code === "NOT_FOUND");
    const started = await f.pilot.start({ sandboxEvaluationId: adopted.review.id, beforeRunId: adopted.before.id, currentPrompt: adopted.before.promptUsed }, "other-owner");
    const after = await wait(f.jobs, started.id);
    assert.equal(after.status, "finished"); assert.equal(f.calls.length, 4);
    assert.equal(after.promptUsed, preset.prompt); assert.equal(after.sandbox.afterEvaluationId, undefined);
    assert.equal(after.performance.accessibilityScore, 100);
    assert.equal((await f.store.budget()).reservedSeconds, 215);
    assert.equal((await f.pilot.history("other-owner", "sample-01", "synthetic-model")).runs.length, 3);
  } finally { await f.cleanup(); }
});

test("invalid reference update preserves the previous verified reference and blocks stale scoring", async () => {
  const f = await fixture();
  try {
    const prior = await f.pilot.readReference("sample-01");
    await assert.rejects(f.pilot.saveReference({ sampleId: "sample-01", startOffset: 0, excerptLength: 15, verified: true, referenceTranscript: "raw words", criticalItems: [{ label: "Unsupported", phrases: ["absent phrase"] }] }, "owner"), error => error.code === "REFERENCE_KEY_ITEMS_INVALID");
    assert.deepEqual(await f.pilot.readReference("sample-01"), prior);
    assert.equal(f.pilot.profiles.get("sample-01").reference_transcript, "raw words");
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test("direct baseline and preset candidate need two calls, with unverified references excluded from scoring", async () => {
  const f = await fixture();
  try {
    f.pilot.references.delete("sample-01"); f.pilot.profiles.delete("sample-01");
    await assert.rejects(f.pilot.baseline({ sampleId: "sample-01", model: "synthetic-model", excerptLength: 30 }, "owner"), error => error.code === "INVALID_EXCERPT");
    assert.equal(f.calls.length, 0);
    const start = await f.pilot.baseline({ sampleId: "sample-01", model: "synthetic-model" }, "owner");
    const before = await wait(f.jobs, start.id);
    assert.equal(before.status, "finished"); assert.equal(f.calls.length, 1);
    assert.equal(before.recording.fileName, "M_0061_14y8m_1.wav");
    assert.equal(before.metricInputSnapshot.referenceTranscript, "");
    assert.equal(before.performance.accessibilityScore, null);
    const testRun = await f.pilot.start({ beforeRunId: before.id, currentPrompt: before.promptUsed }, "owner");
    const after = await wait(f.jobs, testRun.id);
    assert.equal(after.status, "finished"); assert.equal(f.calls.length, 2);
    assert.equal(after.promptUsed, preset.prompt);
    assert.equal(after.recording.fileName, before.recording.fileName);
    assert.equal(after.sandbox.sourceEvaluationId, null);
    assert.equal(after.sandbox.afterEvaluationId, undefined);
    assert.equal(after.performance.accessibilityScore, null);
    assert.equal((await f.store.budget()).reservedSeconds, 100);
    assert.equal((await f.pilot.history("owner", "sample-01", "synthetic-model")).runs.length, 1);
  } finally { await f.cleanup(); }
});

test("stop acknowledgement keeps cleanup pending and cancelled output is excluded from previous pairs", async () => {
  const f = await fixture();
  try {
    const prepared = await f.pilot.prepare({ sampleId: "sample-01", model: "synthetic-model" }, "owner");
    await wait(f.jobs, prepared.preparationId);
    const history = await f.pilot.history("owner", "sample-01", "synthetic-model");
    const adopted = await f.pilot.adopt(history.runs[0].id, "owner");
    const priorCount = (await f.pilot.history("owner", "sample-01", "synthetic-model")).runs.length;
    const started = await f.pilot.start({ sandboxEvaluationId: adopted.review.id, beforeRunId: adopted.before.id, currentPrompt: adopted.before.promptUsed }, "owner");
    while (f.calls.length < 4) await pause(5);
    const acknowledged = f.jobs.stop(started.id, "owner");
    assert.equal(acknowledged.stopping, true); assert.equal(acknowledged.cleanupComplete, false);
    const cancelled = await wait(f.jobs, started.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(f.jobs.public(cancelled).cleanupComplete, true);
    assert.equal((await f.pilot.history("owner", "sample-01", "synthetic-model")).runs.some(pair => pair.after.id === started.id), false);
    assert.equal((await f.store.budget()).reservedSeconds, 215);
    f.pilot.provider.hasKey = () => false;
    f.pilot.provider.requireKey = () => { throw new Error("Missing key"); };
    assert.equal((await f.pilot.history("owner", "sample-01", "synthetic-model")).runs.length, priorCount);
    assert.equal((await f.pilot.adopt(history.runs[0].id, "owner")).pairId, adopted.pairId);
    const tampered = structuredClone([...f.pilot.packs.values()][0]);
    tampered.after.metricInputSnapshot.referenceHash = "wrong-reference";
    assert.equal(f.pilot.validPack(tampered), false);
  } finally { await f.cleanup(); }
});

test("hackathon mode needs no additional presenter credentials or database", () => {
  const { pilotKey } = require("../lib/live-provider");
  const { createLiveStore } = require("../lib/live-store");
  const auth = new LiveAuth({ code: "", secret: "" });
  assert.equal(auth.authorized({ headers: {} }, "owner"), true);
  assert.equal(auth.unlock({ headers: {} }, {}, "owner", "").authorized, true);
  assert.equal(pilotKey({ ULTRAVOX_API_KEY: "synthetic-user-runtime-key" }), "synthetic-user-runtime-key");
  assert.ok(createLiveStore({}) instanceof FileLiveStore);
});

test("published Vercel requests remain valid behind a Replit proxy while unrelated origins are rejected", async () => {
  const { Readable } = require("node:stream");
  const { createApi } = require("../lib/api");
  let starts = 0, result;
  const live = { require() {}, async baseline() { starts++; return { id: "synthetic-live-job" }; } };
  const api = createApi(() => null, (_, status, data) => { result = { status, data }; }, { jobs: {}, live });
  const request = async origin => {
    const req = Readable.from([JSON.stringify({ sampleId: "sample-01", model: "synthetic-model" })]);
    req.method = "POST"; req.headers = { host: "synthetic.replit.dev", origin, "content-type": "application/json" };
    await api.handle(req, { setHeader() {} }, new URL("http://synthetic.replit.dev/api/live/baseline"));
    return result;
  };
  assert.equal((await request("https://fow-cadence.vercel.app")).status, 202);
  assert.equal(starts, 1);
  assert.equal((await request("https://unrelated.invalid")).status, 403);
  assert.equal((await request("invalid-origin")).status, 403);
  assert.equal(starts, 1);
});
