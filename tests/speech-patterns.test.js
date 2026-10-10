// Labelled synthetic speech/reference fixtures; never real saved results or calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeSpeech, understanding, relevantCoverage, referenceEvidence, speechGuidance } = require("../lib/speech-patterns");
const { metricInputs, performance } = require("../lib/performance");
const { validateEvaluation } = require("../lib/rubric-validation");
const { getRubric, evaluatorPrompt } = require("../lib/rubric");
const { evaluatorInput } = require("../lib/evaluation");
const { buildPromptUpdates } = require("../lib/prompt-updates");

const transcript = "Um, um, let's go to Dorset, what we we do, we have this this thing.";
const reference = "I'm at school in Dorset, and we have an Army Cadet Force activity on Wednesdays.";
const prompt = "Ask one question at a time, use plain and respectful language.\nNever diagnose or ignore emergency concerns.";
const metricInputSnapshot = metricInputs({ reference_transcript: reference, critical_items: [
  { id: "school", label: "At school in Dorset", phrases: ["at school in Dorset"] },
  { id: "activity", label: "Army Cadet Force", phrases: ["Army Cadet Force"] }
] });
const rubric = getRubric({ id: "sample-01", label: "Teen pre-visit intake" });
const parameter = rubric.parameters.find(item => item.theme === "speech_patterns");
function fixture(overrides = {}, baselineOverrides = {}) {
  const baseline = {
    rawOutput: transcript, outputPartial: false, metricInputSnapshot,
    speechPatterns: analyzeSpeech(transcript, ["Stuttering"]), context: { speechProfileTags: ["Stuttering"] },
    excerpt: { length: 15 }
  };
  Object.assign(baseline, baselineOverrides);
  const raw = JSON.stringify({
    summary: "Stuttering-style repetition obscures the caller's context.",
    parameters: [{ id: parameter.id, theme: parameter.theme, observed: true, status: "issue" }],
    findings: [{
      id: "stutter", parameter_id: parameter.id, speech_pattern: "Stuttering",
      title: "Repeated words and restarted phrases", quote: "let's go to Dorset",
      reference_quote: "I'm at school in Dorset", missed_item_ids: ["school", "invented"],
      accessibility_impact: "The agent changed the caller's school context into a travel statement.",
      why_it_matters: "The caller's reason and context could be lost.",
      severity: "high", confidence: "high", prompt_coverage: "partial",
      coverage_quote: prompt.split("\n")[0], ...overrides
    }], prompt_edits: []
  });
  return validateEvaluation(raw, baseline, prompt, rubric);
}
test("word, sound and filler observations are text-based; fillers alone are not labelled stuttering", () => {
  const speech = analyzeSpeech(transcript);
  assert.equal(speech.patterns[0].label, "Word repetitions");
  assert.equal(speech.patterns[0].counts.wordRepetitions, 2);
  assert.equal(speech.patterns[0].counts.fillers, 2);
  assert.equal(analyzeSpeech("um I would like uh books").patterns[0].label, "Fillers and restarts");
  assert.equal(analyzeSpeech("b-b-book").patterns[0].counts.soundRepetitions, 1);
  assert.equal(analyzeSpeech("plain fluent words").patterns.length, 0);
  assert.equal(analyzeSpeech("Um, let's go to Dorset, um, what we do, we have this, um, this, um, thing").patterns[0].label, "Word repetitions");
  assert.equal(analyzeSpeech(transcript, ["Stuttering"]).patterns[0].label, "Stuttering");
  assert.equal(analyzeSpeech("Very very good. It is really really useful.").patterns[0].label, "Word repetitions");
  assert.equal(analyzeSpeech("Yes yes, absolutely. No no, I disagree.").patterns[0].label, "Word repetitions");
  assert.equal(analyzeSpeech("plain words", ["Accent"]).patterns[0].counts.wordRepetitions, undefined);
});
test("evaluator instructions require speech-pattern-first feedback, exact reference evidence and concrete edits", () => {
  const instructions = evaluatorPrompt(rubric);
  for (const phrase of ["speech pattern", "stuttering", "reference_quote", "missed_item_ids", "yes/no", "never diagnose", "generic politeness"]) {
    assert.ok(instructions.toLowerCase().includes(phrase.toLowerCase()), phrase);
  }
  const input = evaluatorInput({ agentName: "Example", purpose: "Example", speechProfileTags: ["Stuttering"], systemPrompt: prompt }, transcript, { metricInputSnapshot, patternTranscript: transcript });
  assert.ok(input.includes(prompt));
  assert.ok(input.includes(reference));
  assert.ok(input.includes("CRITICAL ITEMS"));
  assert.ok(input.includes("AGENT-PRODUCED TRANSCRIPT"));
});
test("generic respectful wording is not coverage; missed key items and recovery estimates are server validated", () => {
  const review = fixture();
  const finding = review.verifiedFindings[0];
  assert.equal(finding.speechPattern, "Stuttering");
  assert.equal(finding.prompt_coverage, "none");
  assert.equal(finding.coverage_quote, "");
  assert.equal(finding.referenceVerified, true);
  assert.deepEqual(finding.missedItems.map(item => item.id), ["school"]);
  assert.equal(finding.potentialRecoveryPoints, 25);
  assert.equal(finding.title, "Stuttering: Repeated words and restarted phrases");
  assert.equal(review.evidenceMetrics.accessibilityScore, performance(transcript, metricInputSnapshot).accessibilityScore);
});
test("invented reference meaning and absent references never create key-item recovery estimates", () => {
  for (const review of [fixture({ reference_quote: "made up reference" }), fixture({}, { metricInputSnapshot: metricInputs({}) })]) {
    const finding = review.verifiedFindings[0];
    assert.equal(finding.referenceVerified, false);
    assert.equal(finding.potentialRecoveryPoints, null);
    assert.deepEqual(finding.missedItems, []);
    assert.ok(!finding.accessibilityImpact.includes("travel statement"));
  }
});
test("a reference quote cannot attribute a different key item; unsupported conditions are not diagnosed", () => {
  assert.deepEqual(fixture({ missed_item_ids: ["activity"] }).verifiedFindings[0].missedItems, []);
  assert.equal(fixture({ speech_pattern: "Tourette syndrome" }).verifiedFindings[0].speechPattern, "Speech recognition");
  assert.ok(!fixture({ speech_pattern: "Tourette syndrome" }, { metricInputSnapshot: metricInputs({}) })
    .verifiedFindings[0].accessibilityImpact.includes("Involuntary"));
  assert.equal(fixture({}, { outputPartial: true }).verifiedFindings[0].potentialRecoveryPoints, null);
});
test("pattern-aware edits replace vague politeness; reference terms and safety rules remain protected", () => {
  const review = fixture();
  const edit = { id: "edit", category: "speech-pattern handling", addresses: ["stutter"], type: "append",
    rationale: "Preserve meaning across repeated phrases.", expected_effect: "A clearer transcript.", verify_by: "Check that the school context is retained.",
    new_text: "The caller may stutter. Treat repeated words and starting fillers as speech patterns, combine restarted phrases into one intended sentence, let the caller finish without interruption, and confirm unclear key details in one short yes/no question without guessing." };
  const valid = buildPromptUpdates(prompt, [edit], review, transcript, reference);
  assert.equal(valid.promptUpdates.length, 1);
  assert.equal(valid.promptUpdates[0].speechPattern, "Stuttering");
  assert.equal(valid.promptUpdates[0].potentialRecoveryPoints, 25);
  assert.ok(valid.suggestedPrompt.startsWith(prompt));
  assert.equal(valid.diff.filter(line => line.type === "removed").length, 0);
  assert.equal(valid.diff.filter(line => line.type === "context").map(line => line.text).join(""), prompt);
  assert.equal(valid.diff.filter(line => line.type !== "removed").map(line => line.text).join(""), valid.suggestedPrompt);
  const vague = buildPromptUpdates(prompt, [{ ...edit, new_text: "Be kind and gently ask for clarification." }], review, transcript);
  assert.equal(vague.promptUpdates.length, 0);
});
test("understanding summaries use actual captured items or a missing-reference state", () => {
  const result = performance(transcript, metricInputSnapshot);
  assert.match(understanding(result).text, /0 of 2/);
  assert.equal(understanding(null).assessed, false);
  assert.equal(understanding(null).text, "Add a reference transcript to score this recording");
});

test("neutral recognition still accepts concrete coverage and edits", () => {
  assert.equal(relevantCoverage("Speech recognition", "Confirm unclear words against the audio before recording them."), true);
  assert.equal(relevantCoverage("Speech recognition", "Be kind and respectful."), false);
  assert.equal(relevantCoverage("Speech recognition", "Confirm details."), false);
  assert.equal(relevantCoverage("Speech recognition", "Choose words kindly."), false);
  assert.equal(relevantCoverage("Speech recognition", "Confirm the best evidence-supported understanding in one short yes/no question."), true);
  assert.equal(relevantCoverage("Speech recognition", "Select a term when the audio and context support it."), true);
  const review = fixture({ speech_pattern: "Unclassified recognition pattern" });
  const edit = { id: "recognition", category: "speech-pattern handling", addresses: ["stutter"], type: "append", rationale: "Preserve uncertainty.", expected_effect: "Unclear wording is confirmed.", verify_by: "Check uncertain words against the audio.", new_text: "Confirm unclear words against the audio before recording them." };
  assert.equal(review.verifiedFindings[0].speechPattern, "Speech recognition");
  assert.equal(buildPromptUpdates(prompt, [edit], review, transcript).promptUpdates.length, 1);
  assert.equal(buildPromptUpdates(prompt, [{ ...edit, new_text: "Be kind and respectful." }], review, transcript).promptUpdates.length, 0);
});

test("explicit readable references require matching immutable hashes, audio, and excerpt", () => {
  const metadata = { kind: "readable", policyVersion: "readable-1", verified: true, verifiedBy: "synthetic-fixture", verifiedAt: "2026-10-10T00:00:00Z", sourceAudioSha256: "source-audio", excerpt: { startOffset: 0, length: 15 } };
  const snapshot = metricInputs({ reference_transcript: reference, critical_items: metricInputSnapshot.criticalItems, reference: metadata });
  const evidence = { rawOutput: transcript, metricInputSnapshot: snapshot, audioHashes: { sourceSha256: "source-audio" }, excerpt: { startOffset: 0, length: 15 } };
  assert.equal(referenceEvidence(evidence), snapshot);
  for (const invalid of [
    { ...evidence, audioHashes: { sourceSha256: "another-audio" } },
    { ...evidence, excerpt: { startOffset: 5, length: 15 } },
    { ...evidence, metricInputSnapshot: { ...snapshot, referenceTranscript: "altered text" } },
    { ...evidence, metricInputSnapshot: { ...snapshot, criticalItems: ["invented"] } },
    { ...evidence, metricInputSnapshot: { ...snapshot, referenceMetadata: { ...snapshot.referenceMetadata, verified: false } } },
    { ...evidence, metricInputSnapshot: { ...snapshot, referencePolicyHash: "altered" } },
  ]) {
    assert.equal(referenceEvidence(invalid), null);
    assert.equal(fixture({}, invalid).verifiedFindings[0].referenceVerified, false);
    assert.equal(fixture({}, invalid).verifiedFindings[0].potentialRecoveryPoints, null);
    const input = evaluatorInput({ agentName: "Example", purpose: "Example", speechProfileTags: [], systemPrompt: prompt }, transcript, invalid);
    assert.ok(!input.includes(reference));
  }
  const unverified = fixture({}, { ...evidence, metricInputSnapshot: { ...snapshot, referenceMetadata: { ...snapshot.referenceMetadata, verified: false } } });
  assert.equal(unverified.verifiedFindings.length, 1);
  assert.equal(unverified.verifiedFindings[0].referenceQuote, "");
});

test("a quoted substring cannot attribute another complete key-item phrase", () => {
  const items = metricInputs({ reference_transcript: "great school", critical_items: [{ id: "school", phrases: ["at school"] }] });
  assert.deepEqual(fixture({ reference_quote: "great school", missed_item_ids: ["school"] }, { metricInputSnapshot: items }).verifiedFindings[0].missedItems, []);
});

test("live guidance keeps raw text and uses only exact observed quotes and preset instructions", () => {
  const preset = require("../config/transcript-improvement.json");
  for (const rawOutput of ["Um, I I want books.", "b-b-book", "um I would like uh books", "The word is [unclear]."]) {
    const run = { rawOutput, status: "finished", context: { speechProfileTags: [] } };
    const guidance = speechGuidance(run);
    assert.ok(guidance.findings.length > 0);
    assert.equal(guidance.edits.length, guidance.findings.length);
    for (const finding of guidance.findings) {
      assert.ok(rawOutput.includes(finding.quote));
      assert.equal(finding.referenceVerified, false);
      assert.equal(finding.potentialRecoveryPoints, null);
      assert.deepEqual(finding.missedItems, []);
      assert.ok(!finding.speechPattern.includes("Stutter"));
    }
    for (const edit of guidance.edits) assert.ok(preset.prompt.includes(edit.new_text));
    assert.equal(run.rawOutput, rawOutput);
  }
  assert.deepEqual(speechGuidance({ rawOutput: "Plain fluent words.", status: "finished" }), { findings: [], edits: [] });
  assert.deepEqual(speechGuidance({ rawOutput: transcript, status: "partial", outputPartial: true }), { findings: [], edits: [] });
  assert.equal(speechGuidance({ rawOutput: "Um, I I want books.", status: "finished" }).findings[0].quote, "I I");
});
