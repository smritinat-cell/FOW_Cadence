const { performance, tokens } = require("./performance");

const PATTERNS = [
  ["Stuttering", /stutt|stammer|disfluen|repetitions?|restarted/i, /stutt|stammer|disfluen|repetitions?|repeated (?:words|sounds|syllables)|restart|fillers|prolong|blocks|cut.{0,12}off|interrupt/i],
  ["Sound substitutions", /substitut|r\/l|l\/r|articulat|mispronoun/i, /substitut|pronounc|articulat|spoken variant|sounds?|r\/l|l\/r/i],
  ["Accent or dialect", /accent|dialect/i, /accent|dialect|regional|pronounc/i],
  ["Involuntary words", /involuntary|tourette|vocal tic/i, /involuntary|vocal tic|intentional|intent|tic/i],
  ["Slow or effortful speech", /slow|effortful|soft|hesitan/i, /effortful|slow speech|soft speech|hesitan|pause|finish|interrupt/i],
  ["Fillers and restarts", /filler|false start|trailing/i, /filler|restart|trailing|false start|finish|interrupt/i],
  ["Overlapping speech", /overlap|speaker|crosstalk/i, /overlap|speaker|crosstalk|attribut|second voice/i],
];
function patternName(value) {
  return PATTERNS.find(([, match]) => match.test(String(value || "")))?.[0] || "Speech recognition";
}
function relevantCoverage(pattern, quote) {
  return PATTERNS.find(([name]) => name === pattern)?.[2].test(quote) || false;
}
function analyzeSpeech(transcript, tags = []) {
  const words = tokens(transcript).map(token => token.word);
  const filler = /^(?:um|uh|erm|er|umm|uhh|hmm)$/;
  const fillers = words.filter(word => filler.test(word)).length;
  let wordRepetitions = 0, restartedSentences = 0, previous = "", previousIndex = -10;
  for (let i = 0; i < words.length; i++) {
    if (filler.test(words[i])) continue;
    if (words[i] === previous && i - previousIndex <= 3) wordRepetitions++;
    previous = words[i]; previousIndex = i;
    if (i >= 3 && words[i] === words[i - 2] && words[i - 1] === words[i - 3] && words[i] !== words[i - 1]) restartedSentences++;
  }
  const soundMatches = [...String(transcript).matchAll(/\b([a-z]{1,4})-(?:\1-)+[a-z]+\b/gi)];
  const soundRepetitions = soundMatches.reduce((sum, match) => sum + match[0].split("-").length - 2, 0);
  restartedSentences += [...String(transcript).matchAll(/(?:\.{3}|…|—|--)\s*(?=\w)/g)].length;
  const profile = tags.join(" ");
  const patterns = [];
  if (wordRepetitions || soundRepetitions || fillers || restartedSentences) {
    const label = /stutt|stammer/i.test(profile) || soundRepetitions || wordRepetitions >= 2 ||
      (wordRepetitions > 0 && fillers >= 2) ? "Stuttering" : "Fillers and restarts";
    const counts = { wordRepetitions, soundRepetitions, fillers, restartedSentences };
    const labels = { wordRepetitions: "word repetitions", soundRepetitions: "sound repetitions", fillers: "fillers", restartedSentences: "restarted phrases" };
    patterns.push({ id: label === "Stuttering" ? "stuttering" : "fillers", label,
      summary: Object.entries(counts).filter(([, count]) => count).map(([key, count]) => `${labels[key]} ×${count}`).join(", "),
      counts, evidence: soundMatches.map(match => match[0]), basis: "transcript" });
  } else if (/stutt|stammer/i.test(profile)) {
    patterns.push({ id: "stuttering", label: "Stuttering", summary: "Identified in the speech profile; no repetitions counted in this transcript.", counts: {}, basis: "profile" });
  }
  for (const [label, match] of PATTERNS.slice(1)) {
    if (label === "Fillers and restarts" || !match.test(profile)) continue;
    patterns.push({ id: label.toLowerCase().replaceAll(" ", "-"), label, summary: "Suggested by the speech profile; no occurrences counted from text.", counts: {}, basis: "profile" });
  }
  return { patterns, basis: "Available transcript and speech profile; text counts are not an acoustic assessment." };
}
function understanding(result) {
  if (!Number.isInteger(result?.keyItemsTotal)) return { text: "Add reference details to check whether the caller’s request was understood.", assessed: false };
  const missingItems = result.items.filter(item => !item.captured).map(({ id, label }) => ({ id, label }));
  return { assessed: true, missingItems, text: missingItems.length
    ? `The agent captured ${result.keyItemsCaptured} of ${result.keyItemsTotal} key details; ${missingItems.map(item => item.label).join(", ")} still need attention.`
    : "The agent captured all of the caller’s key details." };
}
function attachFindingEvidence(finding, input, evidence, currentPrompt, flag) {
  finding.patternAware = typeof input.speech_pattern === "string";
  finding.speechPattern = patternName(input.speech_pattern || finding.title);
  finding.accessibilityImpact = typeof input.accessibility_impact === "string" ? input.accessibility_impact : finding.why_it_matters;
  const reference = evidence?.metricInputSnapshot?.referenceTranscript || "";
  const referenceQuote = typeof input.reference_quote === "string" ? input.reference_quote : "";
  finding.referenceVerified = !!referenceQuote && reference.includes(referenceQuote);
  finding.referenceQuote = finding.referenceVerified ? referenceQuote : "";
  if (finding.patternAware && !finding.referenceVerified) {
    finding.accessibilityImpact = `${finding.speechPattern} may obscure the caller’s intended meaning. Add a reference transcript to check what was lost.`;
  }
  if (referenceQuote && !finding.referenceVerified) {
    flag("Reference quote was not found; the claimed comparison was withheld.", { findingId: finding.id });
    finding.accessibilityImpact = "This speech pattern may leave the caller’s intended meaning unclear. Add a reference transcript to check the meaning.";
  }
  const metric = evidence?.metricInputSnapshot ? performance(evidence.rawOutput, evidence.metricInputSnapshot) : null;
  const requested = Array.isArray(input.missed_item_ids) ? new Set(input.missed_item_ids.map(String)) : new Set();
  finding.missedItems = finding.referenceVerified && metric?.items
    ? metric.items.filter(item => requested.has(item.id) && !item.captured &&
      item.phrases.some(phrase => tokens(referenceQuote).map(token => token.word).join(" ").includes(tokens(phrase).map(token => token.word).join(" "))))
      .map(({ id, label }) => ({ id, label })) : [];
  finding.potentialRecoveryPoints = finding.missedItems.length && metric.keyItemsTotal && !evidence.outputPartial
    ? Math.round(50 * finding.missedItems.length / metric.keyItemsTotal) : null;
  if (finding.patternAware) {
    const observed = evidence?.speechPatterns || analyzeSpeech(evidence?.rawOutput || "", evidence?.context?.speechProfileTags || []);
    const observedPatterns = Array.isArray(observed) ? observed : Array.isArray(observed.patterns) ? observed.patterns : [];
    const supported = observedPatterns.some(pattern => pattern.label === finding.speechPattern);
    if (["Stuttering", "Accent or dialect", "Involuntary words", "Slow or effortful speech"].includes(finding.speechPattern) && !supported) {
      flag("Specific speech pattern was not supported by the transcript or profile; a neutral recognition label was used.", { findingId: finding.id });
      finding.speechPattern = "Speech recognition";
      finding.accessibilityImpact = finding.referenceVerified
        ? "The agent’s wording does not match the referenced meaning."
        : "The agent’s wording may obscure the caller’s intended meaning. Add a reference transcript to check what was lost.";
    }
    finding.title = `${finding.speechPattern}: ${finding.title.replace(/^[^:]+:\s*/, "")}`;
    if (["partial", "full"].includes(finding.prompt_coverage) && !relevantCoverage(finding.speechPattern, finding.coverage_quote)) {
      finding.original_coverage_quote = finding.coverage_quote;
      finding.original_prompt_coverage = finding.prompt_coverage;
      finding.prompt_coverage = "none"; finding.coverage_quote = "";
      flag("Generic prompt wording does not address this speech pattern; coverage was downgraded.", { findingId: finding.id });
    }
  }
}
function editEvidence(findings, totalItems) {
  const missedItems = [...new Map(findings.flatMap(finding => finding.missedItems || []).map(item => [item.id, item])).values()];
  return { speechPattern: findings[0]?.speechPattern || "Speech recognition", missedItems,
    potentialRecoveryPoints: missedItems.length && totalItems && findings.some(finding => Number.isFinite(finding.potentialRecoveryPoints))
      ? Math.round(50 * missedItems.length / totalItems) : null };
}
module.exports = { analyzeSpeech, understanding, patternName, relevantCoverage, attachFindingEvidence, editEvidence };
