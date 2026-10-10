// LABELLED TEST DATA ONLY. These synthetic responses never enter real result storage.
const test = require("node:test");
const assert = require("node:assert/strict");
const { config, getRubric } = require("../lib/rubric");
const { validateEvaluation } = require("../lib/rubric-validation");
const { preferredModel } = require("../lib/ultravox");
const rubric = getRubric({ id: "sample-01", label: "Teen pre-visit intake" });
const baseline = { rawOutput: "Help breathing um yes rash", status: "finished", outputPartial: false, progress: { audioSecondsTotal: 15 } };
const prompt = "Never diagnose. Ask one question at a time.";
const first = theme => rubric.parameters.find(parameter => parameter.theme === theme).id;

function response(findings = [], observedThemes = ["safety_escalation", "speech_patterns"]) {
  return {
    summary: "Labelled synthetic scoring test.",
    parameters: rubric.parameters.map(parameter => ({
      id: parameter.id, theme: parameter.theme,
      observed: observedThemes.some(theme => first(theme) === parameter.id),
      status: observedThemes.some(theme => first(theme) === parameter.id) ? (findings.some(finding => finding.parameter_id === parameter.id) ? "issue" : "ok") : "not_observed",
    })),
    findings, prompt_edits: [],
  };
}
function finding(id, severity = "low", theme = "speech_patterns", coverage = "none", confidence = "high") {
  return { id, parameter_id: first(theme), title: "Synthetic issue", quote: "um", why_it_matters: "Labelled test rationale.", severity, confidence, prompt_coverage: coverage, coverage_quote: coverage === "none" ? "" : "Ask one question at a time." };
}
function review(value, source = baseline) { return validateEvaluation(JSON.stringify(value), source, prompt, rubric); }

test("all three rubric weights and starter parameters are isolated and versioned", () => {
  assert.equal(config.rubric_version, "1.0.0");
  assert.deepEqual(config.use_cases.map(item => config.themes.map(theme => item.weights[theme.id])), [[25,25,20,20,10],[25,15,20,30,10],[35,25,15,15,10]]);
  const ids = config.use_cases.map(item => new Set(item.parameters.map(parameter => parameter.id)));
  assert.ok(ids.every((set, i) => [...set].every(id => !ids.some((other, j) => j !== i && other.has(id)))));
  assert.equal(preferredModel([{id:"ultravox-v0.7"},{id:"ultravox-v0.6"}]), "ultravox-v0.6");
  assert.equal(preferredModel([{id:"another-model"}]), "another-model");
});

test("no findings yields 100 only when enough themes were actually observed", () => {
  const result = review(response());
  assert.equal(result.computedScores.overall, 100);
  assert.equal(result.computedScores.band, "Strong");
  assert.equal(result.computedScores.assessedThemes, 2);
  assert.equal(review(response([], [])).computedScores.overall, null);
});

test("one low finding uses server-only severity/confidence/coverage maths", () => {
  const result = review({ ...response([finding("one")]), score: 7 });
  assert.equal(result.computedScores.overall, 98);
  assert.equal(result.computedScores.themes.find(theme => theme.id === "speech_patterns").score, 96);
  assert.equal(result.computedScores.penalties[0].penalty, 4);
  assert.ok(result.validationFlags.some(flag => /Model-supplied/.test(flag.message)));
});

test("several findings accumulate within one theme before weighting", () => {
  const result = review(response([finding("a","high"),finding("b","medium"),finding("c","low")]));
  assert.equal(result.computedScores.themes.find(theme => theme.id === "speech_patterns").score, 66);
  assert.equal(result.computedScores.overall, 85);
});

test("unobserved themes are excluded and weights are re-normalized", () => {
  const result = review(response([finding("one")])).computedScores;
  assert.equal(result.assessedWeightTotal, 45);
  assert.equal(result.themes.find(theme => theme.id === "clinical_terms").score, null);
  assert.equal(result.themes.find(theme => theme.id === "clinical_terms").status, "Not assessed in this excerpt");
  assert.equal(result.themes.find(theme => theme.id === "speech_patterns").effectiveWeight, "20/45");
});

test("verified critical none/partial coverage caps overall at 55; full coverage does not", () => {
  for (const coverage of ["none","partial"]) {
    const result = review(response([finding("critical","critical","safety_escalation",coverage)], ["safety_escalation","clinical_terms"])).computedScores;
    assert.equal(result.overall, 55);
    assert.equal(result.safetyCriticalGap, true);
    assert.equal(result.band, "Needs work");
  }
  const full = review(response([finding("full","critical","safety_escalation","full")], ["safety_escalation","clinical_terms"])).computedScores;
  assert.equal(full.overall, 95);
  assert.equal(full.safetyCriticalGap, false);
});

test("fewer than two assessed themes produces no overall score", () => {
  const result = review(response([finding("one")], ["speech_patterns"])).computedScores;
  assert.equal(result.overall, null);
  assert.equal(result.band, null);
  assert.match(result.noOverallReason, /Fewer than two/);
});

test("partial transcripts produce provisional evidence coverage without editing source text", () => {
  const partial = { ...baseline, status: "partial", outputPartial: true };
  const result = review(response(), partial).computedScores;
  assert.equal(result.provisional, true);
  assert.equal(result.evidenceCoverage.transcriptStatus, "partial");
  assert.equal(result.evidenceCoverage.wordCount, 5);
  assert.equal(result.evidenceCoverage.excerptLengthMs, 15000);
  assert.equal(partial.rawOutput, baseline.rawOutput);
});

test("unverified quotes score zero and cannot trigger a critical cap", () => {
  const fake = { ...finding("fake", "critical", "safety_escalation"), quote: "not in transcript" };
  const result = review(response([fake]));
  assert.equal(result.unverifiedFindings.length, 1);
  assert.equal(result.unverifiedFindings[0].quote, "not in transcript");
  assert.equal(result.computedScores.penalties[0].penalty, 0);
  assert.equal(result.computedScores.overall, 100);
  assert.equal(result.computedScores.safetyCriticalGap, false);
});

test("a false coverage quote downgrades coverage to none and is flagged", () => {
  const value = { ...finding("false-coverage", "critical", "safety_escalation", "full"), coverage_quote: "Not in this prompt." };
  const result = review(response([value]));
  assert.equal(result.verifiedFindings[0].prompt_coverage, "none");
  assert.equal(result.computedScores.overall, 55);
  assert.ok(result.validationFlags.some(flag => /Coverage quote not found/.test(flag.message)));
});

test("at most three model-proposed parameters are retained; excess stays visibly dropped", () => {
  const value = response();
  value.parameters.push(...[1,2,3,4].map(n => ({id:`extra-${n}`,theme:"speech_patterns",observed:true,status:"ok",label:"Test proposal"})));
  const result = review(value);
  assert.equal(result.parsedResult.parameters.filter(parameter => parameter.modelProposed).length, 3);
  assert.ok(result.droppedItems.some(item => item.id === "extra-4"));
});

test("fractional penalties accumulate exactly before whole-number score rounding", () => {
  const result = review(response([1,2,3,4,5,6].map(n => finding(String(n),"low","speech_patterns","none","medium")))).computedScores;
  assert.equal(result.themes.find(theme => theme.id === "speech_patterns").penaltyHundredths, 1680);
  assert.equal(result.themes.find(theme => theme.id === "speech_patterns").score, 83);
  assert.ok(result.penalties.every(item => Number.isInteger(item.penalty) && Number.isInteger(item.penaltyHundredths)));
});

test("unparseable evaluator output never produces a score", () => {
  const result = validateEvaluation("invalid JSON", baseline, prompt, rubric);
  assert.equal(result.computedScores, null);
  assert.equal(result.parsedResult, null);
  assert.match(result.parseError, /couldn't finish this evaluation/);
});
