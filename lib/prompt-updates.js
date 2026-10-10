const { diffLines } = require("diff");
const LIMIT = 20000;
const categories = new Map([
  ["guardrail", "guardrail"], ["clarification behaviour", "clarification behaviour"],
  ["clarification behavior", "clarification behaviour"], ["clarification_behaviour", "clarification behaviour"],
  ["terminology", "terminology"], ["speech-pattern handling", "speech-pattern handling"],
  ["speech_pattern_handling", "speech-pattern handling"], ["speaker handling", "speaker handling"],
  ["speaker_handling", "speaker handling"],
]);
const text = value => typeof value === "string" ? value : "";
const identifier = value => typeof value === "string" || typeof value === "number" ? String(value) : "";
const protectedRule = sentence => /(^\s*(?:You are|Your job)\b|\bnever\b|\bdo not\b|not a clinician|emergency|escalat|self.harm|suicid|988|abuse|unsafe.home|overdose|poison|seizure|chest pain|severe bleeding|loss of consciousness|trouble breathing)/i.test(sentence);
const sentences = prompt => prompt.split(/(?<=[.!?])\s+|[\r\n]+/).map(sentence => sentence.trim()).filter(Boolean);
const normalized = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const { editEvidence, relevantCoverage } = require("./speech-patterns");
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function exactLineDiff(before, after) {
  if (after.startsWith(before)) {
    return [
      ...(before.match(/[^\n]*\n|[^\n]+$/g) || []).map(text => ({ type: "context", text })),
      ...(after.slice(before.length).match(/[^\n]*\n|[^\n]+$/g) || []).map(text => ({ type: "added", text }))
    ];
  }
  return diffLines(before, after).flatMap(part => (part.value.match(/[^\n]*\n|[^\n]+$/g) || []).map(line => ({
    type: part.added ? "added" : part.removed ? "removed" : "context", text: line,
  })));
}

function personalDetails(transcript) {
  const details = new Set();
  const patterns = [
    /\b(?:my name is|name\s*:|caller is|patient is)\s+([\p{L}]+(?:\s+[A-Z][\p{L}]+)?)/giu,
    /\b(?:I'm|I am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?=[,.!?]|$)/g,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?):/g,
    /\b(?:school|live|living)\b.{0,25}\b(?:in|at)\s+([A-Z][\p{L}]+(?:\s+[A-Z][\p{L}]+)?)/gu,
    /\b(?:age(?: is)?|I am|I'm)\s+(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen)\s*(?:years? old|year-old|[,.!?]|$)/gi,
  ];
  for (const pattern of patterns) for (const match of transcript.matchAll(pattern)) {
    if (!/^(?:Child|Adult|Parent|Caregiver|Patient|Caller|Nurse|Doctor|Speaker|Agent|User|Test)$/i.test(match[1])) {
      details.add(match[1]);
      for (const token of match[1].split(/\s+/)) if (!/^(?:and|the|a|an|is|am|at|in|old)$/i.test(token)) details.add(token);
    }
  }
  const direct = [
    /\+?\d[\d\s().-]{6,}\d/g,
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g,
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?/gi,
    /\b\d{1,5}\s+(?:[\p{L}]+\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr)\b/giu,
    /\b\d{1,3}\s*(?:years? old|year-old|y\d{1,2}m)\b/gi,
  ];
  for (const pattern of direct) for (const match of transcript.matchAll(pattern)) details.add(match[0]);
  return [...details];
}

function unsafeAddition(added) {
  if (/\b(?:ignore|skip|bypass|disable|relax|weaken|postpone|defer)\b.{0,100}\b(?:safety|escalat|emergency|allerg|self.harm|suicid|988)/i.test(added)) return true;
  if (/\b(?:do not|don't|never|no need to|need not)\s+(?:escalate|call emergency|contact emergency|route to emergency|flag.{0,20}urgent)/i.test(added)) return true;
  if (/\b(?:not|isn't|is not)\s+(?:an?\s+)?emergency|wait.{0,30}(?:before|instead of).{0,30}(?:escalat|emergency)/i.test(added)) return true;
  const medicalAdvice = /\b(?:give|take|administer|increase|decrease|prescribe|recommend)\b.{0,35}\b(?:mg|milligrams?|dose|medicine|medication|treatment)\b/gi;
  for (const match of added.matchAll(medicalAdvice)) {
    if (!/\b(?:do not|don't|never)\s*$/.test(added.slice(Math.max(0, match.index - 15), match.index).toLowerCase())) return true;
  }
  return false;
}

function buildPromptUpdates(currentPrompt, edits, review, transcript, referenceMaterial = "") {
  const validationFlags = [], unappliedEdits = [];
  const flag = (editId, message) => validationFlags.push({ editId, message });
   const verified = new Map((review.verifiedFindings || []).map(finding => [finding.id, finding]));
   const penalties = new Map((review.computedScores?.penalties || []).map(penalty => [penalty.findingId, penalty.penaltyHundredths]));
  const protectedSentences = sentences(currentPrompt).filter(protectedRule);
  const anchors = new Set(sentences(currentPrompt));
  const details = personalDetails(transcript);
  const ids = new Set(), eligible = [];
  for (const [index, input] of (Array.isArray(edits) ? edits.slice(0, 100) : []).entries()) {
    const edit = {
      id: identifier(input?.id) || `edit-${index + 1}`, category: categories.get(input?.category) || text(input?.category),
      addresses: [...new Set((Array.isArray(input?.addresses) ? input.addresses : []).map(identifier).filter(Boolean))],
      rationale: text(input?.rationale), type: text(input?.type).replace("insert-after", "insert_after"),
      anchor: text(input?.anchor), new_text: text(input?.new_text ?? input?.newText),
      expected_effect: text(input?.expected_effect), verify_by: text(input?.verify_by),
      priorityPoints: 0, priorityHundredths: 0, applied: false,
    };
    edit.priorityHundredths = edit.addresses.reduce((sum, id) => sum + (penalties.get(id) || 0), 0);
    edit.priorityPoints = Math.round(edit.priorityHundredths / 100);
    const addressed = edit.addresses.map(id => verified.get(id)).filter(Boolean);
    Object.assign(edit, editEvidence(addressed, review.evidenceMetrics?.keyItemsTotal));
    let reason;
    if (ids.has(edit.id)) reason = "This change appears more than once.";
    ids.add(edit.id);
    if (!categories.has(edit.category)) reason ||= "We couldn't understand this kind of change.";
    if (!["insert_after", "replace", "append"].includes(edit.type) || !edit.new_text.trim()) reason ||= "We couldn't read this change.";
    if (!edit.addresses.length || edit.addresses.some(id => !verified.has(id) || verified.get(id).prompt_coverage === "full")) reason ||= "This change isn't supported by a finding that needs attention.";
    if (addressed.some(finding => finding.patternAware) && !relevantCoverage(edit.speechPattern, edit.new_text)) reason ||= "This change needs guidance for recognizing the speech pattern, not just general politeness.";
    if (!edit.rationale || !edit.expected_effect || !edit.verify_by) reason ||= "This change needs an explanation and a way to check it.";
    const added = edit.anchor && edit.new_text.includes(edit.anchor) ? edit.new_text.replace(edit.anchor, "") : edit.new_text;
    if (edit.type === "replace" && protectedRule(edit.anchor) && !edit.new_text.includes(edit.anchor)) reason ||= "This change would alter your agent's role or safety instructions.";
    if (unsafeAddition(added)) reason ||= "This change could weaken safety instructions or add treatment advice.";
    if (details.some(detail => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(detail)}(?![\\p{L}\\p{N}])`, "iu").test(added))) reason ||= "This change includes a personal detail. Describe the situation generally instead.";
    if (normalized(added) && normalized(currentPrompt).includes(normalized(added))) reason ||= "This guidance is already present in the current prompt.";
    if (edit.category === "terminology") {
      const terms = [...added.matchAll(/["“'`]([^"”'`\n]+)["”'`]/g)].map(match => match[1]);
      if (!terms.length) reason ||= "Put specific terms in quotation marks so they can be checked.";
      else if (terms.some(term => !transcript.toLowerCase().includes(term.toLowerCase()) && !referenceMaterial.toLowerCase().includes(term.toLowerCase()))) reason ||= "This term wasn't found in the transcript or your reference material.";
    }
    for (const sentence of sentences(added)) {
      if (/\b(?:clinic|practice|hospital|protocol)\b.{0,45}\b(?:has|uses|requires|provides|policy|open|closed|offers)\b/i.test(sentence)
        && !currentPrompt.includes(sentence) && !referenceMaterial.includes(sentence)) reason ||= "This change adds a detail about the clinic that couldn't be confirmed.";
    }
    if (reason) { unappliedEdits.push({ ...edit, reason }); flag(edit.id, reason); }
    else eligible.push({ ...edit, index });
  }
  eligible.sort((a, b) => b.priorityHundredths - a.priorityHundredths || a.index - b.index);
  const selected = eligible.slice(0, 6);
  for (const edit of eligible.slice(6)) {
    const reason = "Only six changes can be suggested at once. Changes addressing bigger concerns were kept.";
    unappliedEdits.push({ ...edit, reason }); flag(edit.id, reason);
  }
  let suggestedPrompt = currentPrompt;
  const usedAnchors = new Set(), promptUpdates = [];
  for (const edit of selected) {
    let reason;
    if (edit.type !== "append") {
      if (!edit.anchor || !suggestedPrompt.includes(edit.anchor)) reason = "The sentence for this change couldn't be found.";
      else if (!anchors.has(edit.anchor)) reason = "This change needs a complete sentence from your prompt.";
      else if (usedAnchors.has(edit.anchor)) reason = "Another change already updates this sentence.";
      else if (suggestedPrompt.indexOf(edit.anchor) !== suggestedPrompt.lastIndexOf(edit.anchor)) reason = "This sentence appears more than once, so the change couldn't be placed.";
    }
    if (reason) { unappliedEdits.push({ ...edit, reason }); flag(edit.id, reason); continue; }
    if (edit.type === "append") suggestedPrompt += `${suggestedPrompt ? "\n" : ""}${edit.new_text}`;
    else if (edit.type === "insert_after") suggestedPrompt = suggestedPrompt.replace(edit.anchor, () => `${edit.anchor}\n${edit.new_text}`);
    else suggestedPrompt = suggestedPrompt.replace(edit.anchor, () => edit.new_text);
    if (edit.type !== "append") usedAnchors.add(edit.anchor);
    promptUpdates.push({ ...edit, applied: true });
  }
  let protectedOffset = 0;
  let protectionLost = false;
  for (const sentence of protectedSentences) {
    const at = suggestedPrompt.indexOf(sentence, protectedOffset);
    if (at < 0) { protectionLost = true; break; }
    protectedOffset = at + sentence.length;
  }
  if (suggestedPrompt.length > LIMIT || protectionLost) {
    const reason = suggestedPrompt.length > LIMIT ? "These changes would make your prompt longer than 20,000 characters." : "These changes would remove or reorder your agent's role or safety instructions.";
    for (const edit of promptUpdates) unappliedEdits.push({ ...edit, applied: false, reason });
    flag(null, reason);
    return { promptUpdates: [], unappliedEdits, validationFlags, promptUpdateSetRejected: true, suggestedPrompt: null, diff: [] };
  }
  return { promptUpdates: promptUpdates.map(({ index, ...edit }) => edit), unappliedEdits, validationFlags, promptUpdateSetRejected: false, suggestedPrompt, diff: exactLineDiff(currentPrompt, suggestedPrompt) };
}

module.exports = { buildPromptUpdates, exactLineDiff, personalDetails };
