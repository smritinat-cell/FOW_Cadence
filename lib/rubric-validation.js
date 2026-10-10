const { config } = require("./rubric");
const { computeScores } = require("./readiness-score");
const { attachFindingEvidence } = require("./speech-patterns");
const identifier = value => typeof value === "string" || typeof value === "number" ? String(value) : "";
const text = value => typeof value === "string" ? value : "";
const validTheme = value => config.themes.some(theme => theme.id === value);

function validateEvaluation(raw, baseline, currentPrompt, rubric) {
  const validationFlags = [], droppedItems = [], unverifiedFindings = [], verifiedFindings = [];
  const flag = (message, data = {}) => validationFlags.push({ ...data, message });
  let value;
  try {
    let candidate = raw.trim();
    if (/^```(?:json)?\s/i.test(candidate) && candidate.endsWith("```")) {
      candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
      flag("Evaluator output contained a Markdown fence.");
    }
    value = JSON.parse(candidate);
    if (!value || Array.isArray(value) || typeof value.summary !== "string" || !Array.isArray(value.parameters) || !Array.isArray(value.findings)) throw new Error();
    if (value.parameters.length > 300 || value.findings.length > 500) throw new Error();
    if (value.summary.split(/(?<=[.!?])\s+/).length > 2) flag("Summary exceeds the two-sentence contract.");
    if (Object.keys(value).some(key => /score|accuracy|completion/i.test(key))) flag("Model-supplied score or measurement fields were ignored.");
  } catch {
    return {
      parsedResult: null, rawParsedResult: null, validationFlags, droppedItems,
      verifiedFindings, unverifiedFindings, computedScores: null,
      parseError: "We couldn't finish this evaluation. Please try again.",
      suggestedPrompt: null, promptUpdates: [], unappliedEdits: [], diff: [],
    };
  }
  const parameters = new Map(rubric.parameters.map(parameter => [parameter.id, {
    ...parameter, observed: false, status: "not_observed", modelProposed: false,
  }]));
  const reported = new Set();
  const proposed = new Set();
  const addProposed = (id, input = {}) => {
    if (proposed.size >= config.maximum_model_proposed_parameters) {
      const reason = "More than three model-proposed parameters; this additional parameter was dropped.";
      droppedItems.push({ kind: "parameter", id, reason });
      flag(reason, { parameterId: id });
      return null;
    }
    proposed.add(id);
    const parameter = {
      id, theme: validTheme(input.theme) ? input.theme : null,
      label: text(input.label) || "Additional check", good: text(input.good),
      observed: false, status: "not_observed", modelProposed: true,
    };
    parameters.set(id, parameter);
    if (!parameter.theme) flag("Model-proposed parameter has no valid fixed theme and cannot be scored.", { parameterId: id });
    return parameter;
  };
  for (const input of value.parameters) {
    const id = identifier(input?.id);
    if (!id) { flag("Parameter without an ID was dropped."); continue; }
    if (reported.has(id)) { flag("Duplicate parameter ID was ignored.", { parameterId: id }); continue; }
    reported.add(id);
    const parameter = parameters.get(id) || addProposed(id, input);
    if (!parameter) continue;
    if (!parameter.modelProposed && input.theme !== parameter.theme) flag("Reported theme differs from the configured theme; the configured theme was retained.", { parameterId: id });
    parameter.observed = input.observed === true && !!parameter.theme;
    parameter.status = ["issue", "ok", "not_observed"].includes(input.status) ? input.status : "not_observed";
    if (typeof input.observed !== "boolean") flag("Observed must be true or false; invalid value treated as false.", { parameterId: id });
    if (!["issue", "ok", "not_observed"].includes(input.status)) flag("Unrecognized parameter status was treated as not_observed.", { parameterId: id });
    if (parameter.observed && parameter.status === "not_observed") {
      parameter.observed = false;
      flag("Conflicting observed/not_observed values were conservatively treated as not observed.", { parameterId: id });
    } else if (!parameter.observed && parameter.status !== "not_observed") {
      parameter.reportedStatus = parameter.status;
      parameter.status = "not_observed";
      flag("A parameter marked unobserved cannot have issue/ok status; treated as not_observed.", { parameterId: id });
    }
  }
  for (const parameter of rubric.parameters) {
    if (!reported.has(parameter.id)) flag("Required parameter was not reported; treated as not_observed.", { parameterId: parameter.id });
  }
  const findingIds = new Set();
  for (const input of value.findings) {
    const id = identifier(input?.id);
    const parameterId = identifier(input?.parameter_id ?? input?.parameterId);
    if (!id || findingIds.has(id)) {
      const reason = id ? "Duplicate finding ID was dropped to avoid duplicate penalties." : "Finding without an ID was dropped.";
      droppedItems.push({ kind: "finding", id, reason }); flag(reason, { findingId: id }); continue;
    }
    findingIds.add(id);
    let parameter = parameters.get(parameterId);
    if (!parameter && parameterId) parameter = addProposed(parameterId, input);
    if (!parameter && parameterId) {
      const reason = "Finding refers to a parameter outside the model-proposed addition limit.";
      droppedItems.push({ kind: "finding", id, reason }); flag(reason, { findingId: id }); continue;
    }
    const finding = {
      id, parameter_id: parameterId, theme: parameter?.theme || null,
      parameterLabel: parameter?.label || parameterId, modelProposed: !!parameter?.modelProposed,
      title: text(input.title), quote: text(input.quote), why_it_matters: text(input.why_it_matters ?? input.why),
      severity: text(input.severity), confidence: text(input.confidence),
      prompt_coverage: text(input.prompt_coverage), coverage_quote: text(input.coverage_quote),
    };
    const reasons = [];
    if (!finding.quote || !baseline.rawOutput.includes(finding.quote)) reasons.push("Quote not found in transcript");
    if (!Object.hasOwn(config.severity_points, finding.severity)) reasons.push("Unrecognized severity; cannot calculate a penalty.");
    if (!Object.hasOwn(config.confidence_percent, finding.confidence)) reasons.push("Unrecognized confidence; cannot calculate a penalty.");
    if (!Object.hasOwn(config.coverage_percent, finding.prompt_coverage)) {
      finding.original_prompt_coverage = finding.prompt_coverage;
      finding.prompt_coverage = "none";
      finding.original_coverage_quote = finding.coverage_quote;
      finding.coverage_quote = "";
      flag("Unrecognized prompt coverage was downgraded to none.", { findingId: id });
    }
    if (["partial", "full"].includes(finding.prompt_coverage) && (!finding.coverage_quote || !currentPrompt.includes(finding.coverage_quote))) {
      finding.original_prompt_coverage = finding.prompt_coverage;
      finding.prompt_coverage = "none";
      flag("Coverage quote not found verbatim in the current prompt; coverage downgraded to none.", { findingId: id });
    }
    attachFindingEvidence(finding, input, baseline, currentPrompt, flag);
    if (!parameter?.theme || !parameter.observed) reasons.push("Parameter was not validly declared observed; finding cannot be scored.");
    if (reasons.length) {
      finding.verified = false;
      finding.unverifiedReasons = reasons;
      finding.penalty = 0;
      unverifiedFindings.push(finding);
      for (const reason of reasons) flag(reason, { findingId: id });
    } else {
      finding.verified = true;
      verifiedFindings.push(finding);
    }
  }
  const normalizedParameters = [...parameters.values()];
  const promptEdits = value.prompt_edits ?? value.promptEdits;
  if (!Array.isArray(promptEdits)) flag("prompt_edits was missing or invalid; no edits were accepted.");
  const parsedResult = {
    summary: value.summary, parameters: normalizedParameters,
    findings: [...verifiedFindings, ...unverifiedFindings],
    promptEdits: Array.isArray(promptEdits) ? promptEdits : [],
  };
  return {
    parsedResult, rawParsedResult: value, validationFlags, droppedItems,
    verifiedFindings, unverifiedFindings,
    evidenceMetrics: baseline.metricInputSnapshot ? require("./performance").performance(baseline.rawOutput, baseline.metricInputSnapshot) : null,
    computedScores: computeScores(rubric, normalizedParameters, verifiedFindings, baseline, unverifiedFindings),
    parseError: null, suggestedPrompt: null, promptUpdates: [], unappliedEdits: [], diff: [],
  };
}

module.exports = { validateEvaluation };
