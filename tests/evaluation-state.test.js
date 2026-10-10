const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluationState } = require("../lib/evaluation-state");
const { metricInputs } = require("../lib/performance");

test("review audit retains the exact analyzed result and detects changed transcript or reference snapshots", async () => {
  const inputs = metricInputs({ reference_transcript: "known words", critical_items: ["words"] });
  const baseline = { id: "baseline", sampleId: "sample-01", requestedModel: "test-model", excerpt: { startOffset: 0, length: 15 }, progress: { audioSecondsTotal: 15 }, audioHashes: { sourceSha256: "source" }, rawOutput: "raw um words", metricInputSnapshot: inputs };
  const candidate = { ...baseline, id: "candidate", kind: "candidate", rawOutput: "known words" };
  const review = { baselineId: baseline.id, evaluatedRunId: candidate.id, reviewedTranscript: candidate.rawOutput, referenceInputSnapshot: structuredClone(inputs), useCase: { id: "sample-01", label: "Teen pre-visit intake" }, context: { systemPrompt: "Original prompt" } };
  const setup = { sampleId: "sample-01", startOffset: 0, excerptLength: 15, model: "test-model", prompt: "Original prompt", evaluatedRunId: candidate.id };
  const resolve = () => ({ file: "synthetic.wav", sample: { id: "sample-01", duration_seconds: 100, use_case_label: "Teen pre-visit intake" } });
  const audit = (source, selected = setup) => evaluationState(review, baseline, selected, resolve, async () => "source", source);
  assert.equal((await audit(candidate)).outOfDate, false);
  assert.equal((await audit(baseline)).outOfDate, true);
  assert.equal((await audit(null)).outOfDate, true);
  assert.equal((await audit({ ...candidate, rawOutput: "changed words" })).outOfDate, true);
  assert.equal((await audit({ ...candidate, metricInputSnapshot: metricInputs({ reference_transcript: "different", critical_items: ["different"] }) })).outOfDate, true);
  assert.equal((await audit(candidate, { ...setup, evaluatedRunId: baseline.id })).outOfDate, true);
  assert.equal(candidate.rawOutput, "known words");
  assert.equal(baseline.rawOutput, "raw um words");
});

test("recording-comparison audit uses its transcription use case while retaining excerpt and audio checks", async () => {
  const baseline = { id: "baseline", sampleId: "sample-01", requestedModel: "test-model", excerpt: { startOffset: 0, length: 15 }, progress: { audioSecondsTotal: 15 }, audioHashes: { sourceSha256: "source" }, rawOutput: "raw um words" };
  const review = { workflow: "recording-comparison", baselineId: baseline.id, evaluatedRunId: baseline.id, reviewedTranscript: baseline.rawOutput, useCase: { id: "sample-01", label: "Accessible recording transcription" }, context: { systemPrompt: "Original prompt" } };
  const setup = { sampleId: "sample-01", startOffset: 0, excerptLength: 15, model: "test-model", prompt: "Original prompt" };
  const resolve = () => ({ file: "synthetic.wav", sample: { id: "sample-01", duration_seconds: 100, use_case_label: "Teen pre-visit intake" } });
  assert.equal((await evaluationState(review, baseline, setup, resolve, async () => "source")).outOfDate, false);
  assert.equal((await evaluationState(review, baseline, { ...setup, excerptLength: 30 }, resolve, async () => "source")).outOfDate, true);
});
