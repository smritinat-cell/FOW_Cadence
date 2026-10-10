const manifest = require("../config/recording-comparison.json");
const referenceDrafts = require("../config/recording-comparison-reference-drafts.json");
const { BASELINE_PROMPT, JobError } = require("./ultravox");
const { metricInputs, performance } = require("./performance");
const WORKFLOW = manifest.workflow;
const LABEL = "Accessible recording transcription";

function getRecordingComparisonProfile(sampleId) {
  const entry = manifest.recordings.find(recording => recording.sampleId === String(sampleId));
  if (!entry) throw new JobError("INVALID_RECORDING", "Choose one of the three supported recordings.", 400);
  const reference = {
    kind: manifest.referencePolicy.kind,
    policyVersion: manifest.referencePolicy.version,
    verified: entry.reference.verified === true,
    sourceAudioSha256: entry.sourceAudioSha256,
    excerpt: { ...entry.excerpt },
    verifiedBy: entry.reference.verifiedBy,
    verifiedAt: entry.reference.verifiedAt,
    sourceUrl: entry.reference.sourceUrl,
    sourceReferenceSha256: entry.reference.sourceReferenceSha256,
    status: entry.reference.status,
  };
  return {
    workflow: WORKFLOW,
    version: manifest.version,
    sampleId: entry.sampleId,
    filename: entry.filename,
    title: entry.title,
    excerpt: { ...entry.excerpt, excerptLength: String(entry.excerpt.length) },
    context: {
      agentName: "Cadence recording transcription",
      purpose: "Produce a readable transcript that preserves substantive speech, meaningful short responses, and uncertainty.",
      speechProfileTags: entry.speechProfileTags.slice(),
      systemPrompt: BASELINE_PROMPT,
    },
    useCase: { id: entry.sampleId, label: LABEL, summary: "Compare the same recording before and after the saved transcription prompt improvement." },
    reference,
    reference_transcript: entry.reference.transcript,
    critical_items: structuredClone(entry.reference.criticalItems),
  };
}

function validateRecordingSource(profile, audioHash) {
  if (!profile || profile.workflow !== WORKFLOW || profile.reference?.kind !== "readable"
    || profile.reference?.policyVersion !== manifest.referencePolicy.version
    || profile.excerpt?.startOffset !== 0 || profile.excerpt?.length !== 15
    || profile.reference?.excerpt?.startOffset !== profile.excerpt.startOffset
    || profile.reference?.excerpt?.length !== profile.excerpt.length) {
    throw new JobError("REFERENCE_MISMATCH", "The reference must match the fixed 15-second recording excerpt.", 409);
  }
  if (typeof audioHash !== "string" || audioHash !== profile.reference.sourceAudioSha256) {
    throw new JobError("AUDIO_MISMATCH", "This recording differs from the audio prepared for this test.", 409);
  }
}

function prepareRecordingMetricInputs(profile, audioHash) {
  validateRecordingSource(profile, audioHash);
  if (profile.reference.verified !== true || !profile.reference.verifiedBy || !profile.reference.verifiedAt
    || typeof profile.reference_transcript !== "string" || !profile.reference_transcript.trim()
    || !Array.isArray(profile.critical_items) || !profile.critical_items.length) {
    throw new JobError("REFERENCE_UNVERIFIED", "This recording's readable reference needs audio review before it can be scored.", 409);
  }
  const inputs = metricInputs(profile);
  const referenceCheck = performance(profile.reference_transcript, inputs);
  if (!referenceCheck.keyItemsTotal || referenceCheck.keyItemsCaptured !== referenceCheck.keyItemsTotal) {
    throw new JobError("REFERENCE_KEY_ITEMS_INVALID", "Each key item needs a matching phrase in the reviewed readable reference.", 409);
  }
  return inputs;
}

function prepareRecordingRunInputs(profile, audioHash) {
  validateRecordingSource(profile, audioHash);
  if (profile.reference.verified === true) {
    return { ...prepareRecordingMetricInputs(profile, audioHash), scoringBasis: { status: "verified", kind: "readable-reference" } };
  }
  // Draft text is available for later audio review, never as scoring ground truth.
  return { ...metricInputs({ ...profile, reference_transcript: "", critical_items: [] }),
    scoringBasis: { status: "unverified", kind: "readable-reference", reason: "REFERENCE_UNVERIFIED" } };
}

function getRecordingComparison(sampleId, sample, audioHash) {
  const profile = getRecordingComparisonProfile(sampleId);
  if (sample && String(sample.id) !== profile.sampleId) {
    throw new JobError("INVALID_RECORDING", "The selected recording does not match this test.", 400);
  }
  return { ...profile, metricInputSnapshot: prepareRecordingMetricInputs(profile, audioHash) };
}

function getHistoricalRecordingReferenceDraft(sampleId) {
  const draft = referenceDrafts.historical.find(reference => reference.sampleId === String(sampleId));
  return draft ? structuredClone(draft) : null;
}

module.exports = { WORKFLOW, LABEL, getRecordingComparisonProfile, getRecordingComparison,
  prepareRecordingMetricInputs, prepareRecordingRunInputs, getHistoricalRecordingReferenceDraft };
