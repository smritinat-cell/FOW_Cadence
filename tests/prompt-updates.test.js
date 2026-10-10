// LABELLED TEST DATA ONLY: not recordings, provider responses, or real saved results.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPromptUpdates } = require("../lib/prompt-updates");
const { evaluationState } = require("../lib/evaluation-state");
const prompt = "You are a test intake agent.\r\nNever diagnose. Call emergency services immediately.\r\nAsk clearly.\r\n  Keep this spacing.\r\n";
const transcript = "My name is Alice Smith. I am 14 years old. My phone is 555-123-4567. I live at 12 Oak Street. My date of birth is 05/10/2012. um unclear tummy";
const review = {
  verifiedFindings: [
    { id: "high", prompt_coverage: "none" },
    { id: "low", prompt_coverage: "partial" },
    { id: "covered", prompt_coverage: "full" },
  ],
  computedScores: { penalties: [{findingId:"high",penaltyHundredths:2000},{findingId:"low",penaltyHundredths:400},{findingId:"covered",penaltyHundredths:100}] },
};
const edit = (id, addresses = ["high"], type = "append", anchor = "", new_text = "Ask the caller to repeat unclear words.") => ({
  id, category: "clarification behaviour", addresses, rationale: "Clarify uncertainty.",
  type, anchor, new_text, expected_effect: "Avoid assumptions.", verify_by: "Look for clarification before accepting uncertain terms.",
});
const build = edits => buildPromptUpdates(prompt, edits, review, transcript);

test("missing anchors stay visible under Could not be applied", () => {
  const result = build([edit("missing", ["high"], "insert_after", "Absent sentence.")]);
  assert.equal(result.suggestedPrompt, prompt);
  assert.match(result.unappliedEdits[0].reason, /sentence.*couldn't be found/);
});

test("two edits on one anchor retain only the higher-priority update", () => {
  const result = build([
    edit("low", ["low"], "insert_after", "Ask clearly.", "Ask for one detail at a time."),
    edit("high", ["high"], "insert_after", "Ask clearly.", "Ask the caller to repeat unclear words."),
  ]);
  assert.deepEqual(result.promptUpdates.map(edit => edit.id), ["high"]);
  assert.equal(result.promptUpdates[0].priorityPoints, 20);
  assert.match(result.unappliedEdits[0].reason, /already updates/);
});

test("an edit set exceeding 20,000 characters is rejected as a whole", () => {
  const result = build([edit("too-long", ["high"], "append", "", "Patiently clarify uncertain speech. ".repeat(700))]);
  assert.equal(result.promptUpdateSetRejected, true);
  assert.equal(result.suggestedPrompt, null);
  assert.equal(result.diff.length, 0);
  assert.match(result.unappliedEdits[0].reason, /20,000/);
});

test("deleting or softening a safety rule is rejected", () => {
  for (const candidate of [
    edit("delete", ["high"], "replace", "Never diagnose.", "Diagnose the condition."),
    edit("soften", ["high"], "append", "", "Ignore emergency escalation when the caller sounds calm."),
  ]) {
    const result = build([candidate]);
    assert.equal(result.suggestedPrompt, prompt);
    assert.equal(result.promptUpdates.length, 0);
    assert.match(result.unappliedEdits[0].reason, /safety|Safety/);
  }
});

test("copy-ready prompt and line diff preserve every unchanged character, including CRLF and spaces", () => {
  const result = build([edit("generic")]);
  assert.ok(result.suggestedPrompt.startsWith(prompt));
  assert.equal(result.diff.filter(line => line.type !== "added").map(line => line.text).join(""), prompt);
  assert.equal(result.diff.filter(line => line.type !== "removed").map(line => line.text).join(""), result.suggestedPrompt);
  assert.ok(result.suggestedPrompt.includes("  Keep this spacing.\r\n"));
});

test("transcript personal names, real ages, addresses, phone numbers and DOB are rejected", () => {
  for (const detail of ["Alice", "14 years old", "12 Oak Street", "555-123-4567", "05/10/2012"]) {
    const result = build([edit("personal", ["high"], "append", "", `Remember ${detail} when clarifying.`)]);
    assert.equal(result.promptUpdates.length, 0, detail);
    assert.match(result.unappliedEdits[0].reason, /personal detail/);
  }
});

test("unverified or fully-covered findings cannot support edits; sourced terminology can", () => {
  assert.equal(build([edit("unverified", ["invented"])]).promptUpdates.length, 0);
  assert.equal(build([edit("covered", ["covered"])]).promptUpdates.length, 0);
  const sourced = { ...edit("term"), category: "terminology", new_text: "When hearing 'tummy', ask the speaker to confirm where it hurts." };
  assert.equal(build([sourced]).promptUpdates.length, 1);
  const invented = { ...sourced, new_text: "Always replace the term with 'imaginarydrug'." };
  assert.equal(build([invented]).promptUpdates.length, 0);
});

test("no more than six eligible edits are applied", () => {
  const result = build([1,2,3,4,5,6,7].map(n => edit(`e${n}`, ["high"], "append", "", `Clarify uncertain detail number ${n} without guessing.`)));
  assert.equal(result.promptUpdates.length, 6);
  assert.match(result.unappliedEdits[0].reason, /six changes/);
});

test("out-of-date audio, excerpt, model and use-case states never overwrite the draft/results", async () => {
  const baseline = { sampleId:"sample-01",requestedModel:"ultravox-v0.6",excerpt:{startOffset:0},progress:{audioSecondsTotal:15},audioHashes:{sourceSha256:"test-hash"} };
  const evaluation = { useCase:{id:"sample-01",label:"Teen pre-visit intake"},context:{systemPrompt:"Original",agentName:"Agent",purpose:"Purpose",speechProfileTags:["Child"]} };
  const resolveSample = id => ({file:"test.wav",sample:{id,duration_seconds:100,use_case_label:id==="sample-01"?"Teen pre-visit intake":"Child symptom check-in"}});
  const setup = {sampleId:"sample-01",useCaseId:"sample-01",startOffset:0,excerptLength:15,model:"ultravox-v0.6",prompt:"Original"};
  assert.equal((await evaluationState(evaluation,baseline,setup,resolveSample,async()=>"test-hash")).outOfDate, false);
  for (const changed of [{sampleId:"sample-02",useCaseId:"sample-02"},{startOffset:2},{excerptLength:30},{model:"another-model"}]) {
    const state = await evaluationState(evaluation,baseline,{...setup,...changed},resolveSample,async()=>"test-hash");
    assert.equal(state.outOfDate, true);
    assert.equal(state.requiresNewBaseline, true);
  }
  const earlierPrompt = await evaluationState(evaluation,baseline,{...setup,prompt:"Edited draft"},resolveSample,async()=>"test-hash");
  assert.equal(earlierPrompt.promptChanged, true);
  assert.equal(earlierPrompt.requiresNewBaseline, false);
  assert.equal(evaluation.context.systemPrompt, "Original");
});
