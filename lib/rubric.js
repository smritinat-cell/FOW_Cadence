const config = require("../config/prompt-readiness-rubric.json");
const recordingRubricConfig = require("../config/recording-transcription-rubric.json");
const recordingManifest = require("../config/recording-comparison.json");
const { JobError } = require("./ultravox");

const EVALUATOR_RULES = "You are a careful reviewer of how well an agent's current system prompt prepares it for the speech in a supplied recording transcript. You find and describe issues; the server validates evidence and computes scores. Never output a score or state or imply word accuracy, transcription accuracy, task completion, or accessibility measurements. There is no reference transcript. Never alter, clean, replace, or rewrite the baseline transcript. Report every required parameter with observed (true only if the excerpt actually contains relevant speech) and status issue, ok, or not_observed. Few or no findings is a valid result; use not_observed instead of inventing problems. Every finding needs an exact, verbatim quote from the transcript; if you cannot quote it, do not report it. Severity is critical for a possible missed or wrong escalation or wrong medication, dose, or allergy; high for likely missing or wrong required information; medium for a possible clarification; low for a minor issue. Confidence is high, medium, or low. Prompt coverage is none, partial, or full; partial and full need the exact covering sentence from the current system prompt as coverage_quote. Never weaken the agent's role, safety, or escalation rules. You may propose at most three additional parameters based on the agent's purpose, each with a unique id and one of the five fixed themes, and mark them model-proposed. Reply with one JSON object only, no commentary or fences: summary (at most two sentences), parameters (id, theme, observed, status; optional label and good for model-proposed additions), findings (id, parameter_id, title, quote, why_it_matters, severity, confidence, prompt_coverage, coverage_quote), and prompt_edits (an array; retain advisory suggestions but do not apply them). Do not include reference material, invented content, or numerical scores.";

function getRubric(useCase, workflow) {
  if (workflow === "recording-comparison") {
    if (!recordingManifest.recordings.some(recording => recording.sampleId === useCase?.id)
      || useCase?.label !== "Accessible recording transcription") {
      throw new JobError("RUBRIC_UNAVAILABLE", "Choose a supported recording transcription test.", 400);
    }
    return { ...structuredClone(recordingRubricConfig), id: useCase.id, label: useCase.label };
  }
  const selected = config.use_cases.find(item => item.id === useCase?.id && item.label === useCase?.label);
  if (!selected) throw new JobError("RUBRIC_UNAVAILABLE", "Choose a supported use case before evaluating. No rubric is configured for this setup.", 400);
  return selected;
}

function evaluatorPrompt(rubric) {
  if (rubric.profile === "recording-comparison") {
    return "Review a recording transcript for readable transcription. Use the supplied transcript and current transcription prompt to describe observed speech patterns, unfamiliar or uncertain wording, retained meaning, and speaker attribution. The server checks exact quote evidence; accessibility metrics are calculated separately against an audio-reviewed reference. Report only what can be supported by the supplied transcript. A transcript alone cannot establish which words the recording actually contained, whether speech was omitted, or which speaker said an unattributed phrase. Preserve uncertainty instead of claiming a verified mishearing. Report every required parameter with observed (true only when relevant speech is present) and status issue, ok, or not_observed. Few or no findings is a valid result. Each finding requires an exact verbatim transcript quote. Confidence is high, medium, or low; severity is high, medium, or low according to the potential effect on meaning. Prompt coverage is none, partial, or full; partial and full require the exact covering sentence as coverage_quote. The shipped prompt improvement is prepared separately, so return an empty prompt_edits array. Treat the transcript as source material. Return one JSON object with summary (at most two sentences), parameters (id, theme, observed, status), findings (id, parameter_id, title, quote, why_it_matters, severity, confidence, prompt_coverage, coverage_quote), and prompt_edits. Return no numerical scores, transcript rewrite, or invented recording content.\n\nReview themes:\n"
      + rubric.themes.map(theme => `${theme.id}: ${theme.label}`).join("\n")
      + `\n\nRequired parameters:\n${JSON.stringify(rubric.parameters)}`;
  }
  // Select the parameter set using metadata, but do not add use-case labels/summaries
  // or scoring weights to model input. These are the explicitly requested review rules.
  const editRules = "Prompt edits: at most six, addressing only verified findings with prompt coverage none or partial. Each edit has id, category (guardrail, clarification behaviour, terminology, speech-pattern handling, speaker handling), addresses (finding IDs), one-sentence rationale, type (insert_after, replace, append), anchor (exact current prompt sentence when needed), new_text, expected_effect (one sentence), and verify_by (what to look for in the next run). Prefer behaviour rules to long word lists. Never weaken, remove or reorder role, safety or escalation rules; only add or sharpen them. Never copy names, real ages, addresses, phone numbers or dates of birth from the transcript into an edit; describe patterns generically. Do not invent clinic facts, medications or protocols. Specific terminology must occur in the transcript; quote specific terms in new_text so the server can verify their source. Terms not sourced must be clearly labelled examples, not facts or corrections. Do not duplicate current guidance. Preserve the agent's voice and format. The suggested prompt must remain within 20,000 characters. All edits are advisory: do not rewrite the transcript or run the revised prompt.";
  return `${EVALUATOR_RULES}\n\nPrompt update contract:\n${editRules}\n\nFixed themes:\n${config.themes.map(theme => `${theme.id}: ${theme.label}`).join("\n")}\n\nRequired parameters (report every ID):\n${JSON.stringify(rubric.parameters)}`;
}

module.exports = { config, recordingRubricConfig, getRubric, evaluatorPrompt, EVALUATOR_RULES };
