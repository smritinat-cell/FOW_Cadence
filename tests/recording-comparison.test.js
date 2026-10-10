// Synthetic verified reference fixtures exercise validation; shipped references remain unverified.
const test = require("node:test");
const assert = require("node:assert/strict");
const { BASELINE_PROMPT } = require("../lib/ultravox");
const { getRecordingComparisonProfile, getRecordingComparison, prepareRecordingMetricInputs, prepareRecordingRunInputs,
  getHistoricalRecordingReferenceDraft } = require("../lib/recording-comparison");
const { performance, comparison, metricInputs, VERSION } = require("../lib/performance");
const { getRubric, evaluatorPrompt } = require("../lib/rubric");
const { validateEvaluation } = require("../lib/rubric-validation");

function syntheticVerifiedProfile() {
  const profile = getRecordingComparisonProfile("sample-01");
  return { ...profile, reference_transcript: "red blue green", critical_items: ["red", "green"],
    reference: { ...profile.reference, verified: true, verifiedBy: "synthetic-test-fixture", verifiedAt: "2026-10-10T00:00:00.000Z" } };
}

test("all three recording profiles freeze 0–15 seconds and the original baseline prompt", () => {
  for (const id of ["sample-01", "sample-02", "sample-03"]) {
    const profile = getRecordingComparisonProfile(id);
    assert.equal(profile.workflow, "recording-comparison");
    assert.deepEqual(profile.excerpt, { startOffset: 0, length: 15, excerptLength: "15" });
    assert.equal(profile.context.systemPrompt, BASELINE_PROMPT);
    assert.equal(profile.reference.kind, "readable");
    assert.equal(profile.reference.verified, false);
    assert.match(profile.reference.sourceAudioSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => getRecordingComparison(id, { id }, profile.reference.sourceAudioSha256), { code: "REFERENCE_UNVERIFIED" });
  }
  assert.throws(() => getRecordingComparisonProfile("unsupported"), { code: "INVALID_RECORDING" });
});

test("published-source drafts remain unverified and historical full audio is separate", () => {
  const draft = getHistoricalRecordingReferenceDraft("sample-01");
  assert.equal(draft.reference.verified, false);
  assert.equal(draft.reference.excerpt.length, 133.747);
  assert.ok(draft.reference_transcript.includes("personal CD player"));
  assert.equal(getHistoricalRecordingReferenceDraft("sample-03"), null);
  assert.throws(() => prepareRecordingMetricInputs({ ...getRecordingComparisonProfile("sample-01"), ...draft },
    draft.reference.sourceAudioSha256), { code: "REFERENCE_MISMATCH" });
});

test("unverified recordings can run without using their draft text as scoring truth", () => {
  for (const id of ["sample-01", "sample-02", "sample-03"]) {
    const profile = getRecordingComparisonProfile(id);
    const draft = structuredClone(profile);
    const inputs = prepareRecordingRunInputs(profile, profile.reference.sourceAudioSha256);
    assert.equal(inputs.referenceTranscript, "");
    assert.deepEqual(inputs.criticalItems, []);
    assert.equal(inputs.referenceMetadata.verified, false);
    assert.equal(inputs.referenceMetadata.sourceAudioSha256, profile.reference.sourceAudioSha256);
    assert.deepEqual(inputs.referenceMetadata.excerpt, { startOffset: 0, length: 15 });
    assert.deepEqual(inputs.scoringBasis, { status: "unverified", kind: "readable-reference", reason: "REFERENCE_UNVERIFIED" });
    const measured = performance(profile.reference_transcript || "live model output", inputs);
    for (const field of ["accessibilityScore", "wordAccuracy", "keyItemsCaptured", "keyItemsTotal", "keyItemsPercent"]) assert.equal(measured[field], null);
    assert.deepEqual(profile, draft);
    assert.throws(() => prepareRecordingRunInputs(profile, "changed"), { code: "AUDIO_MISMATCH" });
    assert.throws(() => prepareRecordingRunInputs({ ...profile, excerpt: { startOffset: 5, length: 15 } },
      profile.reference.sourceAudioSha256), { code: "REFERENCE_MISMATCH" });
  }
});

test("run inputs use strict scoring only for a reviewed reference", () => {
  const profile = syntheticVerifiedProfile();
  const inputs = prepareRecordingRunInputs(profile, profile.reference.sourceAudioSha256);
  assert.equal(inputs.referenceTranscript, "red blue green");
  assert.equal(inputs.scoringBasis.status, "verified");
  assert.equal(performance("red blue", inputs).accessibilityScore, 58);
  assert.throws(() => prepareRecordingRunInputs({ ...profile, reference: { ...profile.reference, verifiedAt: null } },
    profile.reference.sourceAudioSha256), { code: "REFERENCE_UNVERIFIED" });
  assert.throws(() => prepareRecordingRunInputs({ ...profile, critical_items: ["not in the reference"] },
    profile.reference.sourceAudioSha256), { code: "REFERENCE_KEY_ITEMS_INVALID" });
});

test("live preparation rejects a changed source hash, excerpt, or key-item reference", () => {
  const profile = syntheticVerifiedProfile();
  assert.throws(() => prepareRecordingMetricInputs(profile, "changed"), { code: "AUDIO_MISMATCH" });
  assert.throws(() => prepareRecordingMetricInputs({ ...profile, excerpt: { startOffset: 0, length: 30 } },
    profile.reference.sourceAudioSha256), { code: "REFERENCE_MISMATCH" });
  assert.throws(() => prepareRecordingMetricInputs({ ...profile, critical_items: ["outside the reference"] },
    profile.reference.sourceAudioSha256), { code: "REFERENCE_KEY_ITEMS_INVALID" });
});

test("reviewed readable inputs preserve Smriti's formula and a stable matching reference snapshot", () => {
  const profile = syntheticVerifiedProfile();
  const inputs = prepareRecordingMetricInputs(profile, profile.reference.sourceAudioSha256);
  profile.critical_items.push("changed after preparation");
  const beforeMetrics = performance("red blue", inputs);
  const afterMetrics = performance("red blue green", inputs);
  assert.equal(inputs.version, VERSION);
  assert.equal(beforeMetrics.accessibilityScore, 58);
  assert.equal(afterMetrics.accessibilityScore, 100);
  assert.equal(beforeMetrics.keyItemsTotal, 2);
  assert.equal(beforeMetrics.referenceMetadata.kind, "readable");
  const before = { sampleId: "sample-01", useCase: { id: "sample-01" }, requestedModel: "test-model",
    excerpt: { startOffset: 0, length: 15 }, audioHashes: { sourceSha256: profile.reference.sourceAudioSha256, excerptPcmSha256: "same-excerpt" }, performance: beforeMetrics };
  assert.equal(comparison(before, { ...before, performance: afterMetrics }).deltas.accessibilityScore, 42);
  const otherPolicy = metricInputs({ ...profile, critical_items: ["red", "green"], reference: { ...profile.reference, kind: "verbatim" } });
  assert.equal(comparison(before, { ...before, performance: performance("red blue green", otherPolicy) }).comparable, false);
});

test("recording review uses its transcription profile while clinical review stays unchanged", () => {
  const profile = getRecordingComparisonProfile("sample-01");
  const rubric = getRubric(profile.useCase, profile.workflow);
  assert.equal(rubric.rubric_version, "recording-transcription-1");
  assert.equal(rubric.themes.length, 4);
  assert.ok(rubric.parameters.every(parameter => parameter.id.startsWith("transcription.")));
  assert.ok(!evaluatorPrompt(rubric).includes("Medication names"));
  const clinical = getRubric({ id: "sample-01", label: "Teen pre-visit intake" });
  assert.ok(clinical.parameters.some(parameter => parameter.id === "intake.medication_names_doses"));
});

test("transcription review validates exact evidence and never produces a primary accessibility score", () => {
  const profile = getRecordingComparisonProfile("sample-01");
  const rubric = getRubric(profile.useCase, profile.workflow);
  const result = validateEvaluation(JSON.stringify({
    summary: "Synthetic review.",
    parameters: rubric.parameters.map(parameter => ({ id: parameter.id, theme: parameter.theme,
      observed: parameter.id === "transcription.repetitions", status: parameter.id === "transcription.repetitions" ? "issue" : "not_observed" })),
    findings: [{ id: "repeated", parameter_id: "transcription.repetitions", title: "Repetition", quote: "red red",
      why_it_matters: "Synthetic rationale.", severity: "medium", confidence: "high", prompt_coverage: "none", coverage_quote: "" },
    { id: "invented", parameter_id: "transcription.repetitions", title: "Invented", quote: "absent wording",
      why_it_matters: "Synthetic rationale.", severity: "high", confidence: "high", prompt_coverage: "none", coverage_quote: "" }],
    prompt_edits: [], score: 99,
  }), { rawOutput: "red red blue", status: "finished" }, BASELINE_PROMPT, rubric);
  assert.equal(result.verifiedFindings.length, 1);
  assert.equal(result.unverifiedFindings.length, 1);
  assert.equal(result.computedScores.overall, null);
  assert.equal(result.computedScores.name, "Transcript review (model-assessed)");
  assert.ok(result.validationFlags.some(flag => flag.message.includes("Model-supplied")));
});
