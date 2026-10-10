const fs = require("node:fs/promises");
const { fileHash } = require("./audio");
const { getRecordingComparisonProfile } = require("./recording-comparison");
const audioHashes = new Map();

async function currentAudioHash(file) {
  const stat = await fs.stat(file);
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const cached = audioHashes.get(file);
  if (cached?.signature === signature) return cached.hash;
  const hash = await fileHash(file);
  audioHashes.set(file, { signature, hash });
  return hash;
}

async function evaluationState(evaluation, baseline, setup, resolveSample, hashAudio = currentAudioHash, reviewedRun = baseline) {
  const reasons = [];
  const sampleId = typeof setup.sampleId === "string" ? setup.sampleId : "";
  const current = resolveSample(sampleId);
  if (!baseline) reasons.push("The original baseline isn't available. Run a new baseline.");
  else {
    if (sampleId !== baseline.sampleId) reasons.push("The recording has changed.");
    else if (!current?.file) reasons.push("The recording isn't available. Run a new baseline.");
    else if (!baseline.audioHashes?.sourceSha256) reasons.push("The original recording couldn't be checked. Run a new baseline.");
    else {
      try {
        if (await hashAudio(current.file) !== baseline.audioHashes.sourceSha256) reasons.push("The recording has changed.");
      } catch { reasons.push("The recording couldn't be checked. Run a new baseline."); }
    }
    const duration = Number(current?.sample.duration_seconds);
    const start = Number(setup.startOffset);
    const requested = setup.excerptLength === "rest" ? duration - start : Number(setup.excerptLength);
    const effectiveLength = Math.min(requested, duration - start);
    if (!Number.isFinite(start) || !Number.isFinite(effectiveLength) || start < 0
      || !Number.isFinite(baseline.excerpt?.startOffset) || !Number.isFinite(baseline.progress?.audioSecondsTotal)
      || Math.abs(start - baseline.excerpt.startOffset) > 0.000001
      || Math.abs(effectiveLength - baseline.progress.audioSecondsTotal) > 0.001) {
      reasons.push("The excerpt has changed.");
    }
    if (setup.model && setup.model !== baseline.requestedModel) reasons.push("The speech model has changed.");
  }
  const analyzedId = evaluation.evaluatedRunId || evaluation.baselineId;
  if (analyzedId && (!reviewedRun || reviewedRun.id !== analyzedId)) reasons.push("The analyzed result isn't available. Review a new result.");
  else if (reviewedRun) {
    if (typeof evaluation.reviewedTranscript === "string" && evaluation.reviewedTranscript !== reviewedRun.rawOutput) reasons.push("The analyzed transcript has changed.");
    if (evaluation.referenceInputSnapshot && ["version", "referenceHash", "criticalItemsHash", "referencePolicyHash"].some(field => evaluation.referenceInputSnapshot[field] !== reviewedRun.metricInputSnapshot?.[field])) reasons.push("The analyzed reference has changed.");
    if (setup.evaluatedRunId != null && String(setup.evaluatedRunId) !== reviewedRun.id) reasons.push("The selected result has changed.");
  }
  const currentUseCase = evaluation.workflow === "recording-comparison" && current
    ? getRecordingComparisonProfile(sampleId).useCase
    : { id: current?.sample.id, label: current?.sample.use_case_label };
  if ((setup.useCaseId || currentUseCase.id) !== evaluation.useCase?.id
    || currentUseCase.label !== evaluation.useCase?.label) reasons.push("The use case has changed.");
  const promptChanged = typeof setup.prompt === "string" && setup.prompt !== evaluation.context.systemPrompt;
  const contextChanged = (typeof setup.agentName === "string" && setup.agentName !== evaluation.context.agentName)
    || (typeof setup.purpose === "string" && setup.purpose !== evaluation.context.purpose)
    || (Array.isArray(setup.speechProfileTags) && JSON.stringify(setup.speechProfileTags) !== JSON.stringify(evaluation.context.speechProfileTags));
  return { outOfDate: reasons.length > 0, requiresNewBaseline: reasons.length > 0, reasons, promptChanged, contextChanged };
}

module.exports = { evaluationState };
