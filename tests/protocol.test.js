const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TranscriptAssembler, callSettings, BASELINE_PROMPT, requireKey, providerRequest } = require("../lib/ultravox");
const { evaluatorInput, parseEvaluation, applyEdits } = require("../lib/evaluation");
const { Jobs, redact } = require("../lib/jobs");
const { decodeExcerpt } = require("../lib/audio");
const { getDemoComparison } = require("../lib/comparison");

// This process never uses the real provider credential or makes real provider calls.
delete process.env.ULTRAVOX_API_KEY;

test("agent setup has exactly two linked tabs and no recording-upload markup or styling", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "artifacts", "speech-prompt-lab", "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "artifacts", "speech-prompt-lab", "styles.css"), "utf8");
  const tabs = [...app.matchAll(/id="tab-([^"]+)" role="tab"[^>]*aria-controls="([^"]+)"/g)];
  assert.deepEqual(tabs.map(match => [match[1], match[2]]), [
    ["connect", "panel-connect"], ["prompt", "panel-prompt"]
  ]);
  const panels = [...app.matchAll(/id="panel-([^"]+)" role="tabpanel" aria-labelledby="([^"]+)"/g)];
  assert.deepEqual(panels.map(match => [match[1], match[2]]), [
    ["connect", "tab-connect"], ["prompt", "tab-prompt"]
  ]);
  assert.doesNotMatch(app, /tab-upload|panel-upload|activeAgentTab\s*===?\s*["']upload["']|Upload call audio|Coming soon: upload your own recording|type=["']file["']/i);
  assert.doesNotMatch(styles, /\.usecases\b|\.usecase-mark\b|\.coming-message\b/);
});

test("missing key gives a specific safe error", () => {
  assert.throws(requireKey, error => error.code === "MISSING_KEY");
});

test("full transcript replaces, delta appends, roles/ordinals stay separate", () => {
  const assembler = new TranscriptAssembler();
  assembler.accept({ type: "transcript", role: "agent", ordinal: 2, delta: "second", final: false });
  assembler.accept({ type: "transcript", role: "user", ordinal: 1, text: "input", final: true });
  assembler.accept({ type: "transcript", role: "agent", ordinal: 0, text: "wrong", final: false });
  assembler.accept({ type: "transcript", role: "agent", ordinal: 0, text: " First, um... ", final: true });
  assembler.accept({ type: "transcript", role: "agent", ordinal: 2, delta: "?", final: true });
  assert.equal(assembler.text("agent"), " First, um... \nsecond?");
  assert.equal(assembler.text("user"), "input");
  assert.equal(assembler.final(), true);
});

test("baseline and evaluator call settings do not mix prompts or audio", () => {
  const baseline = callSettings("baseline", "ultravox-v0.7", 15);
  assert.equal(baseline.systemPrompt, BASELINE_PROMPT);
  assert.equal(BASELINE_PROMPT, "Transcribe the audio. Output only the transcript.");
  assert.equal(baseline.temperature, 0);
  assert.deepEqual(baseline.firstSpeakerSettings, { user: {} });
  assert.equal(baseline.initialOutputMedium, "MESSAGE_MEDIUM_TEXT");
  assert.equal(baseline.recordingEnabled, false);
  assert.deepEqual(baseline.inactivityMessages, []);
  assert.equal(baseline.vadSettings, undefined);
  const evaluation = callSettings("evaluation", "ultravox-v0.7", 0, "Reviewer", "Labelled text");
  assert.equal(evaluation.systemPrompt, "Reviewer");
  assert.deepEqual(evaluation.firstSpeakerSettings, { agent: {} });
  assert.deepEqual(evaluation.initialMessages, [{ role: "MESSAGE_ROLE_USER", medium: "MESSAGE_MEDIUM_TEXT", text: "Labelled text" }]);
});

test("evaluator input includes the exact draft and raw transcript, never reference fields", () => {
  const context = { agentName: "Agent", purpose: "Listen", speechProfileTags: ["Child"], systemPrompt: "  Prompt\nexact  ", reference: "SECRET_REFERENCE" };
  const input = evaluatorInput(context, "  raw um...  ");
  assert.ok(input.includes("\n  Prompt\nexact  \n"));
  assert.ok(input.endsWith("\n  raw um...  "));
  assert.ok(!input.includes("SECRET_REFERENCE"));
});

test("quote validation preserves invented quotes and reports them without fixing", () => {
  const raw = JSON.stringify({ summary: "Review", issues: [{ id: "i1", severity: "high", category: "word", title: "Term", quote: "invented word", why: "Risk" }], prompt_edits: [{ id: "e1", issue_ids: ["i1"], rationale: "Clarify", type: "insert-after", anchor: "Ask clearly.", new_text: "Ask to repeat." }] });
  const result = parseEvaluation(raw, "Actual words", "Ask clearly.");
  assert.equal(result.parseError, null);
  assert.equal(result.parsedResult.issues[0].quote, "invented word");
  assert.deepEqual(result.validationFlags, [{ issueId: "i1", message: "Quote not found in transcript" }]);
  assert.equal(result.suggestedPrompt, "Ask clearly.\nAsk to repeat.");
  assert.ok(result.diff.some(line => line.type === "added"));
});

test("missing, ambiguous and safety-removing anchors remain unapplied", () => {
  const result = applyEdits("Never diagnose. Ask clearly. Ask clearly.", [
    { id: "missing", type: "replace", anchor: "Not present.", newText: "Change." },
    { id: "ambiguous", type: "replace", anchor: "Ask clearly.", newText: "Change." },
    { id: "safety", type: "replace", anchor: "Never diagnose.", newText: "Diagnose." },
    { id: "append", type: "append", newText: "Record uncertainty." },
  ]);
  assert.equal(result.unappliedEdits.length, 3);
  assert.equal(result.suggestedPrompt, "Never diagnose. Ask clearly. Ask clearly.\nRecord uncertainty.");
});

test("invalid evaluator JSON exposes a parse state, not synthetic findings", () => {
  const result = parseEvaluation("not JSON", "transcript", "prompt");
  assert.equal(result.parsedResult, null);
  assert.match(result.parseError, /couldn't finish this evaluation/);
  assert.equal(result.suggestedPrompt, null);
});

test("demo comparison round-trips the exact supplied transcripts without becoming reference data", () => {
  const comparison = getDemoComparison();
  assert.equal(comparison.mode, "demo");
  assert.equal(comparison.segments.filter(segment => segment.type !== "added").map(segment => segment.text).join(""), comparison.before);
  assert.equal(comparison.segments.filter(segment => segment.type !== "removed").map(segment => segment.text).join(""), comparison.after);
  assert.ok(comparison.before.includes("Aggets and and some and some and some new gosh"));
  assert.ok(comparison.after.includes("So I've\nAnd some new squash shoes as well."));
  assert.ok(comparison.after.endsWith("Yes\nbut we"));
  assert.ok(comparison.counts.removedWords > 0 && comparison.counts.addedWords > 0);
  assert.equal(comparison.sampleId, undefined);
  assert.equal(comparison.reference, undefined);
});

test("provider failures are specific and never leak raw provider errors", async () => {
  process.env.ULTRAVOX_API_KEY = "test-only-not-a-real-key";
  const originalFetch = global.fetch;
  try {
    for (const [status, code] of [[401, "INVALID_KEY"], [429, "USAGE_LIMIT"], [404, "MODEL_UNAVAILABLE"], [503, "NETWORK_FAILURE"]]) {
      global.fetch = async () => ({ ok: false, status, text: async () => "wss://private.example/join?key=test-only-not-a-real-key" });
      await assert.rejects(providerRequest("/calls"), error => error.code === code && !error.message.includes("private.example"));
    }
    assert.equal(redact("test-only-not-a-real-key wss://private.example/join"), "[REDACTED] [REDACTED WEBSOCKET URL]");
    assert.deepEqual(redact({ joinUrl: "private", safe: "ok", authorization: "private" }), { safe: "ok" });
  } finally { global.fetch = originalFetch; }
});

test("saved runs are session-isolated and interrupted runs never restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cadence-jobs-"));
  try {
    const jobs = new Jobs(() => null, { directory });
    const record = { id: "11111111-1111-1111-1111-111111111111", ownerHash: "ownerA", status: "streaming", rawOutput: "partial words", createdAt: new Date().toISOString(), elapsedMs: 1000 };
    jobs.persist(record);
    const restored = new Jobs(() => null, { directory });
    assert.equal(restored.activeId, null);
    assert.equal(restored.list("ownerA")[0].status, "cancelled");
    assert.equal(restored.list("ownerA")[0].outputPartial, true);
    assert.equal(restored.list("ownerA")[0].ownerHash, undefined);
    assert.equal(restored.list("ownerB").length, 0);
    assert.throws(() => restored.owned(record.id, "ownerB"), error => error.code === "NOT_FOUND");
    restored.activeId = record.id;
    assert.throws(() => restored.start("baseline", {}, "ownerA"), error => error.code === "RUN_ACTIVE");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("FFmpeg creates a real 16 kHz mono s16le offset excerpt and rejects invalid audio", async () => {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "demo-pack", "sample-01.json"), "utf8"));
  const file = path.join(__dirname, "..", "attached_assets", source.prototype_audio_file);
  const buffer = await decodeExcerpt(file, 2, 1, new AbortController().signal);
  assert.equal(buffer.length, 32000);
  await assert.rejects(decodeExcerpt("/does-not-exist.wav", 0, 1, new AbortController().signal), error => error.code === "DECODE_FAILURE");
});
