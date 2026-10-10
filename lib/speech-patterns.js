const { performance, tokens, metricInputs } = require("./performance");
const transcriptPreset = require("../config/transcript-improvement.json");

const PATTERNS = [
  ["Stuttering", /stutt|stammer|disfluen/i, /stutt|stammer|disfluen|repetitions?|repeated (?:words|sounds|syllables)|restart|fillers|prolong|blocks|cut.{0,12}off|interrupt/i],
  ["Word repetitions", /word repetitions?|repeated words/i, /repetitions?|repeated words|restart|fillers|finish|interrupt/i],
  ["Sound repetitions", /sound repetitions?|syllable repetitions?|repeated sounds/i, /repetitions?|repeated (?:sounds|syllables)|stutter|completed wording/i],
  ["Sound substitutions", /substitut|r\/l|l\/r|articulat|mispronoun/i, /substitut|pronounc|articulat|spoken variant|sounds?|r\/l|l\/r/i],
  ["Accent or dialect", /accent|dialect/i, /accent|dialect|regional|pronounc/i],
  ["Involuntary words", /involuntary|tourette|vocal tic/i, /involuntary|vocal tic|intentional|intent|tic/i],
  ["Slow or effortful speech", /slow|effortful|soft|hesitan|longer pauses/i, /effortful|slow speech|soft speech|hesitan|pause|finish|interrupt/i],
  ["Fillers and restarts", /filler|false start|restarted|trailing/i, /filler|restart|trailing|false start|finish|interrupt/i],
  ["Overlapping speech", /overlap|speaker|crosstalk/i, /overlap|speaker|crosstalk|attribut|second voice/i],
  ["Vocabulary and uncertainty", /vocab|uncertain|unfamiliar|unclear/i, /vocab|uncertain|unfamiliar|unclear|audio and context/i],
];
const PROFILE_PATTERNS = new Set(["Stuttering", "Sound substitutions", "Accent or dialect", "Involuntary words", "Slow or effortful speech", "Overlapping speech"]);

function patternName(value) {
  return PATTERNS.find(([, match]) => match.test(String(value || "")))?.[0] || "Speech recognition";
}
function relevantCoverage(pattern, quote) {
  const rule = PATTERNS.find(([name]) => name === pattern);
  // A neutral label still accepts concrete recognition/uncertainty guidance.
  if (rule) return rule[2].test(String(quote || ""));
  const text = String(quote || "");
  const action = /\b(?:mark|preserve|retain|write|record|flag|confirm|clarify|check|ask|use|select|choose|treat|combine|allow|wait|collapse|identify|separate|attribute|transcribe|recognize|recognise)\b/i;
  const specific = /\b(?:unclear|uncertain|ambiguous|unfamiliar|audio|recording|pronunciation|repetitions?|repeated|stutter|hesitation|false starts?|overlap|vocabulary|verbatim|completed wording|evidence.supported)\b/i;
  return action.test(text) && specific.test(text);
}

function analyzeSpeech(transcript, tags = []) {
  const source = String(transcript || ""), entries = tokens(source), words = entries.map(token => token.word);
  const filler = /^(?:um|uh|erm|er|umm|uhh|hmm)$/;
  const fillers = words.filter(word => filler.test(word)).length;
  let wordRepetitions = 0, restartedSentences = 0, previous = "", previousIndex = -10;
  const evidence = [], fillerQuotes = [];
  const addQuote = (start, end) => { const quote = source.slice(start, end); if (quote && !evidence.includes(quote) && evidence.length < 3) evidence.push(quote); };
  for (let i = 0; i < words.length; i++) {
    if (filler.test(words[i])) { fillerQuotes.push(source.slice(entries[i].start, entries[i].end)); continue; }
    if (words[i] === previous && i - previousIndex <= 3) {
      const repeated = source.slice(entries[previousIndex].start, entries[i].end);
      if (!repeated.includes("-")) { wordRepetitions++; addQuote(entries[previousIndex].start, entries[i].end); }
    }
    previous = words[i]; previousIndex = i;
    if (i >= 3 && words[i] === words[i - 2] && words[i - 1] === words[i - 3] && words[i] !== words[i - 1]) {
      restartedSentences++;
      addQuote(entries[i - 3].start, entries[i].end);
    }
  }
  const soundMatches = [...source.matchAll(/\b([a-z]{1,4})-(?:\1-)+[a-z]+\b/gi)];
  const soundRepetitions = soundMatches.reduce((sum, match) => sum + match[0].split("-").length - 2, 0);
  for (const match of soundMatches) addQuote(match.index, match.index + match[0].length);
  const restartMatches = [...source.matchAll(/(?:\.{3}|…|—|--)\s*(?=\w)/g)];
  restartedSentences += restartMatches.length;
  for (const match of restartMatches) addQuote(Math.max(0, match.index - 20), Math.min(source.length, match.index + match[0].length + 20));
  if (!evidence.length && fillerQuotes.length) evidence.push(fillerQuotes[0]);
  const profile = (Array.isArray(tags) ? tags : []).join(" ");
  const patterns = [];
  if (wordRepetitions || soundRepetitions || fillers || restartedSentences) {
    const label = /stutt|stammer/i.test(profile) ? "Stuttering" : wordRepetitions ? "Word repetitions" : soundRepetitions ? "Sound repetitions" : "Fillers and restarts";
    const counts = { wordRepetitions, soundRepetitions, fillers, restartedSentences };
    const labels = { wordRepetitions: "word repetitions", soundRepetitions: "sound repetitions", fillers: "fillers", restartedSentences: "restarted phrases" };
    patterns.push({ id: label.toLowerCase().replaceAll(" ", "-"), label,
      summary: Object.entries(counts).filter(([, count]) => count).map(([key, count]) => `${labels[key]} ×${count}`).join(", "),
      counts, evidence, basis: "transcript", ...(label === "Stuttering" ? { profileSupported: true } : {}) });
  } else if (/stutt|stammer/i.test(profile)) {
    patterns.push({ id: "stuttering", label: "Stuttering", summary: "Supplied speech profile; no repetitions counted in this transcript.", counts: {}, evidence: [], basis: "profile", profileSupported: true });
  }
  for (const [label, match] of PATTERNS) {
    if (!PROFILE_PATTERNS.has(label) || label === "Stuttering" || !match.test(profile)) continue;
    patterns.push({ id: label.toLowerCase().replaceAll(" ", "-"), label, summary: "Supplied speech profile; no occurrences counted from text.", counts: {}, evidence: [], basis: "profile", profileSupported: true });
  }
  return { patterns, basis: "Available transcript and speech profile; text counts are not an acoustic assessment." };
}

function referenceEvidence(evidence) {
  const snapshot = evidence?.metricInputSnapshot || evidence?.referenceInputSnapshot;
  if (!snapshot || typeof snapshot.referenceTranscript !== "string" || !snapshot.referenceTranscript.trim() || !Array.isArray(snapshot.criticalItems)) return null;
  const computed = metricInputs({ reference_transcript: snapshot.referenceTranscript, critical_items: snapshot.criticalItems });
  if (snapshot.version !== computed.version || snapshot.referenceHash !== computed.referenceHash || snapshot.criticalItemsHash !== computed.criticalItemsHash) return null;
  const metadata = snapshot.referenceMetadata;
  if (metadata) {
    if (metadata.verified !== true || !metadata.verifiedBy || !metadata.verifiedAt
      || typeof metadata.sourceAudioSha256 !== "string" || !metadata.sourceAudioSha256
      || !metadata.excerpt || !evidence.excerpt
      || metadata.sourceAudioSha256 !== evidence.audioHashes?.sourceSha256
      || metadata.excerpt?.startOffset !== evidence.excerpt?.startOffset
      || metadata.excerpt?.length !== evidence.excerpt?.length) return null;
    const policy = metricInputs({ reference_transcript: snapshot.referenceTranscript, critical_items: snapshot.criticalItems, reference: metadata });
    if (snapshot.referencePolicyHash !== policy.referencePolicyHash) return null;
  }
  return snapshot;
}

function understanding(result) {
  if (!Number.isInteger(result?.keyItemsTotal)) return { text: "Add a reference transcript to score this recording", assessed: false };
  const missingItems = result.items.filter(item => !item.captured).map(({ id, label }) => ({ id, label }));
  return { assessed: true, missingItems, text: missingItems.length
    ? `The transcript captured ${result.keyItemsCaptured} of ${result.keyItemsTotal} key details; ${missingItems.map(item => item.label).join(", ")} still need attention.`
    : "The transcript captured all key details in the reference." };
}

function attachFindingEvidence(finding, input, evidence, currentPrompt, flag) {
  finding.patternAware = typeof input.speech_pattern === "string" && Boolean(input.speech_pattern.trim());
  finding.speechPattern = patternName(input.speech_pattern || finding.title);
  finding.accessibilityImpact = typeof input.accessibility_impact === "string" ? input.accessibility_impact : finding.why_it_matters;
  const snapshot = referenceEvidence(evidence), reference = snapshot?.referenceTranscript || "";
  const referenceQuote = typeof input.reference_quote === "string" ? input.reference_quote : "";
  finding.referenceVerified = Boolean(referenceQuote.trim() && reference.includes(referenceQuote));
  finding.referenceQuote = finding.referenceVerified ? referenceQuote : "";
  if (finding.patternAware && !finding.referenceVerified) finding.accessibilityImpact = `${finding.speechPattern} may make the completed wording harder to follow. Check the recording to confirm its meaning.`;
  if (referenceQuote && !finding.referenceVerified) {
    flag("Reference quote could not be verified against the matching reference; the claimed comparison was withheld.", { findingId: finding.id });
    finding.accessibilityImpact = "The transcript wording needs confirmation against the recording.";
  }
  const metric = snapshot ? performance(evidence.rawOutput, snapshot) : null;
  const requested = Array.isArray(input.missed_item_ids) ? new Set(input.missed_item_ids.map(String)) : new Set();
  const quotedWords = ` ${tokens(referenceQuote).map(token => token.word).join(" ")} `;
  finding.missedItems = finding.referenceVerified && metric?.items
    ? metric.items.filter(item => requested.has(item.id) && !item.captured && item.phrases.some(phrase => quotedWords.includes(` ${tokens(phrase).map(token => token.word).join(" ")} `)))
      .map(({ id, label }) => ({ id, label })) : [];
  finding.potentialRecoveryPoints = finding.missedItems.length && metric.keyItemsTotal && !evidence.outputPartial && evidence.status !== "partial"
    ? Math.round(50 * finding.missedItems.length / metric.keyItemsTotal) : null;
  if (finding.patternAware) {
    const tags = Array.isArray(evidence?.context?.speechProfileTags) ? evidence.context.speechProfileTags : [];
    const supported = PATTERNS.find(([label]) => label === finding.speechPattern)?.[1].test(tags.join(" ")) || false;
    if (PROFILE_PATTERNS.has(finding.speechPattern) && !supported) {
      flag("Specific speech pattern was not supported by the supplied profile; a neutral recognition label was used.", { findingId: finding.id });
      finding.speechPattern = "Speech recognition";
      finding.accessibilityImpact = finding.referenceVerified ? "The transcript wording differs from the referenced meaning." : "The transcript wording needs confirmation against the recording.";
    }
    finding.title = `${finding.speechPattern}: ${finding.title.replace(/^[^:]+:\s*/, "")}`;
    if (["partial", "full"].includes(finding.prompt_coverage) && !relevantCoverage(finding.speechPattern, finding.coverage_quote)) {
      finding.original_coverage_quote = finding.coverage_quote; finding.original_prompt_coverage = finding.prompt_coverage;
      finding.prompt_coverage = "none"; finding.coverage_quote = "";
      flag("Generic prompt wording does not address this speech pattern; coverage was downgraded.", { findingId: finding.id });
    }
  }
}

function editEvidence(findings, totalItems) {
  const missedItems = [...new Map(findings.flatMap(finding => finding.missedItems || []).map(item => [item.id, item])).values()];
  return { speechPattern: findings[0]?.speechPattern || "Speech recognition", missedItems,
    potentialRecoveryPoints: missedItems.length && totalItems && findings.some(finding => Number.isFinite(finding.potentialRecoveryPoints)) ? Math.round(50 * missedItems.length / totalItems) : null };
}

function speechGuidance(run) {
  const raw = run?.rawOutput;
  if (run?.status !== "finished" || run.outputPartial || run.error || typeof raw !== "string" || !raw.trim()) return { findings: [], edits: [] };
  const observed = analyzeSpeech(raw, run.context?.speechProfileTags);
  const instructions = transcriptPreset.prompt.split(/\r?\n\r?\n/);
  const speechInstruction = instructions.find(text => text.startsWith("Remove hesitation fillers"));
  const vocabularyInstruction = instructions.find(text => text.startsWith("Use the reference vocabulary below"));
  const groups = observed.patterns.filter(pattern => pattern.basis === "transcript" && pattern.evidence.length).map(pattern => ({
    pattern, quote: pattern.evidence.find(quote => raw.includes(quote)), instruction: speechInstruction,
    title: pattern.counts.wordRepetitions || pattern.counts.soundRepetitions || pattern.counts.restartedSentences ? "Repeated or restarted wording" : "Hesitation fillers",
    why: "Repeated wording and hesitation can make completed phrases harder to follow.", parameter: "transcription.repetitions", category: "speech-pattern handling",
  }));
  const uncertain = raw.match(/\[unclear\]/i);
  if (uncertain) groups.push({ pattern: { id: "vocabulary", label: "Vocabulary and uncertainty" }, quote: uncertain[0], instruction: vocabularyInstruction,
    title: "Uncertain wording", why: "This passage is marked uncertain and needs confirmation against the recording.", parameter: "transcription.uncertainty", category: "terminology" });
  const findings = [], edits = [];
  for (const [index, group] of groups.entries()) {
    if (!group.quote || !group.instruction) continue;
    const id = `speech-observation-${index + 1}`;
    findings.push({ id, parameter_id: group.parameter, theme: group.category === "terminology" ? "vocabulary_uncertainty" : "speech_patterns", parameterLabel: group.pattern.label,
      speechPattern: group.pattern.label, patternAware: true, title: group.title, quote: group.quote,
      why_it_matters: group.why, accessibilityImpact: group.why, severity: "low", confidence: "high", prompt_coverage: "none", coverage_quote: "",
      verified: true, referenceVerified: false, referenceQuote: "", missedItems: [], potentialRecoveryPoints: null, evidenceBasis: "transcript", advisory: true });
    edits.push({ id: `speech-guidance-${index + 1}`, speechPattern: group.pattern.label, category: group.category, addresses: [id], type: "append", new_text: group.instruction,
      rationale: group.why, expected_effect: "Completed wording stays readable while meaning and uncertainty are retained.", verify_by: "Compare the next transcript with the recording.",
      missedItems: [], potentialRecoveryPoints: null, priorityPoints: 0, applied: false, promptPreset: transcriptPreset.id, advisory: true });
  }
  return { findings, edits };
}

module.exports = { analyzeSpeech, understanding, patternName, relevantCoverage, referenceEvidence, attachFindingEvidence, editEvidence, speechGuidance };
