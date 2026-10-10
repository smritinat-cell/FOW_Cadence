const { diffLines } = require("diff");

const EVALUATOR_PROMPT = "you are a careful reviewer of speech transcripts for voice agents. You receive the agent's purpose, speech profile tags, current system prompt, and a transcript of the kind of speech the agent will hear. There is no reference transcript, so never claim to measure word accuracy. Surface issues that could make this agent misunderstand or mishandle this speaker: likely misheard or implausible words, garbled passages, uncertain medication, symptom, body-part or safety-critical terms, fillers, repetitions, false starts or trailing sentences that change meaning, overlapping or unattributed speakers, child mispronunciations or made-up words, and situations the current prompt gives no guidance for. Then propose targeted edits to the system prompt that help the agent handle these, keeping its role, safety and escalation rules intact and never weakening them. Base every issue on text actually in the transcript, quote it exactly, never invent content, and say so if there are few or no issues. Reply with one JSON object only, no commentary or fences: a short summary; issues (id, severity high/medium/low, category, title, exact quote, one sentence on why it matters); and prompt edits (id, issue ids addressed, one-sentence rationale, type insert-after/replace/append, exact anchor sentence from the current prompt when needed, new text).";

function evaluatorInput(context, transcript) {
  return `AGENT NAME:\n${context.agentName}\n\nAGENT PURPOSE:\n${context.purpose}\n\nSPEECH PROFILE TAGS:\n${context.speechProfileTags.join("\n")}\n\nCURRENT SYSTEM PROMPT (EXACT EDITOR CONTENTS):\n${context.systemPrompt}\n\nRAW BASELINE TRANSCRIPT:\n${transcript}`;
}

function lineDiff(current, suggested) {
  return diffLines(current, suggested).flatMap(part => {
    const lines = part.value.endsWith("\n") ? part.value.slice(0, -1).split("\n") : part.value.split("\n");
    return lines.map(text => ({ type: part.added ? "added" : part.removed ? "removed" : "context", text }));
  });
}

function applyEdits(current, edits) {
  let suggested = current;
  const unappliedEdits = [];
  const appliedEditIds = [];
  for (const edit of edits) {
    let reason;
    if (!["insert-after", "replace", "append"].includes(edit.type) || typeof edit.newText !== "string" || !edit.newText.length) {
      reason = "Unsupported edit type or missing new text.";
    } else if (edit.type !== "append") {
      if (!edit.anchor || !suggested.includes(edit.anchor)) reason = "Anchor not found in the current prompt.";
      else if (suggested.indexOf(edit.anchor) !== suggested.lastIndexOf(edit.anchor)) reason = "Anchor occurs more than once; placement is ambiguous.";
      else if (edit.type === "replace" && /(^You are|\bnever\b|\bdo not\b|emergency|self.harm|suicid|988|abuse|overdose|poisoning|escalat|not a clinician)/i.test(edit.anchor) && !edit.newText.includes(edit.anchor)) {
        reason = "Replacement would remove protected role, safety or escalation text.";
      }
    }
    if (reason) { unappliedEdits.push({ ...edit, reason }); continue; }
    if (edit.type === "append") suggested += `${suggested ? "\n" : ""}${edit.newText}`;
    else if (edit.type === "insert-after") suggested = suggested.replace(edit.anchor, () => `${edit.anchor}\n${edit.newText}`);
    else suggested = suggested.replace(edit.anchor, () => edit.newText);
    appliedEditIds.push(edit.id);
  }
  return { suggestedPrompt: suggested, unappliedEdits, appliedEditIds, diff: lineDiff(current, suggested) };
}

const string = value => typeof value === "string" ? value : "";
const identifier = value => typeof value === "string" || typeof value === "number" ? String(value) : "";
function parseEvaluation(raw, transcript, currentPrompt) {
  const validationFlags = [];
  let value;
  try {
    let candidate = raw.trim();
    if (/^```(?:json)?\s/i.test(candidate) && candidate.endsWith("```")) {
      candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
      validationFlags.push({ message: "Evaluator response contained a Markdown fence." });
    }
    value = JSON.parse(candidate);
    const edits = value.promptEdits ?? value.prompt_edits ?? value["prompt edits"];
    if (!value || Array.isArray(value) || typeof value.summary !== "string" || !Array.isArray(value.issues) || !Array.isArray(edits)) throw new Error();
    if (value.issues.length > 200 || edits.length > 200) throw new Error();
    const issues = value.issues.map((issue, i) => {
      if (!issue || typeof issue !== "object") throw new Error();
      const quote = issue.quote ?? issue.exactQuote ?? issue.exact_quote;
      if (typeof quote !== "string") throw new Error();
      const normalized = {
        id: identifier(issue.id) || `issue-${i + 1}`,
        severity: string(issue.severity),
        category: string(issue.category),
        title: string(issue.title),
        quote,
        why: string(issue.why ?? issue.whyItMatters ?? issue.why_it_matters ?? issue["why it matters"] ?? issue.explanation),
      };
      if (!normalized.quote || !transcript.includes(normalized.quote)) validationFlags.push({ issueId: normalized.id, message: "Quote not found in transcript" });
      if (!["high", "medium", "low"].includes(normalized.severity)) validationFlags.push({ issueId: normalized.id, message: "Unrecognized severity." });
      return normalized;
    });
    const promptEdits = edits.map((edit, i) => {
      if (!edit || typeof edit !== "object") throw new Error();
      const issueIds = edit.issueIds ?? edit.issue_ids ?? edit.issue_ids_addressed ?? edit.issues_addressed ?? edit["issue ids addressed"];
      return {
        id: identifier(edit.id) || `edit-${i + 1}`,
        issueIds: Array.isArray(issueIds) ? issueIds.map(identifier).filter(Boolean) : [],
        rationale: string(edit.rationale),
        type: string(edit.type),
        anchor: string(edit.anchor ?? edit.anchorSentence ?? edit.anchor_sentence),
        newText: string(edit.newText ?? edit.new_text),
      };
    });
    return {
      parsedResponse: value,
      parsedResult: { summary: value.summary, issues, promptEdits },
      validationFlags,
      parseError: null,
      ...applyEdits(currentPrompt, promptEdits),
    };
  } catch {
    return { parsedResult: null, validationFlags, parseError: "We couldn't finish this evaluation. Please try again.", suggestedPrompt: null, unappliedEdits: [], diff: [] };
  }
}

module.exports = { EVALUATOR_PROMPT, evaluatorInput, parseEvaluation, applyEdits, lineDiff };
