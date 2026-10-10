(() => {
  "use strict";

  const activeStatuses = new Set(["queued", "preparing", "connecting", "streaming", "sending", "waiting", "running"]);
  const VIEW_KEY = "speech-prompt-lab-scorecard-view-v1";
  function debugMode() {
    return new URLSearchParams(location.search).get("debug") === "1";
  }
  function readViewState() {
    try { return JSON.parse(localStorage.getItem(VIEW_KEY) || "{}"); } catch { return {}; }
  }
  const savedView = readViewState();
  const state = {
    jobs: [], models: [], preferred: "", error: "", historyFailed: false, modelError: "", selectedJobId: null,
    selectedModel: "", polling: false, submitting: false, submittingEvaluation: false,
    historyLoading: true, modelsLoading: true, details: new Map(), detailsLoading: new Set(),
    detailErrors: new Map(), audits: new Map(), auditsLoading: new Set(), auditErrors: new Map(),
    scorecardSelection: savedView.selection && typeof savedView.selection === "object" ? savedView.selection : {},
    scorecardHidden: savedView.hidden && typeof savedView.hidden === "object" ? savedView.hidden : {},
    openThemes: new Set(), promptTextCache: new Map(), selectedSimulationJobId: null,
    simulationRetryKind: null, simulationRetryStopId: null, submittingSandbox: false,
    proposals: new Map(), proposalLoading: new Set(), proposalErrors: new Map(),
    proposalSelection: new Map(), retryEvaluation: false, retryEvaluationBaselineId: null
  };
  const lockListeners = new Set();
  const runListeners = new Set();
  let runsLoaded = false;
  let modelsLoaded = false;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }
  function safeJson(value) {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ""); }
  }
  function safeDebugText(value) {
    return String(value ?? "")
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[hidden link]")
      .replace(/(["']?(?:api[_-]?key|secret|token)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[hidden]")
      .replace(/(["']?authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"'\s,;}]+/gi, "$1[hidden]")
      .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [hidden]");
  }
  function debugJson(value) { return value == null ? "Not provided." : safeDebugText(safeJson(value)); }
  function friendlyError(error, fallback = "Something went wrong. Please try again.") {
    const value = String(error?.code || error?.name || "").toLowerCase();
    if (/key|credential|auth|unauthori/.test(value)) return "The speech service isn’t available right now. Please contact your workspace admin.";
    if (/usage|rate|limit|quota|busy/.test(value)) return "The speech service is busy or at its limit. Please try again later.";
    if (/model/.test(value)) return "This speech model isn’t available. Choose another model and try again.";
    if (/decode|audio|recording|format/.test(value)) return "We couldn’t read this recording. Choose another recording and try again.";
    if (/timeout|timed.?out/.test(value)) return "This took too long. Please try again.";
    if (/empty|no.?transcript/.test(value)) return "No transcript came back. Please try again.";
    if (/network|connection|fetch|typeerror|econn/.test(value)) return "Connection problem. We’ll keep trying.";
    return fallback;
  }
  function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Date unavailable";
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return `Today, ${time}`;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date);
  }
  function statusText(status) {
    const labels = {
      preparing: "Preparing audio",
      connecting: "Connecting",
      streaming: "Listening",
      sending: "Listening",
      waiting: "Waiting for the result",
      queued: "Preparing audio",
      running: "Listening",
      finished: "Done",
      complete: "Done",
      partial: "Partial result",
      cancelled: "Stopped",
      stopped: "Stopped",
      failed: "Failed"
    };
    return labels[status] || "In progress";
  }
  function kindText(kind) { return kind === "evaluation" ? "Evaluation" : "Baseline transcript"; }
  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const detail = body?.error?.message || body?.message || `Request failed (${response.status}).`;
      const error = new Error(detail);
      error.code = body?.error?.code || "";
      throw error;
    }
    return body;
  }
  async function requestText(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: "include",
      headers: { ...(options.headers || {}) }
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body?.error?.message || body?.message || "";
      } catch {}
      throw new Error(detail || `Request failed (${response.status}).`);
    }
    return response.text();
  }
  function persistScorecardView() {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ selection: state.scorecardSelection, hidden: state.scorecardHidden }));
    } catch {}
  }
  function sampleKey(sample) { return sample ? String(sample.id) : ""; }
  function currentModel(ctx, fallback = "") {
    return ctx.experiment.model || state.selectedModel || fallback || "";
  }
  function currentSample(ctx) {
    return ctx.samples.find(item => String(item.id) === String(ctx.experiment.selectedId)) || null;
  }
  function forSample(ctx) {
    const sample = currentSample(ctx);
    return sample ? state.jobs.filter(job => String(job.sampleId) === String(sample.id)) : [];
  }
  function requestContext(experiment) {
    return {
      agentName: experiment.agentName || "",
      purpose: experiment.purpose || "",
      speechProfileTags: Array.isArray(experiment.speechProfileTags) ? experiment.speechProfileTags.slice() : [],
      systemPrompt: experiment.prompt
    };
  }
  function useCaseSnapshot(sample) {
    return {
      id: sample.id,
      label: sample.use_case_label || "",
      summary: sample.use_case_summary || ""
    };
  }
  function hasTranscriptText(job) {
    return [job?.userInputTranscript, job?.rawOutput].some(value => typeof value === "string" && value.trim().length > 0);
  }
  function eligibleBaseline(job) {
    if (!job) return false;
    if (job.status === "finished") return !job.error;
    return job.status === "partial" && hasTranscriptText(job);
  }
  function evaluationBaseline(ctx, preferredId) {
    const baselines = forSample(ctx).filter(job => job.kind === "baseline");
    if (preferredId) {
      const preferred = baselines.find(job => String(job.id) === String(preferredId));
      return eligibleBaseline(preferred) ? preferred : null;
    }
    const selected = forSample(ctx).find(job => String(job.id) === String(state.selectedJobId));
    if (selected?.kind === "baseline" && eligibleBaseline(selected)) return selected;
    if (selected?.kind === "evaluation") {
      const selectedBaseline = baselines.find(job => String(job.id) === String(selected.baselineId));
      if (eligibleBaseline(selectedBaseline)) return selectedBaseline;
    }
    return baselines.filter(job => job.status === "finished" && eligibleBaseline(job)).sort(byCreated)[0] || null;
  }
  function byCreated(a, b) { return String(b.createdAt || "").localeCompare(String(a.createdAt || "")); }
  function activeJob() { return state.jobs.find(job => activeStatuses.has(job.status)) || null; }
  function hasActiveWork() { return state.historyLoading || state.submitting || Boolean(activeJob()); }
  function evaluationLockState() {
    const active = state.jobs.some(job => job.kind === "evaluation" && activeStatuses.has(job.status));
    return { locked: state.historyLoading || state.submittingEvaluation || state.submittingSandbox || active, loading: state.historyLoading, active, submitting: state.submittingEvaluation || state.submittingSandbox };
  }
  function publishEvaluationLock() {
    const value = evaluationLockState();
    lockListeners.forEach(listener => listener(value));
  }
  function onEvaluationLockChange(listener) {
    lockListeners.add(listener);
    listener(evaluationLockState());
    return () => lockListeners.delete(listener);
  }
  function isEvaluationLocked() { return evaluationLockState().locked; }
  function timeLabel(job) {
    const ms = Number(job?.elapsedMs);
    if (!Number.isFinite(ms)) return "Time unavailable";
    return `${(ms / 1000).toFixed(1)} sec`;
  }
  function progressMarkup(job) {
    if (job?.kind === "evaluation") {
      return `<div class="job-stats"><span>${esc(statusText(job.status))}</span><span>${esc(timeLabel(job))}</span></div>`;
    }
    const progress = job?.progress || {};
    const pct = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const sent = Number(progress.audioSecondsSent);
    const total = Number(progress.audioSecondsTotal);
    return `<div class="job-progress" aria-label="Recording progress"><span style="width:${pct}%"></span></div>
      <div class="job-stats"><span>${esc(statusText(job.status))}</span><span>${esc(timeLabel(job))}</span>${Number.isFinite(total) && total > 0 ? `<span>${Number.isFinite(sent) ? sent.toFixed(1) : "0"} of ${total.toFixed(1)} sec sent</span>` : ""}</div>`;
  }
  function simulationProgressMarkup(job) {
    if (job?.kind === "evaluation") return progressMarkup(job);
    const progress = job?.progress || {};
    const rawPercent = Number(progress.percent);
    const hasPercent = progress.percent != null && Number.isFinite(rawPercent);
    const pct = Math.max(0, Math.min(100, Number.isFinite(rawPercent) ? rawPercent : 0));
    const sent = Number(progress.audioSecondsSent);
    const total = Number(progress.audioSecondsTotal);
    return `${hasPercent ? `<div class="job-progress" aria-label="Recording progress"><span style="width:${pct}%"></span></div>` : ""}
      <div class="job-stats"><span>${esc(statusText(job.status))}</span><span>${esc(timeLabel(job))}</span>${Number.isFinite(total) && total > 0 ? `<span>${Number.isFinite(sent) ? sent.toFixed(1) : "0"} of ${total.toFixed(1)} sec sent</span>` : ""}</div>`;
  }
  function errorMarkup(job) {
    const apiError = job?.error ? `<div class="error-box" role="alert">${esc(friendlyError(job.error))}${debugMode() ? `<details><summary>Technical details</summary><p>${esc(safeDebugText(job.error.code || ""))}</p><p>${esc(safeDebugText(job.error.message || ""))}</p></details>` : ""}</div>` : "";
    const networkError = job?.networkError ? `<div class="error-box" role="alert">Connection problem. We’ll keep trying.</div>` : "";
    return apiError + networkError;
  }
  function jobRows(ctx) {
    const jobs = forSample(ctx).sort(byCreated);
    if (state.historyLoading) return `<div class="sim-empty" aria-busy="true">Loading your runs…</div>`;
    if (state.historyFailed) return `<div class="sim-empty" role="alert">${esc(state.error || "We couldn’t load your runs. Please try again.")} <button type="button" class="button secondary small" id="retry-run-history">Try again</button></div>`;
    if (!jobs.length) return `<div class="sim-empty">No runs yet. Run a baseline to get started.</div>`;
    return `<div class="job-list" aria-label="Recent runs">${jobs.map(job => `<button class="job-row${String(job.id) === String(state.selectedJobId) ? " selected" : ""}" type="button" data-job-id="${esc(job.id)}">
      <span><span class="job-title">${esc(kindText(job.kind))}</span><br><span class="job-meta">${esc(formatDate(job.createdAt))}${debugMode() ? ` · ${esc(safeDebugText(job.id))}` : ""}</span></span>
      <span class="job-status ${esc(job.status)}">${esc(statusText(job.status))}</span></button>`).join("")}</div>`;
  }
  function selectJob(ctx) {
    return forSample(ctx).find(job => String(job.id) === String(state.selectedJobId)) || forSample(ctx).sort(byCreated)[0] || null;
  }
  function outputSection(label, value) {
    return `<div><p class="section-label">${esc(label)}</p><pre class="output-block">${esc(value || "No transcript available.")}</pre></div>`;
  }
  function isRubricEvaluation(job) {
    const result = job?.parsedResult;
    return Boolean(job?.rubric_version || job?.computedScores ||
      (result && (Object.prototype.hasOwnProperty.call(result, "parameters") ||
        Object.prototype.hasOwnProperty.call(result, "findings"))));
  }
  function rubricVisibility(job) {
    if (!debugMode() || job?.kind !== "evaluation" || !isRubricEvaluation(job)) return "";
    const result = job.parsedResult || {};
    return `<details class="rubric-test-details"><summary class="section-label">Evaluation diagnostics</summary>
      ${job.rubric_version ? `<p class="field-help">Review version: ${esc(job.rubric_version)}</p>` : ""}
      ${result.summary ? `<p><strong>Summary</strong><br>${esc(result.summary)}</p>` : ""}
      ${outputSection("Unverified list", debugJson(job.unverifiedFindings))}
      ${outputSection("Validation flags", debugJson(job.validationFlags))}
      ${outputSection("Computed scores", debugJson(job.computedScores))}
      ${outputSection("Findings", debugJson(job.verifiedFindings))}
      ${outputSection("Dropped items", debugJson(job.droppedItems))}
      ${outputSection("Parsed parameters", debugJson(result.parameters))}
      ${outputSection("Parsed findings", debugJson(result.findings))}
      ${outputSection("Stored prompt edits", debugJson(result.promptEdits))}
    </details>`;
  }
  function rawOutputLabel(job, label) {
    return `${job?.outputPartial ? "Partial · " : ""}${label}`;
  }
  function selectedDetail(ctx) {
    const summary = selectJob(ctx);
    if (summary?.kind === "evaluation" && !state.details.has(String(summary.id)) && !state.detailErrors.has(String(summary.id))) {
      ensureEvaluationDetail(ctx, summary.id);
    }
    const job = summary?.kind === "evaluation" ? state.details.get(String(summary.id)) || summary : summary;
    if (!job) return `<div class="sim-empty">Run details will appear here.</div>`;
    const canStop = activeStatuses.has(job.status);
    const associatedBaseline = job.kind === "evaluation"
      ? forSample(ctx).find(item => item.kind === "baseline" && String(item.id) === String(job.baselineId))
      : null;
    const partialReview = associatedBaseline?.status === "partial";
    const evaluationSummary = job.kind === "evaluation" ? (job.parsedResult?.summary || job.summary || "") : "";
    return `<div class="job-detail"><div class="action-row"><strong class="section-title">${esc(kindText(job.kind))}</strong><span class="job-status ${esc(job.status)}">${esc(statusText(job.status))}</span>${canStop ? `<button type="button" class="button secondary small" id="stop-job" data-stop-id="${esc(job.id)}">Stop</button>` : ""}</div>
      ${progressMarkup(job)}${errorMarkup(job)}
      ${partialReview ? `<p class="review-note">Based on a partial transcript, so results may be incomplete.</p>` : ""}
      ${job.kind === "evaluation" && state.detailsLoading.has(String(job.id)) ? `<p class="review-audit-status" aria-busy="true">Loading your evaluation…</p>` : ""}
      ${job.kind === "evaluation" && state.detailErrors.has(String(job.id)) ? `<div class="error-box">We couldn’t load this evaluation. <button type="button" class="button secondary small" id="retry-evaluation-details">Try again</button>${debugMode() ? `<p>${esc(safeDebugText(state.detailErrors.get(String(job.id))))}</p>` : ""}</div>` : ""}
      ${job.kind === "evaluation" && job.parseError ? `<div class="error-box">We couldn’t finish this evaluation. Please try again.</div><button type="button" class="button small" id="retry-evaluation" ${hasActiveWork() || !eligibleBaseline(associatedBaseline) ? "disabled" : ""}>Evaluate your voice agent · retry</button>` : ""}
      ${job.kind === "baseline" ? outputSection(rawOutputLabel(job, "Transcript"), job.userInputTranscript || job.rawOutput) : `${evaluationSummary ? `<section class="review-summary"><p class="section-label">Evaluation summary</p><p>${esc(evaluationSummary)}</p></section>` : ""}${job.parseError ? `<div class="error-box">We couldn’t finish this evaluation. Please try again.</div>` : ""}${rubricVisibility(job)}`}
      ${debugMode() ? `<details><summary class="section-label">Developer details</summary>
        <p>Run ID: ${esc(safeDebugText(job.id))}</p>
        ${job.sampleId ? `<p>Recording ID: ${esc(safeDebugText(job.sampleId))}</p>` : ""}
        ${job.requestedModel || job.resolvedModel ? `<p>Requested model: ${esc(safeDebugText(job.requestedModel || ""))} · Resolved model: ${esc(safeDebugText(job.resolvedModel || ""))}</p>` : ""}
        ${job.kind === "baseline" ? `${outputSection("User input transcript", safeDebugText(job.userInputTranscript))}${outputSection(rawOutputLabel(job, "Raw recording response"), safeDebugText(job.rawOutput))}` : `${outputSection("Evaluator input", safeDebugText(job.evaluatorInput))}${outputSection(rawOutputLabel(job, "Raw evaluator response"), safeDebugText(job.rawOutput))}`}
        ${job.settings ? outputSection("Settings", debugJson(job.settings)) : ""}
        ${job.diagnostics ? outputSection("Diagnostics", debugJson(job.diagnostics)) : ""}
        ${job.timings ? outputSection("Timings", debugJson(job.timings)) : ""}
        ${job.rubric ? outputSection("Review weights", debugJson(job.rubric)) : ""}
        ${job.computedScores ? outputSection("Computed scores", debugJson(job.computedScores)) : ""}
      </details>` : ""}
    </div>`;
  }
  const BASELINE_PROMPT = "Transcribe the audio. Output only the transcript.";
  function simulationKindText(kind) { return kind === "candidate" ? "Your prompt" : "Baseline"; }
  function simulationStatusText(status) {
    const labels = {
      queued: "Queued", preparing: "Queued", connecting: "Running", streaming: "Running",
      sending: "Running", waiting: "Running", running: "Running", finished: "Complete",
      complete: "Complete", partial: "Partial result", failed: "Failed", cancelled: "Stopped",
      stopped: "Stopped"
    };
    return labels[status] || "Queued";
  }
  function modelDisplay(value) {
    if (!value) return "Not recorded";
    const model = typeof value === "string" ? state.models.find(item => item.id === value) : value;
    if (model) {
      const label = model.label || model.displayName || model.display_name || model.humanName || model.human_name ||
        model.modelName || model.model_name || model.name;
      const provider = model.providerName || model.provider_name || model.provider || model.vendor;
      if (label) {
        const readableLabel = humanizeModelName(label);
        if (provider && !String(label).toLowerCase().includes(String(provider).toLowerCase())) {
          return `${humanizeModelName(provider)} · ${readableLabel}`;
        }
        return readableLabel;
      }
    }
    const raw = typeof value === "string" ? value.replace(/^models\//, "") : "";
    if (raw) return humanizeModelName(raw);
    return "Saved speech model";
  }
  function humanizeModelName(value) {
    const raw = String(value);
    if (!/[-_/]/.test(raw)) return raw;
    return raw.replace(/[-_/]+/g, " ").replace(/\bv(\d)/i, (_, digit) => `v${digit}`).replace(/\b[a-z]/g, letter => letter.toUpperCase());
  }
  function simulationModelOption(model, index) {
    const label = modelDisplay(model);
    return label === "Saved speech model" ? `Speech model ${index + 1}` : label;
  }
  function sourceFileName(recording, sample) {
    const storedName = recording?.fileName || recording?.filename || sample?.fileName || sample?.file_name ||
      sample?.filename || sample?.audioFileName || sample?.audio_file_name || sample?.recording_name;
    if (storedName) return storedName;
    const audioUrl = recording?.audioUrl || sample?.audio_url;
    if (audioUrl) {
      try {
        const segment = new URL(audioUrl, location.href).pathname.split("/").filter(Boolean).pop();
        if (segment) return decodeURIComponent(segment);
      } catch {}
    }
    return sample?.title || recording?.label || "Selected recording";
  }
  function sampleDuration(sample) {
    return Math.max(0, Number(sample?.duration_seconds ?? sample?.durationSeconds ?? sample?.duration) || 0);
  }
  function currentExcerpt(ctx, sample) {
    const duration = sampleDuration(sample);
    const startOffset = Math.max(0, Number(ctx.experiment.startOffset) || 0);
    const requested = ctx.experiment.excerptLength === "rest"
      ? Math.max(0, duration - startOffset)
      : Math.max(0, Number(ctx.experiment.excerptLength) || 15);
    const excerptLength = Math.min(requested, Math.max(0, duration - startOffset));
    return { startOffset, excerptLength, endOffset: Math.min(duration, startOffset + excerptLength), duration };
  }
  function displaySeconds(value) {
    const seconds = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds - minutes * 60;
    return `${minutes}:${String(remainder.toFixed(remainder % 1 ? 1 : 0)).padStart(2, "0")}`;
  }
  function rangeText(start, length) {
    const end = Number(start) + Number(length);
    return `${displaySeconds(start)}–${displaySeconds(end)} · ${Number(length || 0).toFixed(Number(length) % 1 ? 1 : 0)} sec`;
  }
  function runRange(job) {
    const start = job?.startOffset ?? job?.excerpt?.startOffset ?? job?.excerpt?.startSeconds ??
      job?.settings?.startOffset ?? job?.inputSnapshot?.startOffset;
    const length = job?.excerptLength ?? job?.excerpt?.excerptLength ?? job?.excerpt?.length ?? job?.excerpt?.durationSeconds ?? job?.excerpt?.lengthSeconds ??
      job?.settings?.excerptLength ?? job?.inputSnapshot?.excerptLength;
    return Number.isFinite(Number(start)) && Number.isFinite(Number(length))
      ? { startOffset: Number(start), excerptLength: Number(length) }
      : null;
  }
  function runPrompt(job) {
    if (typeof job?.promptUsed === "string") return job.promptUsed;
    if (typeof job?.inputSnapshot?.systemPrompt === "string") return job.inputSnapshot.systemPrompt;
    if (typeof job?.context?.systemPrompt === "string") return job.context.systemPrompt;
    return null;
  }
  function numbersMatch(a, b) {
    return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) < 0.01;
  }
  function audioHashesMatch(left, right) {
    const a = left?.audioHashes;
    const b = right?.audioHashes;
    if (a == null || b == null) return true;
    if (typeof a === "string" || typeof b === "string") return String(a) === String(b);
    if (typeof a !== "object" || typeof b !== "object") return true;
    const shared = Object.keys(a).filter(key => Object.prototype.hasOwnProperty.call(b, key));
    return shared.every(key => String(a[key]) === String(b[key]));
  }
  function sameAudioPath(left, right) {
    try { return new URL(left, location.href).pathname === new URL(right, location.href).pathname; }
    catch { return String(left) === String(right); }
  }
  function currentAudioMatches(job, sample) {
    if (!sample || String(job?.sampleId ?? "") !== String(sample.id ?? "")) return false;
    const recording = job.recording || {};
    const duration = sampleDuration(sample);
    if (recording.durationSeconds != null && duration > 0 &&
        !numbersMatch(recording.durationSeconds, duration)) return false;
    const sourceId = sample.recordingId ?? sample.recording_id ?? sample.audio_id ?? null;
    if (sourceId != null && recording.id != null && String(sourceId) !== String(recording.id)) return false;
    const sourceName = sample.fileName || sample.file_name || sample.filename || sample.audioFileName || sample.audio_file_name || sample.recording_name;
    const recordedName = recording.fileName || recording.filename;
    if (sourceName && recordedName && String(sourceName) !== String(recordedName)) return false;
    if (sample.audio_url && recording.audioUrl && !sameAudioPath(sample.audio_url, recording.audioUrl)) return false;
    const sourceHash = sample.audioHashes || sample.audioHash || sample.audio_hash;
    if (sourceHash && job.audioHashes) {
      if (typeof sourceHash === "string" && typeof job.audioHashes === "string" && sourceHash !== job.audioHashes) return false;
      if (typeof sourceHash === "object" && typeof job.audioHashes === "object") {
        const shared = Object.keys(sourceHash).filter(key => Object.prototype.hasOwnProperty.call(job.audioHashes, key));
        if (shared.some(key => String(sourceHash[key]) !== String(job.audioHashes[key]))) return false;
      }
    }
    return true;
  }
  function currentModelMatches(job, model) {
    const recorded = job?.requestedModel || job?.resolvedModel;
    return Boolean(recorded && model && String(recorded) === String(model));
  }
  function relevantSettings(job) {
    const settings = job?.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "";
    const omit = /^(?:id|mode|kind|prompt|promptused|systemprompt|instruction|startoffset|excerptlength|transcript|model)$/i;
    const normalize = value => {
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().filter(key => !omit.test(key)).map(key => [key, normalize(value[key])]));
      }
      return value;
    };
    return JSON.stringify(normalize(settings));
  }
  function runMatchesCurrent(job, ctx, sample, kind) {
    if (!job || job.kind !== kind || !currentAudioMatches(job, sample)) return false;
    const current = currentExcerpt(ctx, sample);
    const recorded = runRange(job);
    if (!recorded || !numbersMatch(recorded.startOffset, current.startOffset) ||
        !numbersMatch(recorded.excerptLength, current.excerptLength) ||
        !currentModelMatches(job, currentModel(ctx))) return false;
    if (kind === "baseline") return runPrompt(job) === BASELINE_PROMPT;
    return Boolean(ctx.experiment.prompt) && runPrompt(job) === ctx.experiment.prompt;
  }
  function finishedWithOutput(job) {
    return Boolean(job && ["finished", "complete", "partial"].includes(job.status) &&
      typeof job.rawOutput === "string" && job.rawOutput.trim());
  }
  function isFinishedRun(job) { return Boolean(job && ["finished", "complete"].includes(job.status) && !job.error); }
  function matchingSimulationRuns(ctx, sample) {
    const matching = state.jobs.filter(job => ["baseline", "candidate"].includes(job.kind) &&
      runMatchesCurrent(job, ctx, sample, job.kind)).sort(byCreated);
    const baseline = matching.find(job => job.kind === "baseline") || null;
    const candidate = matching.find(job => job.kind === "candidate" && (!job.pairedBaselineId ||
      matching.some(run => run.kind === "baseline" && String(run.id) === String(job.pairedBaselineId) &&
        isFinishedRun(run) && relevantSettings(run) === relevantSettings(job) && audioHashesMatch(run, job)))) || null;
    return { baseline, candidate };
  }
  function finishedMatchingBaseline(ctx, sample) {
    return state.jobs.filter(job => job.kind === "baseline" && isFinishedRun(job) &&
      runMatchesCurrent(job, ctx, sample, "baseline"))
      .sort(byCreated)[0] || null;
  }
  function runOutputLabel(job) {
    const partial = Boolean(job?.outputPartial || job?.status === "partial");
    return `${partial ? "Partial " : ""}${job?.kind === "candidate" ? "generated output" : "transcript"}`;
  }
  function runOutputPreview(job) {
    const output = String(job?.rawOutput || "");
    if (!output.trim()) return "";
    const compact = output.replace(/\s+/g, " ").trim();
    return `${compact.slice(0, 110)}${compact.length > 110 ? "…" : ""}`;
  }
  function matchingPatternSource(job, baseline) {
    if (!job || !baseline || baseline.kind !== "baseline" || String(job.sampleId) !== String(baseline.sampleId)) return false;
    const a = runRange(job), b = runRange(baseline);
    return Boolean(a && b && numbersMatch(a.startOffset, b.startOffset) && numbersMatch(a.excerptLength, b.excerptLength) &&
      String(job.requestedModel || job.resolvedModel || "") === String(baseline.requestedModel || baseline.resolvedModel || "") &&
      relevantSettings(job) === relevantSettings(baseline) && audioHashesMatch(job, baseline));
  }
  function speechPatternBaseline(job) {
    const cleaned = job?.cleaned === true || job?.isCleaned === true || job?.outputCleaned === true ||
      job?.outputWasCleaned === true || job?.transcriptCleaned === true || job?.cleaningApplied === true || job?.cleaning?.applied === true ||
      job?.inputSnapshot?.transcriptCleanup === true || job?.settings?.transcriptCleanup === true;
    if (job?.kind !== "candidate" || !cleaned) return null;
    const paired = state.jobs.find(item => item.kind === "baseline" && String(item.id) === String(job.pairedBaselineId));
    if (matchingPatternSource(job, paired) && (speechPatternEntries(paired).length || paired?.speechPatterns != null)) return paired;
    const candidateRange = runRange(job);
    return state.jobs.filter(item => item.kind === "baseline" && matchingPatternSource(job, item) &&
      (speechPatternEntries(item).length || item.speechPatterns != null) && candidateRange &&
      numbersMatch(runRange(item)?.startOffset, candidateRange.startOffset) &&
      numbersMatch(runRange(item)?.excerptLength, candidateRange.excerptLength)).sort(byCreated)[0] || null;
  }
  function speechPatternEntries(job) {
    const value = job?.speechPatterns;
    if (Array.isArray(value)) return value;
    return Array.isArray(value?.patterns) ? value.patterns : [];
  }
  function speechPatternsMarkup(job, options = {}) {
    if (!job || !["finished", "complete", "partial"].includes(job.status)) return options.empty ? `<section class="speech-pattern-summary"><p class="section-label">Speech patterns in this recording</p><p class="quiet-empty">Run a test to see the speech patterns in this recording.</p></section>` : "";
    const baseline = options.baseline && matchingPatternSource(job, options.baseline) ? options.baseline : speechPatternBaseline(job);
    const source = baseline || job;
    const patternPayload = source.speechPatterns;
    const patterns = speechPatternEntries(source);
    const jobUnderstanding = job.understanding || {};
    const sourceUnderstanding = source.understanding || {};
    const understandingRecord = jobUnderstanding && typeof jobUnderstanding === "object" ? jobUnderstanding : sourceUnderstanding;
    const understanding = (typeof jobUnderstanding === "string" ? jobUnderstanding : jobUnderstanding.text) ||
      (typeof sourceUnderstanding === "string" ? sourceUnderstanding : sourceUnderstanding.text) || "";
    const missingItems = Array.isArray(understandingRecord.missingItems) ? understandingRecord.missingItems :
      Array.isArray(sourceUnderstanding.missingItems) ? sourceUnderstanding.missingItems : [];
    const partialBasis = [patternPayload?.basis, ...patterns.map(pattern => pattern?.basis)]
      .some(basis => typeof basis === "string" && /partial/i.test(basis));
    const partial = job.status === "partial" || job.outputPartial === true || partialBasis;
    const countLabels = [
      ["wordRepetitions", "Word repetitions"],
      ["fillers", "Fillers"],
      ["restartedSentences", "Restarted sentences"],
      ["soundRepetitions", "Sound repetitions"]
    ];
    const cards = patterns.map(pattern => {
      const counts = pattern?.counts && typeof pattern.counts === "object" ? pattern.counts : {};
      const evidence = typeof pattern.evidence === "string" ? pattern.evidence :
        Array.isArray(pattern.evidence) ? pattern.evidence.map(item => typeof item === "string" ? item : item?.quote || item?.text || "").filter(Boolean).join("\n") :
          pattern.evidence && typeof pattern.evidence === "object" ? pattern.evidence.quote || pattern.evidence.text || "" : "";
      const available = countLabels.filter(([key]) => typeof counts[key] === "number" && Number.isFinite(counts[key]) && counts[key] > 0);
      return `<article class="speech-pattern-item">
        <strong>${esc(pattern.label || "Speech pattern")}</strong>
        ${pattern.summary ? `<p>${esc(pattern.summary)}</p>` : ""}
        ${available.length ? `<ul>${available.map(([key, label]) => `<li><span>${esc(label)}</span><strong>${esc(counts[key])}</strong></li>`).join("")}</ul>` : ""}
        ${evidence ? `<blockquote>${esc(evidence)}</blockquote>` : ""}
      </article>`;
    }).join("");
    return `<section class="speech-pattern-summary">
      <div class="speech-pattern-heading"><p class="section-label">Speech patterns in this recording</p>${partial ? `<span class="speech-partial-tag">Partial observations</span>` : ""}</div>
      ${understanding ? `<p class="speech-understanding">${esc(understanding)}</p>` : ""}
      ${missingItems.length ? `<div class="speech-missing-items"><strong>Missing key details</strong><ul>${missingItems.map(item => `<li>${esc(typeof item === "string" ? item : item?.label || item?.text || item?.id || "")}</li>`).join("")}</ul></div>` : ""}
      ${cards ? `<div class="speech-pattern-list">${cards}</div>` : ""}
      ${!patterns.length ? `<p class="speech-pattern-empty">${partial ? "This partial result contains no additional pattern observations." : patternPayload != null ? "No pattern observations were included in this result. Run the recording again to check available details." : "Pattern details weren’t saved for this run. Run the recording again to check available details."}</p>` : ""}
      ${baseline && baseline !== job ? `<p class="speech-pattern-source">Patterns shown from the baseline recording.</p>` : ""}
    </section>`;
  }
  function simulationCell(job, kind) {
    if (!job) return `<div class="sim-result-empty"><strong>${kind === "candidate" ? "Your prompt" : "Baseline"}</strong><span>No run yet</span></div>`;
    const status = simulationStatusText(job.status);
    const preview = runOutputPreview(job);
    return `<button type="button" class="sim-result-cell${String(job.id) === String(state.selectedSimulationJobId) ? " selected" : ""}" data-sim-select-job="${esc(job.id)}">
      <span class="sim-cell-top"><strong>${kind === "candidate" ? "Your prompt" : "Baseline"}</strong><span class="sim-state ${esc(String(job.status || "queued").toLowerCase())}">${esc(status)}</span></span>
      ${preview ? `<span class="sim-cell-preview">${esc(preview)}</span>` : `<span class="sim-cell-preview muted">${activeStatuses.has(job.status) ? "Waiting for output…" : "No output returned."}</span>`}
      ${job.outputPartial || job.status === "partial" ? `<span class="sim-partial-label">${esc(runOutputLabel(job))}</span>` : ""}
    </button>`;
  }
  function simulationRunDetails(job, currentSample, ctx) {
    if (!job) return `<div class="sim-empty">Select a result to inspect its output.</div>`;
    const recording = job.recording || {};
    const range = runRange(job);
    const savedDuration = recording.durationSeconds ?? job.durationSeconds ?? (currentSample ? sampleDuration(currentSample) : null);
    const recordedUseCase = job.useCase?.label || job.useCaseLabel || job.context?.useCase?.label || "Saved use case";
    const recordedAgent = job.context?.agentName || job.inputSnapshot?.agentName || "";
    const prompt = runPrompt(job);
    const reference = typeof job.referenceMaterial === "string" ? job.referenceMaterial : "";
    const referenceStatus = job.inputSnapshot?.referenceMaterialSuppliedToModel === false
      ? "Reference material was saved with this run and was not supplied to the model."
      : job.inputSnapshot?.referenceMaterialSuppliedToModel === true
        ? "Reference material was supplied to the model."
        : "";
    const output = String(job.rawOutput || "");
    const isCurrentInput = runMatchesCurrent(job, ctx, currentSample, job.kind);
    const error = job.error ? `<div class="error-box" role="alert">${esc(friendlyError(job.error))}</div>` : "";
    return `<section class="sim-run-detail">
      <div class="sim-run-detail-header"><div><p class="section-label">${esc(simulationKindText(job.kind))} result${isCurrentInput ? "" : " · Earlier run"}</p><h3>${esc(sourceFileName(recording, { title: recording.label || currentSample?.title }))}</h3></div><span class="sim-state ${esc(String(job.status || "").toLowerCase())}">${esc(simulationStatusText(job.status))}</span>${["failed", "cancelled", "stopped"].includes(job.status) ? `<button type="button" class="button secondary small" data-repeat-run="${esc(job.kind)}">Try again</button>` : ""}</div>
      ${!isCurrentInput ? `<p class="sim-output-pending">This run keeps its original recording and settings. Your current setup is unchanged.</p>` : ""}
      <dl class="sim-detail-grid">
        <div><dt>Use case</dt><dd>${esc(recordedUseCase)}</dd></div>
        ${recordedAgent ? `<div><dt>Agent</dt><dd>${esc(recordedAgent)}</dd></div>` : ""}
        ${range ? `<div><dt>Tested range</dt><dd>${esc(rangeText(range.startOffset, range.excerptLength))}${savedDuration != null ? ` of ${esc(displaySeconds(savedDuration))}` : ""}</dd></div>` : ""}
        <div><dt>Model</dt><dd>${esc(modelDisplay(job.requestedModel || job.resolvedModel))}</dd></div>
        <div><dt>Created</dt><dd>${esc(formatDate(job.createdAt))}</dd></div>
        ${job.elapsedMs != null ? `<div><dt>Elapsed</dt><dd>${esc(timeLabel(job))}</dd></div>` : ""}
      </dl>
      ${range && savedDuration != null ? `<div class="sim-range-meter" aria-label="Tested excerpt range"><span style="left:${Math.max(0, Math.min(100, range.startOffset / Math.max(1, Number(savedDuration)) * 100))}%;width:${Math.max(0, Math.min(100, range.excerptLength / Math.max(1, Number(savedDuration)) * 100))}%"></span></div>` : ""}
      ${error}
      ${activeStatuses.has(job.status) ? simulationProgressMarkup(job) : ""}
      ${output ? `<div><p class="section-label">${esc(runOutputLabel(job))}</p><pre class="output-block sim-generated-output">${esc(output)}</pre></div>` : `<p class="sim-output-pending">${activeStatuses.has(job.status) ? "Waiting for output…" : "No output returned."}</p>`}
      ${speechPatternsMarkup(job)}
      ${prompt != null ? `<details class="sim-prompt-used" data-sim-disclosure="prompt"><summary>Exact prompt used</summary><pre class="output-block">${esc(prompt)}</pre></details>` : ""}
      ${referenceStatus || reference ? `<details class="sim-prompt-used" data-sim-disclosure="reference"><summary>Reference material</summary>${referenceStatus ? `<p>${esc(referenceStatus)}</p>` : ""}${reference ? `<pre class="output-block">${esc(reference)}</pre>` : `<p>No reference material was saved for this run.</p>`}</details>` : ""}
      <details class="sim-prompt-used" data-sim-disclosure="details"><summary>Run details</summary>
        ${recording.fileName ? `<p><strong>Source file:</strong> ${esc(recording.fileName)}</p>` : ""}
        ${recording.label ? `<p><strong>Recording:</strong> ${esc(recording.label)}</p>` : ""}
        ${job.context?.purpose ? `<p><strong>Agent purpose:</strong> ${esc(job.context.purpose)}</p>` : ""}
        ${Array.isArray(job.context?.speechProfileTags) && job.context.speechProfileTags.length ? `<p><strong>Speech profile:</strong> ${esc(job.context.speechProfileTags.join(" · "))}</p>` : ""}
        ${job.audioHashes ? `<p><strong>Audio identity:</strong> Recorded for this run.</p>` : ""}
        ${job.settings ? `<p><strong>Settings:</strong> ${esc(Object.entries(job.settings).filter(([key]) => !/prompt|instruction|id|audiohash/i.test(key)).map(([key, value]) => `${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${String(value)}`).join(" · "))}</p>` : ""}
      </details>
    </section>`;
  }
  function simulationHistory(ctx, sample) {
    const jobs = state.jobs.filter(job => ["baseline", "candidate"].includes(job.kind) &&
      String(job.sampleId) === String(sample?.id)).sort(byCreated);
    if (state.historyLoading) return `<p class="sim-history-empty" aria-busy="true">Loading your runs…</p>`;
    if (state.historyFailed) return `<div class="sim-history-empty" role="alert">${esc(state.error || "We couldn’t load your runs. Please try again.")} <button type="button" class="button secondary small" id="retry-run-history">Try again</button></div>`;
    if (!jobs.length) return `<p class="sim-history-empty">No earlier runs for this recording.</p>`;
    return `<div class="sim-history-list">${jobs.map(job => `<button type="button" class="sim-history-row${String(job.id) === String(state.selectedSimulationJobId) ? " selected" : ""}" data-sim-select-job="${esc(job.id)}">
      <span><strong>${esc(simulationKindText(job.kind))}</strong><small>${esc(sourceFileName(job.recording, sample))} · ${esc(formatDate(job.createdAt))}</small></span>
      <span class="sim-history-end"><span class="sim-state ${esc(String(job.status || "").toLowerCase())}">${esc(simulationStatusText(job.status))}</span><small>${esc(modelDisplay(job.requestedModel || job.resolvedModel))}</small></span>
    </button>`).join("")}</div>`;
  }
  function simulation(ctx) {
    const previousAudio = document.querySelector(".sim-source-audio");
    const previousAudioSrc = previousAudio?.getAttribute("src");
    const openDisclosures = new Set([...document.querySelectorAll("[data-sim-disclosure][open]")].map(item => item.dataset.simDisclosure));
    const sample = currentSample(ctx);
    const active = activeJob();
    const models = state.models;
    const savedModel = ctx.experiment.model || state.selectedModel;
    const selectedModel = models.some(model => model.id === savedModel) ? savedModel :
      (models.some(model => model.id === state.preferred) ? state.preferred :
        (models.some(model => model.id === "ultravox-v0.6") ? "ultravox-v0.6" : models[0]?.id || ""));
    state.selectedModel = selectedModel;
    if (selectedModel && ctx.experiment.model !== selectedModel) {
      ctx.experiment.model = selectedModel;
      ctx.saveExperiment();
    }
    const currentRuns = matchingSimulationRuns(ctx, sample);
    const requestError = state.error && !state.historyFailed
      ? `<div class="error-box" role="alert">${esc(state.error)}${state.simulationRetryKind || state.simulationRetryStopId ? ` <button type="button" class="button secondary small" id="retry-simulation-run">Try again</button>` : ""}</div>`
      : "";
    const selectedRun = state.selectedSimulationJobId
      ? state.jobs.find(job => String(job.id) === String(state.selectedSimulationJobId) && ["baseline", "candidate"].includes(job.kind))
      : currentRuns.candidate || currentRuns.baseline;
    const sampleRange = sample ? currentExcerpt(ctx, sample) : null;
    const sourceRecording = currentRuns.baseline?.recording || currentRuns.candidate?.recording || sample?.recording || {};
    const sourceName = sourceFileName(sourceRecording, sample);
    const useCaseLabel = sample?.use_case_label || sample?.title || "Selected use case";
    const tags = Array.isArray(ctx.experiment.speechProfileTags) ? ctx.experiment.speechProfileTags : [];
    const outputAvailable = [currentRuns.baseline, currentRuns.candidate].some(finishedWithOutput);
    const runStatus = active ? simulationStatusText(active.status) : "";
    const activeLabel = active?.kind === "evaluation" ? "Evaluation" : simulationKindText(active?.kind);
    const matchingCount = state.jobs.filter(job => ["baseline", "candidate"].includes(job.kind) &&
      String(job.sampleId) === String(sample?.id)).length;
    ctx.content.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Evaluation workspace / 02</div><h1>Simulation</h1><p class="page-intro">Run the selected recording with the baseline or your prompt.</p></div><div class="step-count">STEP 02 / 04</div></div>
      ${requestError}
      ${state.submitting ? `<div class="sim-callout sim-starting" role="status">Starting…</div>` : active ? `<div class="panel sim-active-run"><div class="panel-header"><div><h2 class="section-title">${esc(activeLabel)} · ${esc(runStatus)}</h2><p class="section-subtitle">${esc(timeLabel(active))}</p></div><button type="button" class="button secondary small" data-stop-id="${esc(active.id)}">Stop</button></div>${simulationProgressMarkup(active)}${errorMarkup(active)}</div>` : ""}
      <section class="panel sim-summary-panel">
        <div class="panel-header sim-summary-heading"><div><p class="section-label">Selected recording</p><h2 class="section-title">${esc(sourceName)}</h2></div><a class="button secondary small" href="#/setup">Edit setup</a></div>
        ${sample ? `<div class="sim-setup-summary">
          <div><span>Use case</span><strong>${esc(useCaseLabel)}</strong></div>
          <div><span>Agent</span><strong>${esc(ctx.experiment.agentName || "Agent name not set")}</strong><small>${esc(ctx.experiment.purpose || "Purpose not set")}</small></div>
          <div><span>Speech profile</span><strong>${tags.length ? tags.map(tag => esc(tag)).join(" · ") : "No tags added"}</strong></div>
          ${sampleRange ? `<div><span>Tested range</span><strong>${esc(rangeText(sampleRange.startOffset, sampleRange.excerptLength))}</strong><small>of ${esc(displaySeconds(sampleRange.duration))}</small></div>` : ""}
        </div>
        ${sample.audio_url ? `<audio class="sim-source-audio" controls preload="metadata" src="${esc(sample.audio_url)}" aria-label="Listen to ${esc(sourceName)}"></audio>` : `<p class="sim-history-empty">Audio playback isn’t available for this recording.</p>`}
        ${sampleRange ? `<p class="sim-range-caption">The highlighted range is used for both runs.</p><div class="sim-range-meter" aria-hidden="true"><span style="left:${sampleRange.startOffset / Math.max(1, sampleRange.duration) * 100}%;width:${sampleRange.excerptLength / Math.max(1, sampleRange.duration) * 100}%"></span></div>` : ""}
        ` : `<div class="sim-history-empty">Choose a use case in setup to see its recording.</div>`}
      </section>
      <section class="panel sim-config-panel">
        <div class="panel-header"><div><p class="section-label">Run settings</p><h2 class="section-title">Choose a speech model</h2></div></div>
        <div class="sim-model-actions"><div class="field sim-model-field"><label for="model-select">Model</label><select id="model-select" ${!models.length ? "disabled" : ""}>${models.length ? models.map((model, index) => `<option value="${esc(model.id)}"${model.id === selectedModel ? " selected" : ""}>${esc(simulationModelOption(model, index))}</option>`).join("") : `<option value="" disabled selected>${state.modelsLoading ? "Loading speech models…" : "No speech model available"}</option>`}</select>${state.modelError ? `<span class="field-help" role="status">${esc(state.modelError)}</span><button type="button" class="button secondary small" id="refresh-models">Try again</button>` : state.modelsLoading ? `<span class="field-help">Loading speech models…</span>` : ""}</div>
          <div class="sim-run-actions"><button type="button" class="button" id="run-baseline" ${!sample || hasActiveWork() || !models.length ? "disabled" : ""}>Run baseline</button><button type="button" class="button secondary" id="run-candidate" ${!sample || hasActiveWork() || !models.length || !ctx.experiment.prompt ? "disabled" : ""}>Run with my prompt</button></div>
        </div>
        ${!ctx.experiment.prompt ? `<p class="sim-prompt-needed">Add a system prompt before running with your prompt. <a href="#/setup">Add system prompt</a></p>` : ""}
        ${state.modelError && !state.models.length ? `<p class="field-help">Choose a speech model to start a run.</p>` : ""}
      </section>
      <section class="panel sim-results-panel">
        <div class="panel-header"><div><p class="section-label">Current test</p><h2 class="section-title">Recording results</h2></div><span class="sim-count">${matchingCount} saved ${matchingCount === 1 ? "run" : "runs"}</span></div>
        <div class="sim-results-table" role="table" aria-label="Selected recording baseline and prompt results">
          <div class="sim-results-head" role="row"><span role="columnheader">Recording</span><span role="columnheader">Baseline</span><span role="columnheader">Your prompt</span></div>
          <div class="sim-results-row" role="row"><div class="sim-recording-cell" role="cell"><strong>${esc(sourceName)}</strong><small>${esc(useCaseLabel)}</small></div><div role="cell">${simulationCell(currentRuns.baseline, "baseline")}</div><div role="cell">${simulationCell(currentRuns.candidate, "candidate")}</div></div>
        </div>
        ${outputAvailable ? `<a class="button sim-continue" href="#/scorecard">Continue to Scorecard</a>` : ""}
        ${selectedRun ? simulationRunDetails(selectedRun, sample, ctx) : `<p class="sim-history-empty">Select a result to inspect its output.</p>`}
      </section>
      <details class="panel sim-history-panel" data-sim-disclosure="history"><summary>Earlier runs <span class="sim-count">${matchingCount}</span></summary><div class="sim-history-body">
        ${simulationHistory(ctx, sample)}
        <button type="button" class="button secondary small" id="refresh-runs">Try again</button>
      </div></details>`;
    const audioPlaceholder = document.querySelector(".sim-source-audio");
    if (previousAudio && audioPlaceholder && sample?.audio_url && previousAudioSrc === sample.audio_url) {
      audioPlaceholder.replaceWith(previousAudio);
    }
    document.querySelectorAll("[data-sim-disclosure]").forEach(item => {
      if (openDisclosures.has(item.dataset.simDisclosure)) item.open = true;
    });
    bindSimulation(ctx);
  }
  async function startBaselineRun(ctx) {
    const sample = currentSample(ctx);
    const model = currentModel(ctx);
    if (!sample || hasActiveWork() || !model) return;
    const range = currentExcerpt(ctx, sample);
    state.error = "";
    state.simulationRetryKind = null;
    state.simulationRetryStopId = null;
    state.submitting = true;
    simulation(ctx);
    try {
      const body = await request("/api/runs", { method: "POST", body: JSON.stringify({
        mode: "baseline",
        sampleId: sample.id,
        startOffset: range.startOffset,
        excerptLength: range.excerptLength,
        model,
        context: requestContext(ctx.experiment),
        referenceMaterial: ctx.experiment.reference || "",
        useCase: useCaseSnapshot(sample)
      }) });
      const job = body?.job || body;
      if (!job?.id) throw new Error("The run was accepted without a job identifier.");
      state.selectedSimulationJobId = job.id;
      mergeJob(job);
      await refreshRuns(ctx, true);
    } catch (error) {
      state.error = friendlyError(error);
      state.simulationRetryKind = "baseline";
    } finally {
      state.submitting = false;
      renderVisible(ctx);
    }
  }
  async function startCandidateRun(ctx) {
    const sample = currentSample(ctx);
    const model = currentModel(ctx);
    const prompt = ctx.experiment.prompt;
    if (!sample || !prompt || hasActiveWork() || !model) return;
    const range = currentExcerpt(ctx, sample);
    const baseline = finishedMatchingBaseline(ctx, sample);
    const pairedBaselineId = isFinishedRun(baseline) ? baseline.id : undefined;
    state.error = "";
    state.simulationRetryKind = null;
    state.simulationRetryStopId = null;
    state.submitting = true;
    simulation(ctx);
    try {
      const body = await request("/api/runs", { method: "POST", body: JSON.stringify({
        mode: "candidate",
        sampleId: sample.id,
        startOffset: range.startOffset,
        excerptLength: range.excerptLength,
        model,
        context: requestContext(ctx.experiment),
        referenceMaterial: ctx.experiment.reference || "",
        useCase: useCaseSnapshot(sample),
        ...(pairedBaselineId ? { pairedBaselineId } : {})
      }) });
      const job = body?.job || body;
      if (!job?.id) throw new Error("The run was accepted without a job identifier.");
      state.selectedSimulationJobId = job.id;
      mergeJob(job);
      await refreshRuns(ctx, true);
    } catch (error) {
      state.error = friendlyError(error);
      state.simulationRetryKind = "candidate";
    } finally {
      state.submitting = false;
      renderVisible(ctx);
    }
  }
  function editMarkup(edit) {
    return `<div class="edit-item"><strong>${esc(updateTypeText(edit.type))}</strong><p>${esc(edit.rationale || "A prompt improvement was suggested.")}</p><pre class="output-block">${esc(edit.newText || "")}</pre></div>`;
  }
  function evaluationJobs(ctx) {
    return state.jobs.filter(job => job.kind === "evaluation" && job.reviewStage !== "after").sort(byCreated);
  }
  function evaluationForScore(ctx) {
    const sample = currentSample(ctx);
    const key = sampleKey(sample);
    const jobs = evaluationJobs(ctx);
    if (state.scorecardHidden[key]) return null;
    const selectedId = state.scorecardSelection[key];
    if (selectedId) {
      const selected = state.jobs.find(job => job.kind === "evaluation" && job.reviewStage !== "after" && String(job.id) === String(selectedId));
      if (selected) return selected;
    }
    return sample ? jobs.find(job => String(job.sampleId) === String(sample.id)) || null : null;
  }
  function shouldRenderEvaluation(ctx, id) {
    if (!["#/simulation", "#/scorecard"].includes(location.hash)) return false;
    const latest = window.__cadenceRenderContext || ctx;
    if (location.hash === "#/scorecard") return String(evaluationForScore(latest)?.id) === String(id);
    return String(selectJob(latest)?.id) === String(id);
  }
  function ensureEvaluationDetail(ctx, id, retry = false) {
    const key = String(id);
    if (state.details.has(key) && !retry) return;
    if (state.detailsLoading.has(key)) return;
    if (retry) state.detailErrors.delete(key);
    state.detailsLoading.add(key);
    request(`/api/evaluations/${encodeURIComponent(key)}`)
      .then(body => {
        const full = body?.evaluation || body?.job || body;
        if (!full || typeof full !== "object") throw new Error("Evaluation detail response was empty.");
        const detail = { ...full, id: full.id ?? id };
        state.details.set(key, detail);
        state.detailErrors.delete(key);
        mergeJob(detail);
      })
      .catch(error => state.detailErrors.set(key, friendlyError(error, "We couldn’t load this evaluation. Please try again.")))
      .finally(() => {
        state.detailsLoading.delete(key);
        if (shouldRenderEvaluation(ctx, key)) renderVisible(window.__cadenceRenderContext || ctx);
      });
  }
  function evaluationStateSnapshot(ctx, evaluation) {
    const sample = currentSample(ctx);
    return {
      sampleId: sample?.id ?? null,
      startOffset: Number(ctx.experiment.startOffset) || 0,
      excerptLength: ctx.experiment.excerptLength,
      model: currentModel(ctx, evaluation?.requestedModel || ""),
      useCaseId: ctx.experiment.useCaseId ?? sample?.id ?? null,
      prompt: ctx.experiment.prompt || "",
      agentName: ctx.experiment.agentName || "",
      purpose: ctx.experiment.purpose || "",
      speechProfileTags: Array.isArray(ctx.experiment.speechProfileTags) ? ctx.experiment.speechProfileTags.slice() : []
    };
  }
  function auditKey(id, signature) { return `${id}::${signature}`; }
  function ensureEvaluationState(ctx, evaluation, snapshot, signature) {
    const id = String(evaluation.id);
    const key = auditKey(id, signature);
    if (state.audits.has(key) || state.auditsLoading.has(key) || state.auditErrors.has(key)) return;
    state.auditsLoading.add(key);
    request(`/api/evaluations/${encodeURIComponent(id)}/state`, {
      method: "POST",
      body: JSON.stringify(snapshot)
    }).then(body => {
      state.audits.set(key, body?.state || body);
      state.auditErrors.delete(key);
    }).catch(error => {
      state.auditErrors.set(key, friendlyError(error, "We couldn’t check whether this review matches your current setup."));
    }).finally(() => {
      state.auditsLoading.delete(key);
      const latest = window.__cadenceRenderContext || ctx;
      const current = evaluationForScore(latest);
      const currentSnapshot = current ? evaluationStateSnapshot(latest, current) : null;
      if (current && String(current.id) === id && JSON.stringify(currentSnapshot) === signature && location.hash === "#/scorecard") {
        renderVisible(latest);
      }
    });
  }
  function statusLabel(status) {
    return ({
      issue: "Needs attention",
      ok: "Looks good",
      not_observed: "Not observed",
      assessed: "Reviewed",
      not_assessed: "Not assessed",
      none: "Not covered",
      partial: "Partly covered",
      full: "Covered"
    })[String(status || "").toLowerCase()] || "Reviewed";
  }
  function weightValue(value) {
    if (value == null) return "—";
    return typeof value === "number" ? `${value}%` : String(value);
  }
  function themeLabel(evaluation, id) {
    const theme = (evaluation.rubric?.themes || []).find(item => String(item.id) === String(id));
    if (theme?.label) return theme.label;
    const parameter = (evaluation.parsedResult?.parameters || []).find(item => String(item.theme) === String(id));
    return parameter?.themeLabel || "Related area";
  }
  function themeCardsMarkup(evaluation) {
    const rubricThemes = Array.isArray(evaluation.rubric?.themes) ? evaluation.rubric.themes : [];
    const scores = Array.isArray(evaluation.computedScores?.themes) ? evaluation.computedScores.themes : [];
    const themes = rubricThemes.length ? rubricThemes.map(theme => ({ ...theme, ...(scores.find(score => String(score.id) === String(theme.id)) || {}) })) : scores;
    const parameters = Array.isArray(evaluation.parsedResult?.parameters) ? evaluation.parsedResult.parameters : [];
    if (!themes.length) return `<div class="sim-empty">Theme assessment details were not included in this saved review.</div>`;
    return `<div class="theme-list">${themes.map((theme, index) => {
      const key = String(theme.id || `theme-${index}`);
      const themeParameters = parameters.filter(parameter => String(parameter.theme) === String(theme.id));
      const weight = theme.weight ?? evaluation.rubric?.weights?.[theme.id];
      const assessed = theme.assessed === true && typeof theme.score === "number";
      const score = assessed ? String(theme.score) : "Not assessed";
      const open = state.openThemes.has(key) ? " open" : "";
      const parameterMarkup = themeParameters.length ? themeParameters.map(parameter => {
        const issue = parameter.status === "issue";
        return `<article class="parameter-row${issue ? " issue" : ""}">
          <div class="parameter-heading"><strong>${esc(parameter.label || "Guideline")}</strong><span class="parameter-status ${esc(parameter.status || "not_observed")}">${esc(statusLabel(parameter.status))}</span>${parameter.modelProposed ? `<span class="model-proposed">Added for this agent</span>` : ""}</div>
          ${parameter.good ? `<p><span class="detail-caption">Expected</span>${esc(parameter.good)}</p>` : ""}
          ${parameter.observed ? `<p><span class="detail-caption">In transcript</span>${esc(parameter.observed)}</p>` : ""}
        </article>`;
      }).join("") : `<p class="field-help">No details for this area.</p>`;
      return `<details class="theme-card${theme.status === "issue" ? " has-issue" : ""}" data-theme-id="${esc(key)}"${open}>
        <summary><span class="theme-title"><strong>${esc(theme.label || "Listening area")}</strong><span class="theme-weight">${esc(weightValue(weight))} weight</span></span>
          <span class="theme-result">${assessed ? `<strong>${esc(score)}</strong><span>score</span>` : `<strong>Not assessed</strong>`}</span></summary>
        <div class="theme-meta">${esc(statusLabel(theme.status || (assessed ? "assessed" : "not_assessed")))}</div>
        <div class="parameter-list">${parameterMarkup}</div>
      </details>`;
    }).join("")}</div>`;
  }
  function severityRank(severity) { return ({ critical: 0, high: 1, medium: 2, low: 3 })[severity] ?? 4; }
  function findingMarkup(finding) {
    const quiet = finding.severity === "medium" || finding.severity === "low";
    const coverage = statusLabel(finding.prompt_coverage);
    return `<article class="finding-card${quiet ? " quieter" : ""}">
      <div class="finding-heading"><span class="severity ${esc(finding.severity || "medium")}">${esc(finding.severity || "medium")}</span><span class="finding-theme">${esc(finding.parameterLabel || finding.themeLabel || "Related area")}</span>${finding.confidence != null ? `<span class="finding-confidence">Confidence ${esc(finding.confidence)}${Number(finding.confidence) <= 1 ? "" : "%"}</span>` : ""}</div>
      <h3>${esc(finding.title || "Finding")}</h3>
      ${finding.quote ? `<blockquote>${esc(finding.quote)}</blockquote>` : `<p class="field-help">No transcript quote was supplied.</p>`}
      ${finding.why_it_matters ? `<p>${esc(finding.why_it_matters)}</p>` : ""}
      <div class="finding-coverage"><span>Prompt coverage · ${esc(coverage)}</span>${finding.coverage_quote ? `<blockquote><span class="detail-caption">Prompt wording</span>${esc(finding.coverage_quote)}</blockquote>` : ""}</div>
    </article>`;
  }
  function speechLabel(value, fallback = "Speech patterns") {
    const clean = String(value || "").replace(/^\s*(?:pattern\s*:\s*)+/i, "").trim();
    if (!clean || /^(?:uncategorized|untitled|related area|prompt guidance)$/i.test(clean)) return fallback;
    return clean.charAt(0).toLocaleUpperCase() + clean.slice(1);
  }
  function findingTitle(value, groupLabel) {
    const title = String(value || "").replace(/^\s*(?:pattern\s*:\s*)+/i, "").trim();
    if (!title) return "";
    const group = String(groupLabel || "").trim();
    return group && title.toLocaleLowerCase().startsWith(`${group.toLocaleLowerCase()}:`)
      ? title.slice(group.length + 1).trim() : title.toLocaleLowerCase() === group.toLocaleLowerCase() ? "" : title;
  }
  function confidenceLabel(value) {
    const level = String(value ?? "").trim().replace(/%$/, "").toLowerCase();
    if (["high", "medium", "low"].includes(level)) return `${level.charAt(0).toUpperCase()}${level.slice(1)} confidence`;
    if (value == null || value === "") return "";
    return `Confidence ${String(value)}${Number(value) <= 1 ? "" : "%"}`;
  }
  function enhancedFindingMarkup(finding, groupLabel = "") {
    const quiet = finding.severity === "medium" || finding.severity === "low";
    const coverageValue = String(finding.prompt_coverage || "").toLowerCase();
    const coverageKind = ({
      partial: "partial",
      partly_covered: "partial",
      full: "full",
      covered: "full"
    })[coverageValue] || "";
    const coverage = ({
      none: "Your current prompt does not cover this speech pattern",
      not_covered: "Your current prompt does not cover this speech pattern",
      partial: "Your current prompt partly addresses this speech pattern",
      partly_covered: "Your current prompt partly addresses this speech pattern",
      full: "Your current prompt addresses this speech pattern",
      covered: "Your current prompt addresses this speech pattern"
    })[coverageValue] || "";
    const referenceQuote = typeof finding.referenceQuote === "string" ? finding.referenceQuote.trim() : "";
    const verifiedReference = finding.referenceVerified === true && referenceQuote;
    const title = findingTitle(finding.title, groupLabel);
    const missed = Array.isArray(finding.missedItems) ? finding.missedItems.filter(item => item && (item.label || item.id)) : [];
    const confidence = confidenceLabel(finding.confidence);
    return `<article class="finding-card enhanced-finding${quiet ? " quieter" : ""}">
      <div class="finding-heading"><span class="severity ${esc(finding.severity || "medium")}">${esc(finding.severity || "medium")}</span>${confidence ? `<span class="finding-confidence">${esc(confidence)}</span>` : ""}</div>
      ${title ? `<h3>${esc(title)}</h3>` : ""}
      ${verifiedReference
        ? `<div class="finding-quote-pair"><blockquote><span class="detail-caption">What the caller said</span>${esc(referenceQuote)}</blockquote><blockquote><span class="detail-caption">What the agent produced</span>${esc(finding.quote || "")}</blockquote></div>`
        : `${finding.quote ? `<blockquote><span class="detail-caption">What the agent produced</span>${esc(finding.quote)}</blockquote>` : `<p class="field-help">No agent quote was supplied.</p>`}<p class="missing-reference-state">${finding.referenceVerified === true ? "The verified reference quote wasn’t included with this finding." : "A matching reference quote wasn’t available to verify this finding."}</p>`}
      ${finding.accessibilityImpact ? `<p><span class="detail-caption">Accessibility impact</span>${esc(finding.accessibilityImpact)}</p>` : finding.why_it_matters ? `<p>${esc(finding.why_it_matters)}</p>` : ""}
      ${missed.length ? `<div class="finding-missed-items"><strong>Missing key items</strong><ul>${missed.map(item => `<li>${esc(item.label || item.id)}</li>`).join("")}</ul></div>` : ""}
      ${typeof finding.potentialRecoveryPoints === "number" && Number.isFinite(finding.potentialRecoveryPoints) ? `<p class="recovery-estimate">Up to ${esc(finding.potentialRecoveryPoints)} accessibility points from key details (estimate).</p>` : ""}
      ${coverage ? `<div class="finding-coverage"><span>${esc(coverage)}</span>${coverageKind && finding.coverage_quote ? `<blockquote><span class="detail-caption">Relevant prompt sentence</span>${esc(finding.coverage_quote)}</blockquote>` : ""}</div>` : ""}
    </article>`;
  }
  function groupedFindingsMarkup(findings) {
    if (!findings.length) return `<div class="quiet-empty">No findings to show.</div>`;
    const grouped = new Map();
    findings.forEach(finding => {
      const fallback = finding.parameterLabel || finding.themeLabel || finding.category || "";
      const label = speechLabel(finding.speechPattern || fallback);
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label).push(finding);
    });
    return `<div class="finding-pattern-groups enhanced-findings">${[...grouped.entries()].map(([label, items]) => `<section class="finding-pattern-group">
      <h3>${esc(label)}</h3><div class="finding-list">${items.map(item => enhancedFindingMarkup(item, label)).join("")}</div>
    </section>`).join("")}</div>`;
  }
  function exactDiffMarkup(diff) {
    if (!Array.isArray(diff) || !diff.length) return `<div class="sim-empty">No prompt changes to display.</div>`;
    return `<div class="diff" aria-label="Prompt changes">${diff.map(line => `<div class="diff-line ${line.type === "added" ? "added" : line.type === "removed" ? "removed" : ""}">${esc(line.text ?? "")}</div>`).join("")}</div>`;
  }
  function scoreSummaryMarkup(evaluation, useCaseMismatch) {
    const scores = evaluation.computedScores || {};
    if (useCaseMismatch) return `<div class="error-box"><strong>This review belongs to a different use case.</strong> Choose it from saved reviews to see its details.</div>`;
    const overall = scores.overall;
    const unavailable = typeof overall !== "number" || !Number.isFinite(overall);
    const coverage = scores.evidenceCoverage || {};
    const critical = scores.safetyCriticalGap;
    return `<section class="score-hero">
      <div class="score-hero-copy"><p class="section-label">Prompt readiness score</p>
        ${unavailable ? `<p class="score-unavailable">Not enough speech in this excerpt to score. Try a longer excerpt.</p>` : `<div class="overall-score"><strong>${esc(overall)}</strong><span>/ 100</span></div>`}
        <div class="score-badges">${scores.band ? `<span class="score-band">${esc(scores.band)}</span>` : ""}${scores.provisional ? `<span class="provisional-badge">Based on a partial transcript, so results may be incomplete.</span>` : ""}</div>
      </div>
      <p class="evidence-summary">${coverage.excerptLength && coverage.wordCount != null
        ? `Based on a ${esc(excerptAdjective(coverage.excerptLength))} excerpt of about ${esc(coverage.wordCount)} words.`
        : "Based on the selected transcript excerpt."}</p>
      ${critical ? `<div class="critical-gap" role="alert"><strong>Safety-critical gap</strong><span>${esc(typeof critical === "string" ? critical : critical.title || critical.message || "This area needs attention.")}</span></div>` : ""}
    </section>`;
  }
  function excerptAdjective(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?$/i);
    if (match) return `${match[1]}-second`;
    const already = text.match(/^(\d+(?:\.\d+)?)-second$/i);
    return already ? `${already[1]}-second` : text || "selected";
  }
  function addressLabels(evaluation, addresses) {
    const values = Array.isArray(addresses) ? addresses : [addresses];
    const findings = Array.isArray(evaluation.verifiedFindings) ? evaluation.verifiedFindings : [];
    const parameters = Array.isArray(evaluation.parsedResult?.parameters) ? evaluation.parsedResult.parameters : [];
    return values.map(value => {
      const key = String(value || "");
      const finding = findings.find(item => String(item.id) === key || String(item.parameter_id) === key);
      if (finding) return finding.title || finding.parameterLabel || "Related finding";
      const parameter = parameters.find(item => String(item.id) === key);
      if (parameter) return parameter.label || "Related guideline";
      return /^[a-z0-9_-]+$/i.test(key) ? "Related finding" : key;
    }).filter(Boolean).join(", ");
  }
  function updateTypeText(type) {
    return ({ insert_after: "Add instruction", replace: "Replace instruction", append: "Add at the end" })[type] || "Prompt suggestion";
  }
  function promptUpdatesMarkup(evaluation) {
    const updates = Array.isArray(evaluation.promptUpdates) ? evaluation.promptUpdates.slice() : [];
    updates.sort((a, b) => {
      const priority = update => typeof update.priorityHundredths === "number" ? update.priorityHundredths :
        (typeof update.priorityPoints === "number" ? update.priorityPoints * 100 : -Infinity);
      return priority(b) - priority(a);
    });
    if (!updates.length) return `<div class="sim-empty">No prompt changes were suggested.</div>`;
    return `<div class="prompt-update-list">${updates.map(update => {
      const addresses = addressLabels(evaluation, update.addresses);
      const priority = update.priorityPoints != null ? `${update.priorityPoints} points` : "";
      return `<article class="prompt-update">
        <div class="prompt-update-heading">${priority ? `<span class="update-priority">${esc(priority)}</span>` : ""}<span class="update-category">${esc(update.category || "Prompt suggestion")}</span><span class="update-type">${esc(updateTypeText(update.type))}</span></div>
        ${update.addresses ? `<p><span class="detail-caption">Addresses</span>${esc(addresses)}</p>` : ""}
        ${update.rationale ? `<p>${esc(update.rationale)}</p>` : ""}
        <pre class="output-block prompt-update-text">${esc(update.new_text || "")}</pre>
        ${update.expected_effect ? `<p><span class="detail-caption">Expected effect</span>${esc(update.expected_effect)}</p>` : ""}
        ${update.verify_by ? `<p><span class="detail-caption">Verify by</span>${esc(update.verify_by)}</p>` : ""}
      </article>`;
    }).join("")}</div>`;
  }
  function scoreCalculationMarkup(evaluation) {
    return `<details class="score-disclosure"><summary>How the score is calculated</summary>
      <p>Each listening area contributes according to its importance. Findings are considered by seriousness, confidence, and how clearly your prompt already covers them. The result reflects this transcript.</p>
    </details>`;
  }
  function runDetailsMarkup(evaluation) {
    if (!evaluation) return "";
    const snapshot = evaluation.runSnapshot || {
      sampleId: evaluation.sampleId,
      useCase: evaluation.useCase,
      baselineId: evaluation.baselineId,
      startOffset: evaluation.startOffset,
      excerptLength: evaluation.excerptLength,
      requestedModel: evaluation.requestedModel,
      resolvedModel: evaluation.resolvedModel
    };
    const flagList = Array.isArray(evaluation.validationFlags) ? evaluation.validationFlags : [];
    const flagText = flag => typeof flag === "string" ? flag :
      flag?.message || flag?.description || flag?.name || flag?.type || "Review detail";
    const timingRows = evaluation.timings && typeof evaluation.timings === "object"
      ? Object.entries(evaluation.timings).map(([label, value]) => `<li>${esc(label)}: ${esc(typeof value === "number" ? `${value} ms` : String(value))}</li>`).join("")
      : "";
    const normal = `<dl class="run-details-list">
        ${evaluation.requestedModel ? `<div><dt>Requested speech model</dt><dd>${esc(evaluation.requestedModel)}</dd></div>` : ""}
        ${evaluation.resolvedModel ? `<div><dt>Resolved speech model</dt><dd>${esc(evaluation.resolvedModel)}</dd></div>` : ""}
        ${evaluation.rubric_version ? `<div><dt>Review version</dt><dd>${esc(evaluation.rubric_version)}</dd></div>` : ""}
        ${evaluation.useCase?.label || evaluation.useCaseLabel ? `<div><dt>Use case</dt><dd>${esc(evaluation.useCase?.label || evaluation.useCaseLabel)}</dd></div>` : ""}
      </dl>
      ${evaluation.context?.systemPrompt ? outputSection("System prompt used", evaluation.context.systemPrompt) : ""}
      ${evaluation.userInputTranscript ? outputSection(rawOutputLabel(evaluation, "Transcript"), evaluation.userInputTranscript) : ""}
      ${evaluation.evaluatorInput ? outputSection("Evaluation input", evaluation.evaluatorInput) : ""}
      ${evaluation.rawOutput ? outputSection(rawOutputLabel(evaluation, "Review response"), evaluation.rawOutput) : ""}
      ${timingRows ? `<div><p class="section-label">Timing</p><ul class="run-detail-flags">${timingRows}</ul></div>` : ""}
      ${flagList.length ? `<div><p class="section-label">Review notes</p><ul class="run-detail-flags">${flagList.map(flag => `<li>${esc(flagText(flag))}</li>`).join("")}</ul></div>` : ""}`;
    const developer = debugMode() ? `<details class="score-disclosure run-details-developer"><summary>Developer details</summary>
      ${outputSection("Run snapshot", debugJson(snapshot))}
      ${outputSection("Evaluation context", debugJson(evaluation.context || {}))}
      ${outputSection("Review framework", debugJson(evaluation.rubric))}
      ${outputSection("Unverified list", debugJson(evaluation.unverifiedFindings))}
      ${outputSection("Dropped items", debugJson(evaluation.droppedItems))}
      ${outputSection("Parsed parameters", debugJson(evaluation.parsedResult?.parameters))}
      ${outputSection("Parsed findings", debugJson(evaluation.parsedResult?.findings))}
      ${outputSection("Stored prompt edits", debugJson(evaluation.parsedResult?.promptEdits))}
      ${outputSection("Parsed evaluation", debugJson(evaluation.parsedResult))}
      ${evaluation.diagnostics ? outputSection("Diagnostics", debugJson(evaluation.diagnostics)) : ""}
      ${evaluation.settings ? outputSection("Settings", debugJson(evaluation.settings)) : ""}
    </details>` : "";
    return `<details class="score-disclosure run-details"><summary>Run details</summary>${normal}${developer}</details>`;
  }
  function friendlyStateReason(reason) {
    const value = String(reason || "").toLowerCase();
    if (/prompt/.test(value)) return "Your prompt has changed since this evaluation.";
    if (/model/.test(value)) return "The selected speech model has changed.";
    if (/sample|audio|excerpt|offset|recording/.test(value)) return "The recording or excerpt has changed.";
    if (/use.?case/.test(value)) return "The selected use case has changed.";
    if (/context|agent|purpose|tag/.test(value)) return "Agent details have changed.";
    if (/baseline/.test(value)) return "Run a new baseline transcript before evaluating these changes.";
    return "Your setup has changed since this evaluation.";
  }
  function evaluationOutOfDateMarkup(evaluation, audit, auditError, auditLoading, useCaseMismatch, promptChanged) {
    const reasons = Array.isArray(audit?.reasons) ? audit.reasons : [];
    const outOfDate = Boolean(audit?.outOfDate || useCaseMismatch);
    if (auditLoading) return `<p class="review-audit-status" role="status">Checking your setup…</p>`;
    if (auditError) return `<div class="review-note" role="status">We couldn’t check whether this review matches your current setup. <button type="button" class="button secondary small" id="retry-state-audit">Try again</button>${debugMode() ? `<details><summary>Developer details</summary><p>${esc(safeDebugText(auditError))}</p></details>` : ""}</div>${promptChanged ? `<p class="review-note earlier-prompt">Your prompt has changed since this evaluation.</p>` : ""}`;
    return `${outOfDate ? `<div class="out-of-date-banner"><span class="out-of-date-tag">Out of date</span><div><strong>This review reflects an earlier setup.</strong>${reasons.length ? `<ul>${reasons.map(reason => `<li>${esc(friendlyStateReason(reason))}</li>`).join("")}</ul>` : useCaseMismatch ? `<p>The selected use case has changed.</p>` : ""}${audit?.contextChanged ? `<p>Agent details have changed.</p>` : ""}${audit?.requiresNewBaseline ? `<p>Run a new baseline transcript before evaluating these changes.</p>` : ""}${debugMode() ? `<details><summary>Developer details</summary>${outputSection("State reasons", debugJson(audit?.reasons || []))}</details>` : ""}</div></div>` : ""}
       ${promptChanged ? `<p class="review-note earlier-prompt">Your prompt has changed since this evaluation.</p>` : ""}`;
  }
  function useCaseMismatch(evaluation, sample, ctx) {
    const evaluated = evaluation.useCase?.id ?? evaluation.useCaseId ?? evaluation.context?.useCaseId ?? evaluation.sampleId;
    const current = ctx.experiment.useCaseId ?? sample?.id;
    return evaluated != null && current != null && String(evaluated) !== String(current);
  }
  function resultPerformanceMarkup(candidate, sample) {
    const performance = candidate?.performance || {};
    const complete = isFinishedRun(candidate) && !candidate.outputPartial;
    const keyItems = Number.isInteger(performance.keyItemsCaptured) && Number.isInteger(performance.keyItemsTotal)
      ? `${performance.keyItemsCaptured} of ${performance.keyItemsTotal}`
      : "Not enough information to score this yet";
    const outcome = typeof performance.outcome === "string" && performance.outcome.trim()
      ? performance.outcome
      : "Not enough information to score this yet";
    const accuracy = typeof performance.wordAccuracy === "number" && Number.isFinite(performance.wordAccuracy)
      ? `${performance.wordAccuracy}%`
      : "Not enough information to score this yet";
    const accessibility = typeof performance.accessibilityScore === "number" && Number.isFinite(performance.accessibilityScore)
      ? String(performance.accessibilityScore)
      : "Not enough information to score this yet";
    const failureQuote = typeof performance.failureQuote === "string" && performance.failureQuote.trim()
      ? `<blockquote class="performance-quote">${esc(performance.failureQuote)}</blockquote>`
      : "";
    return `<section class="score-section performance-section">
      <div class="score-section-heading"><div><p class="section-label">Results from test</p><h2>${esc(sourceFileName(candidate?.recording, sample || { title: candidate?.useCase?.label }))}</h2>${candidate?.useCase?.label ? `<p class="performance-usecase">${esc(candidate.useCase.label)}</p>` : ""}</div>${candidate ? `<span class="sim-state ${candidate.outputPartial ? "partial" : esc(String(candidate.status || "").toLowerCase())}">${esc(candidate.outputPartial ? "Partial result" : performance.demo ? "Demo scores" : simulationStatusText(candidate.status))}</span>` : ""}</div>
      ${!candidate ? `<div class="performance-empty"><strong>Run with your prompt in Simulation</strong><p>Results are based on a completed run with your current prompt and selected recording.</p><a class="button" href="#/simulation">Go to Simulation</a></div>` :
      !complete ? `<div class="performance-empty"><strong>${esc(simulationStatusText(candidate.status))}</strong><p>${candidate.status === "partial" || candidate.outputPartial ? "This response is partial and can’t be scored as a complete test." : "A completed run is needed to show results."}</p><a class="button secondary" href="#/simulation">Go to Simulation</a></div>` :
        `<div class="performance-grid">
          <article class="performance-primary"><span>Accessibility score</span><strong>${esc(accessibility)}${accessibility !== "Not enough information to score this yet" ? "<small>/ 100</small>" : ""}</strong><p><b>Outcome</b> · ${esc(outcome)}</p></article>
          <article><span>Key items captured</span><strong>${esc(keyItems)}${typeof performance.keyItemsPercent === "number" ? `<small> · ${esc(performance.keyItemsPercent)}%</small>` : ""}</strong></article>
          <article><span>Word accuracy</span><strong>${esc(accuracy)}</strong></article>
        </div>
        ${failureQuote ? `<div class="performance-failure"><p class="detail-caption">Exact response excerpt</p>${failureQuote}</div>` : ""}
        <details class="score-disclosure"><summary>How is this scored?</summary><p>Half the score reflects important key details captured. The other half reflects word accuracy against the matching reference: missed, added and changed words count. The same rules are used before and after a prompt change.</p></details>`}
    </section>`;
  }
  function scorePromptEdits(evaluation) {
    const edits = Array.isArray(evaluation?.promptUpdates) && (evaluation.promptUpdates.length || evaluation.rubric_version) ? evaluation.promptUpdates :
      Array.isArray(evaluation?.parsedResult?.promptEdits) ? evaluation.parsedResult.promptEdits : [];
    return edits.map(edit => ({ ...edit, id: edit.id == null ? "" : String(edit.id) }))
      .sort((a, b) => {
        const priority = item => typeof item.priorityHundredths === "number" ? item.priorityHundredths :
          typeof item.priorityPoints === "number" ? item.priorityPoints * 100 : 0;
        return priority(b) - priority(a);
      });
  }
  function scoreEditGroups(edits) {
    const grouped = new Map();
    edits.forEach(edit => {
      const rawName = edit.category || edit.theme || "Prompt guidance";
      const name = /uncategorized|untitled/i.test(String(rawName)) ? "Prompt guidance" : rawName;
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(edit);
    });
    const groups = [...grouped.entries()];
    if (groups.length <= 4) return groups.map(([label, items]) => ({ label, items }));
    return [
      ...groups.slice(0, 3).map(([label, items]) => ({ label, items })),
      { label: "Other", items: groups.slice(3).flatMap(([, items]) => items) }
    ];
  }
  function verifiedEvidenceForEdit(evaluation, edit) {
    const addresses = Array.isArray(edit.addresses) ? edit.addresses.map(String) :
      edit.addresses == null ? [] : [String(edit.addresses)];
    const findings = Array.isArray(evaluation.verifiedFindings) ? evaluation.verifiedFindings : [];
    return findings.filter(finding => typeof finding.quote === "string" && finding.quote.trim() &&
      (addresses.includes(String(finding.id)) || addresses.includes(String(finding.parameter_id))));
  }
  function scoreEditsMarkup(evaluation, edits, options = {}) {
    if (!edits.length) return `<div class="performance-empty"><p>No prompt changes were suggested for this review.</p></div>`;
    const groups = scoreEditGroups(edits);
    return `<div class="score-edit-groups">${groups.map(group => `<section class="score-edit-group"><h3>${esc(group.label)}</h3><div class="score-edit-list">${group.items.map(edit => {
      const evidence = verifiedEvidenceForEdit(evaluation, edit);
      const typeLabel = edit.type === "replace" ? "Change this wording" : "Add this instruction";
      return `<article class="score-edit-card">
        <div class="score-edit-title"><strong>${esc(/uncategorized|untitled/i.test(String(edit.category || edit.theme || "")) ? group.label : edit.category || edit.theme || group.label)}</strong>${edit.priorityPoints != null ? `<span>${esc(edit.priorityPoints)} points</span>` : ""}</div>
        ${edit.rationale ? `<p>${esc(edit.rationale)}</p>` : ""}
        ${evidence.map(finding => `<div class="score-edit-evidence"><strong>${esc(finding.title || finding.parameterLabel || "Verified finding")}</strong>${finding.quote ? `<blockquote>${esc(finding.quote)}</blockquote>` : ""}</div>`).join("")}
        ${edit.new_text || edit.newText ? `<div class="score-edit-text"><span>${esc(typeLabel)}</span><pre>${esc(edit.new_text ?? edit.newText)}</pre></div>` : ""}
        ${edit.expected_effect ? `<p><span class="detail-caption">Expected effect</span>${esc(edit.expected_effect)}</p>` : ""}
        ${edit.verify_by ? `<p><span class="detail-caption">Check this by</span>${esc(edit.verify_by)}</p>` : ""}
        ${options.showApplyButtons !== false ? `<button type="button" class="button secondary small" data-proposal-edit="${esc(edit.id)}" ${!edit.id || !evaluation.id || hasActiveWork() ? "disabled" : ""}>Apply this change</button>` : ""}
      </article>`;
    }).join("")}</div></section>`).join("")}</div>`;
  }
  function enhancedEditGroups(edits) {
    const grouped = new Map();
    edits.forEach(edit => {
      const rawName = edit.speechPattern || edit.category || edit.theme || "";
      const name = speechLabel(rawName);
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name).push(edit);
    });
    return [...grouped.entries()].map(([label, items]) => ({ label, items }));
  }
  function enhancedPerformanceMarkup(job, sample) {
    if (!job) return `<section class="score-section performance-section"><div class="score-section-heading"><div><p class="section-label">Test results</p><h2>Accessibility score</h2></div></div><div class="performance-grid"><article class="performance-primary"><span>Accessibility score</span><strong class="performance-empty-value">Run a test to see your accessibility score.</strong></article><article><span>Key items captured</span><strong class="performance-empty-value">Run a test to see the key items captured.</strong></article><article><span>Word accuracy</span><strong class="performance-empty-value">Run a test to see word accuracy.</strong></article></div></section>`;
    const actual = job.performance?.demo ? { ...job, performance: undefined } : job;
    return resultPerformanceMarkup(actual, sample)
      .replace('class="score-section performance-section"', 'class="score-section performance-section enhanced-performance-cards"')
      .replaceAll("Not enough information to score this yet", "Add a reference transcript to score this recording")
      .replaceAll("<strong>Add a reference transcript to score this recording", '<strong class="performance-empty-value">Add a reference transcript to score this recording')
      .replace("<p><b>Outcome</b> · Add a reference transcript to score this recording</p>", "");
  }
  function enhancedEvidenceForEdit(evaluation, edit) {
    const addresses = Array.isArray(edit.addresses) ? edit.addresses.map(String) :
      edit.addresses == null ? [] : [String(edit.addresses)];
    const findings = Array.isArray(evaluation.verifiedFindings) ? evaluation.verifiedFindings : [];
    return findings.filter(finding => typeof finding.quote === "string" && finding.quote.trim() &&
      (addresses.length
        ? addresses.includes(String(finding.id)) || addresses.includes(String(finding.parameter_id))
        : edit.speechPattern && String(finding.speechPattern || "") === String(edit.speechPattern)));
  }
  function enhancedEditsMarkup(evaluation, edits, options = {}) {
    if (!edits.length) return `<div class="performance-empty"><p>No prompt changes were suggested for this review.</p></div>`;
    const groups = enhancedEditGroups(edits);
    return `<div class="score-edit-groups enhanced-edits">${groups.map(group => `<section class="score-edit-group"><h3>${esc(group.label)}</h3><div class="score-edit-list">${group.items.map(edit => {
      const evidence = enhancedEvidenceForEdit(evaluation, edit);
      const typeLabel = edit.type === "replace" ? "Change this wording" : "Add this instruction";
      const title = findingTitle(edit.title, group.label);
      const missed = Array.isArray(edit.missedItems) ? edit.missedItems.filter(item => item && (item.label || item.id)) : [];
      return `<article class="score-edit-card">
        ${title ? `<div class="score-edit-title"><strong>${esc(title)}</strong></div>` : ""}
        ${edit.rationale ? `<p>${esc(edit.rationale)}</p>` : ""}
        ${missed.length ? `<div class="finding-missed-items"><strong>Missing key items</strong><ul>${missed.map(item => `<li>${esc(item.label || item.id)}</li>`).join("")}</ul></div>` : ""}
        ${typeof edit.potentialRecoveryPoints === "number" && Number.isFinite(edit.potentialRecoveryPoints) ? `<p class="recovery-estimate">Up to ${esc(edit.potentialRecoveryPoints)} accessibility points from key details (estimate).</p>` : ""}
        ${evidence.map(finding => `<div class="score-edit-evidence">${finding.title && findingTitle(finding.title, group.label) ? `<strong>${esc(findingTitle(finding.title, group.label))}</strong>` : ""}${finding.quote ? `<blockquote><span class="detail-caption">What the agent produced</span>${esc(finding.quote)}</blockquote>` : ""}</div>`).join("")}
        ${edit.new_text || edit.newText ? `<div class="score-edit-text"><span>${esc(typeLabel)}</span><pre>${esc(edit.new_text ?? edit.newText)}</pre></div>` : ""}
        ${edit.expected_effect ? `<p><span class="detail-caption">Expected effect</span>${esc(edit.expected_effect)}</p>` : ""}
        ${edit.verify_by ? `<p><span class="detail-caption">Check this by</span>${esc(edit.verify_by)}</p>` : ""}
        ${options.showApplyButtons !== false ? `<button type="button" class="button secondary small" data-proposal-edit="${esc(edit.id)}" ${!edit.id || !evaluation.id || hasActiveWork() ? "disabled" : ""}>Apply</button>` : ""}
      </article>`;
    }).join("")}</div></section>`).join("")}</div>`;
  }
  function proposalDiffMarkup(diff) {
    if (!Array.isArray(diff)) return "";
    const column = side => diff.filter(item => item.type === "context" || item.type === side)
      .map(item => `<span class="${item.type === "context" ? "" : `prompt-diff-${item.type}`}">${esc(item.text ?? "")}</span>`).join("");
    return `<div class="proposal-diff-columns"><section><h3>Current system prompt</h3><pre>${column("removed")}</pre></section><section><h3>Proposed system prompt</h3><pre>${column("added")}</pre></section></div>`;
  }
  async function buildPromptProposal(ctx, evaluation, selectedEditIds) {
    if (!evaluation?.id) return;
    const key = String(evaluation.id);
    const editIds = Array.isArray(selectedEditIds) ? selectedEditIds.slice() : scorePromptEdits(evaluation).map(edit => edit.id).filter(Boolean);
    if (!editIds.length) return;
    state.proposalSelection.set(key, editIds);
    state.proposalErrors.delete(key);
    state.proposalLoading.add(key);
    scorecard(ctx);
    try {
      const body = await request(`/api/evaluations/${encodeURIComponent(key)}/proposal`, {
        method: "POST",
        body: JSON.stringify({
          selectedEditIds: editIds,
          currentPrompt: evaluation.context?.systemPrompt || ""
        })
      });
      const data = body?.proposal || body;
      if (!data || typeof data.suggestedPrompt !== "string") throw new Error("We couldn’t prepare these prompt changes.");
      state.proposals.set(key, { ...data, selectedEditIds: editIds });
    } catch (error) {
      state.proposalErrors.set(key, friendlyError(error, "We couldn’t prepare these prompt changes. Please try again."));
    } finally {
      state.proposalLoading.delete(key);
      if (location.hash === "#/scorecard" && String(evaluationForScore(window.__cadenceRenderContext || ctx)?.id) === key) {
        scorecard(window.__cadenceRenderContext || ctx);
      }
    }
  }
  function matchingCandidateForEvaluation(evaluation, ctx) {
    const sample = (ctx.samples || []).find(item => String(item.id) === String(evaluation?.sampleId));
    if (!evaluation || !sample) return null;
    const snapshot = evaluation.runSnapshot || {};
    const experiment = {
      ...ctx.experiment,
      selectedId: evaluation.sampleId,
      useCaseId: evaluation.useCase?.id ?? evaluation.useCaseId ?? sample.id,
      model: evaluation.requestedModel || snapshot.requestedModel || ctx.experiment.model,
      prompt: typeof evaluation.context?.systemPrompt === "string" ? evaluation.context.systemPrompt : "",
      startOffset: evaluation.startOffset ?? snapshot.startOffset ?? ctx.experiment.startOffset,
      excerptLength: evaluation.excerptLength ?? snapshot.excerptLength ?? ctx.experiment.excerptLength
    };
    return matchingCandidate(experiment, sample);
  }
  function sandboxForEvaluation(evaluation) {
    return state.jobs.filter(job => job.kind === "candidate" && job.sandbox &&
      String(job.sandbox.sourceEvaluationId) === String(evaluation?.id)).sort(byCreated)[0] || null;
  }
  function previousScorecard(ctx) {
    const sample = currentSample(ctx);
    const jobs = state.jobs.filter(job => job.kind === "evaluation").sort(byCreated);
    const selectedSummary = evaluationForScore(ctx);
    const choices = jobs.map(job => {
      const jobSample = ctx.samples.find(item => String(item.id) === String(job.sampleId));
      const useCaseLabel = job.useCase?.label || job.useCaseLabel || jobSample?.use_case_label || "Saved review";
      return `<option value="${esc(job.id)}"${String(job.id) === String(selectedSummary?.id) ? " selected" : ""}>${esc(useCaseLabel)} · ${esc(formatDate(job.createdAt))} · ${esc(statusText(job.status))}${debugMode() ? ` · ${esc(safeDebugText(job.id))}` : ""}</option>`;
    }).join("");
    const summaryId = selectedSummary ? String(selectedSummary.id) : "";
    if (summaryId && !state.details.has(summaryId) && !state.detailErrors.has(summaryId)) ensureEvaluationDetail(ctx, summaryId);
    const evaluation = summaryId ? state.details.get(summaryId) || selectedSummary : null;
    const detailLoading = Boolean(summaryId && state.detailsLoading.has(summaryId) && !state.details.has(summaryId));
    const detailError = summaryId ? state.detailErrors.get(summaryId) : "";
    const rubricResult = isRubricEvaluation(evaluation);
    const snapshot = evaluation ? evaluationStateSnapshot(ctx, evaluation) : null;
    const signature = snapshot ? JSON.stringify(snapshot) : "";
    const requestKey = evaluation ? auditKey(evaluation.id, signature) : "";
    if (evaluation && state.details.has(String(evaluation.id))) ensureEvaluationState(ctx, evaluation, snapshot, signature);
    const audit = requestKey ? state.audits.get(requestKey) : null;
    const auditLoading = Boolean(requestKey && state.auditsLoading.has(requestKey));
    const auditError = requestKey ? state.auditErrors.get(requestKey) : "";
    const mismatchedUseCase = Boolean(evaluation && useCaseMismatch(evaluation, sample, ctx));
    const promptChanged = Boolean(evaluation && (audit?.promptChanged ||
      (typeof evaluation.context?.systemPrompt === "string" && evaluation.context.systemPrompt !== ctx.experiment.prompt)));
    const outOfDate = evaluationOutOfDateMarkup(evaluation, audit, auditError, auditLoading, mismatchedUseCase, promptChanged);
    const evaluationActive = Boolean(evaluation && activeStatuses.has(evaluation.status));
    const result = evaluation?.parsedResult;
    const issueList = Array.isArray(evaluation?.verifiedFindings)
      ? evaluation.verifiedFindings.slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
      : [];
    const flags = Array.isArray(evaluation?.validationFlags) ? evaluation.validationFlags : [];
    const unverified = Array.isArray(evaluation?.unverifiedFindings) ? evaluation.unverifiedFindings : [];
    const dropped = Array.isArray(evaluation?.droppedItems) ? evaluation.droppedItems : [];
    const updates = Array.isArray(evaluation?.promptUpdates) ? evaluation.promptUpdates : [];
    const unapplied = Array.isArray(evaluation?.unappliedEdits) ? evaluation.unappliedEdits : [];
    const promptAvailable = typeof evaluation?.suggestedPrompt === "string";
    const baseline = evaluation ? forSample(ctx).find(job => job.kind === "baseline" && String(job.id) === String(evaluation.baselineId)) : null;
    const livePartial = baseline?.status === "partial";
    const legacyIssues = Array.isArray(result?.issues) ? result.issues.slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity)) : [];
    const legacyEdits = Array.isArray(result?.promptEdits) ? result.promptEdits : [];
    const legacyDiff = Array.isArray(evaluation?.diff) ? evaluation.diff : [];
    const primaryResultMarkup = !evaluation
       ? state.historyLoading || detailLoading ? `<div class="review-loading" aria-busy="true"><span></span><span></span><span></span>Loading your runs…</div>` : state.historyFailed ? `<div class="scorecard-empty" role="alert"><p>We couldn’t load your saved reviews. Please try again.</p><button type="button" class="button secondary small" id="retry-run-history">Try again</button></div>` : `<div class="scorecard-empty"><strong>${sample ? "No saved reviews yet" : "Choose a use case"}</strong><p>${sample ? "Run a baseline transcript in Simulation, then click Evaluate your voice agent here." : "Start in Set up an eval."}</p></div>`
      : evaluationActive
        ? `<div class="active-review" role="status"><div><span class="live-dot"></span><strong>Evaluation · ${esc(statusText(evaluation.status))}</strong></div>${progressMarkup(evaluation)}${errorMarkup(evaluation)}<p>This review is still running. Results appear when it finishes.</p>${activeStatuses.has(evaluation.status) ? `<button type="button" class="button secondary small" data-stop-id="${esc(evaluation.id)}">Stop</button>` : ""}</div>`
        : detailLoading
          ? `<div class="review-loading" aria-busy="true"><span></span><span></span><span></span>Loading your evaluation…</div>`
          : detailError && !state.details.has(summaryId)
            ? `<div class="error-box"><strong>We couldn’t load this evaluation.</strong> <button type="button" class="button secondary small" id="retry-review-detail">Try again</button>${debugMode() ? `<details><summary>Developer details</summary><p>${esc(safeDebugText(detailError))}</p></details>` : ""}</div>`
            : rubricResult
              ? `${outOfDate}${mismatchedUseCase
                ? `<section class="score-section"><p class="section-label">Saved review</p><h2 class="section-title">This review belongs to a different use case</h2><p class="review-note">Its results aren’t shown for the current use case. You can still open it from saved reviews.</p>${runDetailsMarkup(evaluation)}</section>`
                : `${scoreSummaryMarkup(evaluation, false)}
                  ${result?.summary ? `<section class="score-section review-summary"><p class="section-label">Evaluation summary</p><p>${esc(result.summary)}</p></section>` : ""}
                  <section class="score-section"><div class="score-section-heading"><div><p class="section-label">Listening review</p><h2>What we looked for</h2></div></div>${themeCardsMarkup(evaluation)}</section>
                  <section class="score-section"><div class="score-section-heading"><div><p class="section-label">Findings</p><h2>What we found in the transcript</h2></div></div>${issueList.length ? `<div class="finding-list">${issueList.map(findingMarkup).join("")}</div>` : `<div class="quiet-empty">No findings to show.</div>`}</section>
                  <section class="score-section"><p class="section-label">More about this result</p><div class="review-disclosures">
                    ${scoreCalculationMarkup(evaluation)}
                    ${runDetailsMarkup(evaluation)}
                    ${debugMode() ? `<details class="score-disclosure"><summary>Developer details</summary>
                      ${outputSection("Unverified list", debugJson(unverified))}
                      ${outputSection("Validation flags", debugJson(flags))}
                      ${outputSection("Computed scores", debugJson(evaluation.computedScores))}
                      ${outputSection("Dropped items", debugJson(dropped))}
                      ${outputSection("Parsed parameters", debugJson(result?.parameters))}
                      ${outputSection("Parsed findings", debugJson(result?.findings))}
                      ${outputSection("Stored prompt edits", debugJson(result?.promptEdits))}
                    </details>` : ""}
                  </div></section>`}`
              : result
                ? `${outOfDate}<section class="legacy-review"><div class="legacy-title"><h2>${esc(result.summary || "Evaluation summary")}</h2></div>
                  ${legacyIssues.length ? `<div class="finding-list">${legacyIssues.map(issue => findingMarkup({ ...issue, parameterLabel: issue.category && issue.category !== "Uncategorized" ? issue.category : "Related area", why_it_matters: issue.why })).join("")}</div>` : `<div class="quiet-empty">No findings to show.</div>`}
                  ${debugMode() ? `<details class="score-disclosure"><summary>Developer details</summary>${outputSection("Transcript", safeDebugText(baseline?.userInputTranscript || ""))}${outputSection(rawOutputLabel(evaluation, "Raw evaluator response"), safeDebugText(evaluation.rawOutput || ""))}${legacyDiff.length ? exactDiffMarkup(legacyDiff) : ""}</details>` : ""}
                </section>`
                : `${outOfDate}${errorMarkup(evaluation)}<div class="error-box">We couldn’t finish this evaluation. Please try again.</div>
                  ${evaluation.parseError ? `<button type="button" id="score-retry" class="button small" ${hasActiveWork() || !eligibleBaseline(baseline) ? "disabled" : ""}>Evaluate your voice agent · retry</button>` : ""}
                  ${runDetailsMarkup(evaluation)}`;
    const updatedPromptPanel = rubricResult && evaluation && !evaluationActive && !mismatchedUseCase
      ? `<section class="score-section prompt-revision"><div class="score-section-heading"><div><p class="section-label">Prompt revision</p><h2>Recommended changes</h2><p class="section-subtitle">Your prompt stays as it is until you choose Use.</p></div></div>
        ${promptUpdatesMarkup(evaluation)}
        ${unapplied.length ? `<details class="score-disclosure unapplied-disclosure"><summary>Changes not included (${unapplied.length})</summary><div class="review-list">${unapplied.map(item => `<article class="review-list-item"><strong>${esc(updateTypeText(item.type))}</strong><p>${esc(item.new_text || "This suggestion could not be included.")}</p></article>`).join("")}</div></details>` : ""}
        ${evaluation.promptUpdateSetRejected ? `<div class="review-note">We couldn’t use these prompt suggestions. Your prompt is unchanged.</div>` : ""}
        <section class="server-diff"><div class="score-section-heading"><div><p class="section-label">Prompt changes</p><h2>Line by line</h2></div></div>${exactDiffMarkup(evaluation.diff)}</section>
        <div class="prompt-actions"><button type="button" class="button" id="use-prompt" ${!promptAvailable ? "disabled" : ""}>Use these changes</button><button type="button" class="button secondary" id="copy-prompt" ${!promptAvailable ? "disabled" : ""}>Copy revised prompt</button><button type="button" class="button secondary" id="export-prompt" ${!promptAvailable ? "disabled" : ""}>Download .txt</button></div><p class="copy-feedback" id="prompt-action-feedback" aria-live="polite"></p><div id="manual-copy-slot"></div>
      </section>`
      : evaluation && !rubricResult && result && !evaluationActive && !mismatchedUseCase
        ? `<section class="score-section legacy-edits"><div class="score-section-heading"><div><p class="section-label">Prompt revision</p><h2>Suggested changes</h2></div></div>${legacyEdits.length ? `<div class="edit-list">${legacyEdits.map(editMarkup).join("")}</div>` : `<p class="field-help">No prompt changes were suggested.</p>`}${evaluation.suggestedPrompt ? `<details class="suggested-prompt"><summary>Revised prompt</summary><pre class="output-block">${esc(evaluation.suggestedPrompt)}</pre></details>` : ""}<div class="prompt-actions"><button type="button" class="button" id="apply-suggested" ${typeof evaluation.suggestedPrompt !== "string" ? "disabled" : ""}>Use these changes</button><button type="button" class="button secondary" id="copy-suggested" ${typeof evaluation.suggestedPrompt !== "string" ? "disabled" : ""}>Copy revised prompt</button><button type="button" class="button secondary" id="export-suggested" ${typeof evaluation.suggestedPrompt !== "string" ? "disabled" : ""}>Download .txt</button></div><p class="copy-feedback" id="copy-feedback" aria-live="polite"></p><div id="manual-copy-slot"></div></section>`
        : "";
    const outOfDateTag = evaluation && (audit?.outOfDate || mismatchedUseCase) ? `<span class="out-of-date-tag">Out of date</span>` : "";
    const evaluatedSample = evaluation && ctx.samples.find(item => String(item.id) === String(evaluation.sampleId));
    const evaluatedUseCaseLabel = evaluation?.useCase?.label || evaluation?.useCaseLabel || evaluatedSample?.use_case_label || "Previous use case";
    const evaluatedContextNote = evaluation && mismatchedUseCase
      ? `<div class="out-of-date-banner"><span class="out-of-date-tag">Different use case</span><div><strong>Saved review: ${esc(evaluatedUseCaseLabel)}</strong><p>This review belongs to another use case. Its results aren’t shown here.</p></div></div>`
      : "";
    ctx.content.innerHTML = `<div class="page-heading scorecard-heading"><div><div class="eyebrow">Evaluation workspace / 03</div><h1>Scorecard</h1><p class="page-intro">What we found in the transcript, and how to improve your prompt.</p></div><div class="step-count">STEP 03 / 04</div></div>
      ${state.error && !state.historyFailed ? `<div class="error-box" role="alert">${esc(state.error)}</div>` : ""}
      <section class="scorecard-toolbar panel">
        <div class="scorecard-select"><label for="evaluation-select">Saved reviews</label><select id="evaluation-select" ${!sample || !jobs.length || state.historyLoading ? "disabled" : ""}><option value="">${jobs.length ? "Choose a saved review…" : state.historyLoading ? "Loading your runs…" : "No saved reviews"}</option>${choices}</select>${outOfDateTag}</div>
      </section>
      ${evaluatedContextNote}
      ${evaluation ? `<div class="scorecard-content">${primaryResultMarkup}${updatedPromptPanel}</div>` : primaryResultMarkup}
    `;
    bindScorecard(ctx, evaluation);
  }
  function reviewedRun(evaluation, ctx) {
    if (!evaluation) return matchingSimulationRuns(ctx, currentSample(ctx)).baseline;
    const id = evaluation.evaluatedRunId ?? evaluation.baselineId;
    if (id != null) {
      const linked = state.jobs.find(job => ["baseline", "candidate"].includes(job.kind) && String(job.id) === String(id));
      if (linked) {
        const a = runRange(linked), b = runRange(evaluation);
        const model = evaluation.requestedModel || evaluation.context?.model;
        if ((evaluation.sampleId == null || String(linked.sampleId) === String(evaluation.sampleId)) &&
          (!model || currentModelMatches(linked, model)) && (!a || !b || (numbersMatch(a.startOffset, b.startOffset) && numbersMatch(a.excerptLength, b.excerptLength))) && audioHashesMatch(linked, evaluation)) return linked;
        return null;
      }
    }
    return matchingCandidateForEvaluation(evaluation, ctx);
  }
  function scorecardEmptySections() {
    return `<section class="score-section review-findings"><div class="score-section-heading"><div><p class="section-label">Review findings</p><h2>What went wrong</h2></div></div><p class="quiet-empty">Run a test and review the transcript to see findings.</p></section><section class="score-section"><div class="score-section-heading"><div><p class="section-label">Prompt guidance</p><h2>Recommended prompt edits</h2></div></div><p class="quiet-empty">Review a transcript to see recommended prompt edits.</p></section><section class="score-section score-proposal-preview"><div class="score-section-heading"><div><p class="section-label">Prompt changes</p><h2>Current and proposed</h2></div></div><p class="quiet-empty">Apply a prompt edit to see the current and proposed wording.</p><div class="proposal-test-actions"><button type="button" class="button" disabled>Test these changes</button></div></section>`;
  }
  function scorecard(ctx) {
    const sample = currentSample(ctx);
    const jobs = evaluationJobs(ctx);
    const selectedSummary = evaluationForScore(ctx);
    const choices = jobs.map(job => {
      const jobSample = ctx.samples.find(item => String(item.id) === String(job.sampleId));
      const useCaseLabel = job.useCase?.label || job.useCaseLabel || jobSample?.use_case_label || "Saved review";
      return `<option value="${esc(job.id)}"${String(job.id) === String(selectedSummary?.id) ? " selected" : ""}>${esc(useCaseLabel)} · ${esc(formatDate(job.createdAt))} · ${esc(statusText(job.status))}</option>`;
    }).join("");
    const summaryId = selectedSummary ? String(selectedSummary.id) : "";
    if (summaryId && !state.details.has(summaryId) && !state.detailErrors.has(summaryId)) ensureEvaluationDetail(ctx, summaryId);
    const evaluation = summaryId ? state.details.get(summaryId) || selectedSummary : null;
    const detailLoading = Boolean(summaryId && state.detailsLoading.has(summaryId) && !state.details.has(summaryId));
    const detailError = summaryId ? state.detailErrors.get(summaryId) : "";
    const result = evaluation?.parsedResult;
    const snapshot = evaluation ? evaluationStateSnapshot(ctx, evaluation) : null;
    const signature = snapshot ? JSON.stringify(snapshot) : "";
    const requestKey = evaluation ? auditKey(evaluation.id, signature) : "";
    if (evaluation && state.details.has(String(evaluation.id))) ensureEvaluationState(ctx, evaluation, snapshot, signature);
    const audit = requestKey ? state.audits.get(requestKey) : null;
    const auditLoading = Boolean(requestKey && state.auditsLoading.has(requestKey));
    const auditError = requestKey ? state.auditErrors.get(requestKey) : "";
    const mismatchedUseCase = Boolean(evaluation && useCaseMismatch(evaluation, sample, ctx));
    const promptChanged = Boolean(evaluation && (audit?.promptChanged ||
      (typeof evaluation.context?.systemPrompt === "string" && evaluation.context.systemPrompt !== ctx.experiment.prompt)));
    const outOfDate = evaluationOutOfDateMarkup(evaluation, audit, auditError, auditLoading, mismatchedUseCase, promptChanged);
    const evaluationActive = Boolean(evaluation && activeStatuses.has(evaluation.status));
    const baseline = evaluationBaseline(ctx);
    const retryBaseline = evaluation?.baselineId
      ? state.jobs.find(job => job.kind === "baseline" && String(job.id) === String(evaluation.baselineId))
      : null;
    const isPartialBaseline = baseline?.status === "partial";
    const candidate = reviewedRun(evaluation, ctx);
    const beforeCandidate = evaluation ? matchingCandidateForEvaluation(evaluation, ctx) : null;
    const updates = scorePromptEdits(evaluation);
    const findings = Array.isArray(evaluation?.verifiedFindings)
      ? evaluation.verifiedFindings.filter(finding => typeof finding.quote === "string" && finding.quote.trim())
        .slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
      : [];
    const legacyIssues = !findings.length && Array.isArray(result?.issues)
      ? result.issues.filter(issue => typeof issue.quote === "string" && issue.quote.trim())
        .slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
      : [];
    const unapplied = Array.isArray(evaluation?.unappliedEdits) ? evaluation.unappliedEdits : [];
    const proposal = evaluation ? state.proposals.get(String(evaluation.id)) : null;
    const proposalLoading = Boolean(evaluation && state.proposalLoading.has(String(evaluation.id)));
    const proposalError = evaluation ? state.proposalErrors.get(String(evaluation.id)) : "";
    const sandbox = evaluation ? sandboxForEvaluation(evaluation) : null;
    const sandboxChild = sandbox ? state.jobs.find(job => job.kind === "evaluation" && job.reviewStage === "after" &&
      String(job.parentRunId) === String(sandbox.id)) : null;
    const sandboxActive = Boolean((sandbox && activeStatuses.has(sandbox.status)) ||
      (sandboxChild && activeStatuses.has(sandboxChild.status)));
    const reviewButton = baseline && !hasActiveWork()
      ? `<button type="button" class="button" id="review-results">Evaluate your voice agent</button>`
      : "";
    const emptyReviewMarkup = scorecardEmptySections();
    const resultMarkup = state.submittingEvaluation
      ? `<section class="score-section active-review" role="status"><div><span class="live-dot"></span><strong>Starting your review…</strong></div><div class="review-loading" aria-busy="true"><span></span><span></span><span></span></div></section>`
      : !evaluation
      ? state.historyLoading
        ? `<div class="review-loading" aria-busy="true"><span></span><span></span><span></span>Loading your runs…</div>`
        : state.historyFailed
          ? `<div class="scorecard-empty" role="alert"><p>We couldn’t load your saved reviews. Please try again.</p><button type="button" class="button secondary small" id="retry-run-history">Try again</button></div>`
          : emptyReviewMarkup
      : evaluationActive
        ? `<section class="score-section active-review" role="status"><div><span class="live-dot"></span><strong>Review · ${esc(statusText(evaluation.status))}</strong></div>${progressMarkup(evaluation)}${errorMarkup(evaluation)}<p>Results will appear when the review is complete.</p><button type="button" class="button secondary small" data-stop-id="${esc(evaluation.id)}">Stop</button></section>`
        : detailLoading
          ? `<div class="review-loading" aria-busy="true"><span></span><span></span><span></span>Loading your review…</div>`
          : detailError && !state.details.has(summaryId)
            ? `<div class="error-box" role="alert">We couldn’t load this review. <button type="button" class="button secondary small" id="retry-review-detail">Try again</button></div>`
            : `<div class="scorecard-content">
              ${outOfDate}
              ${mismatchedUseCase ? `<section class="score-section review-note"><strong>This saved review is from ${esc(evaluation.useCase?.label || evaluation.useCaseLabel || "another use case")}.</strong><p>Current setup: ${esc(sample?.use_case_label || "another use case")}. This review remains with its original use case.</p></section>` : ""}
              <section class="score-section review-findings">
                    ${result?.summary ? `<p class="review-summary-copy">${esc(result.summary)}</p>` : ""}
                    <div class="score-section-heading"><div><p class="section-label">Review findings</p><h2>What went wrong</h2></div></div>
                    ${findings.length
                      ? groupedFindingsMarkup(findings)
                      : legacyIssues.length
                        ? groupedFindingsMarkup(legacyIssues.map(issue => ({ ...issue, speechPattern: issue.speechPattern || issue.category || "", why_it_matters: issue.why })))
                        : `<div class="quiet-empty">No findings were saved for this review.</div>`}
              </section>
                  <section class="score-section">
                    <div class="score-section-heading"><div><p class="section-label">Prompt guidance</p><h2>Recommended prompt edits</h2></div></div>
                    ${evaluation.status === "finished" && result ? `<div class="score-proposal-controls"><button type="button" class="button secondary small" id="proposal-all" ${hasActiveWork() || evaluationActive || !updates.some(edit => edit.id) ? "disabled" : ""}>Apply all</button></div>` : ""}
                    ${updates.length ? enhancedEditsMarkup(evaluation, updates) :
                      legacyIssues.length && Array.isArray(result?.promptEdits) && result.promptEdits.length
                        ? enhancedEditsMarkup(evaluation, result.promptEdits)
                        : `<div class="performance-empty"><p>No prompt edits were saved for this review.</p></div>`}
                    ${unapplied.length ? `<details class="score-disclosure unapplied-disclosure"><summary>Could not be applied (${unapplied.length})</summary><div class="review-list">${unapplied.map(item => `<article class="review-list-item"><strong>${esc(updateTypeText(item.type))}</strong><p>${esc(item.new_text || "This suggestion could not be included.")}</p></article>`).join("")}</div></details>` : ""}
                    ${proposalLoading ? `<p class="review-audit-status" role="status">Preparing your prompt changes…</p>` : ""}
                    ${proposalError ? `<div class="error-box" role="alert">${esc(proposalError)} <button type="button" class="button secondary small" id="retry-proposal">Try again</button></div>` : ""}
                    ${proposal ? `<div class="score-proposal-preview">
                      <div class="score-section-heading"><div><p class="section-label">Prompt changes</p><h2>Current and proposed</h2></div></div>
                      ${proposalDiffMarkup(proposal.diff)}
                      <div class="proposal-test-actions">
                        ${beforeCandidate
                          ? `<button type="button" class="button" id="test-changes" ${hasActiveWork() || evaluationActive || sandboxActive ? "disabled" : ""}>Test these changes</button>`
                          : `<div class="performance-empty"><p>Run with your current prompt in Simulation first.</p><a class="button secondary" href="#/simulation">Go to Simulation</a></div>`}
                      </div>
                      ${sandbox ? `<div class="sandbox-run-status" role="status"><strong>${esc(sandbox.sandbox?.stage === "reviewing" ? "Reviewing the response" : sandboxActive ? simulationStatusText(sandbox.status) : sandbox.sandbox?.stage === "complete" ? "Test complete" : "Test started")}</strong>${sandboxActive ? `<span>${esc(timeLabel(sandbox))}</span><button type="button" class="button secondary small" data-stop-id="${esc(sandbox.id)}">Stop</button>` : ""}<a href="#/comparison">Open results summary</a></div>` : ""}
                    </div>` : `<div class="score-proposal-preview"><div class="score-section-heading"><div><p class="section-label">Prompt changes</p><h2>Current and proposed</h2></div></div><p class="quiet-empty">Apply a prompt edit to see the current and proposed wording.</p><div class="proposal-test-actions"><button type="button" class="button" disabled>Test these changes</button></div></div>`}
                  </section>
                  ${evaluation.parseError ? `<div class="error-box">We couldn’t finish this evaluation. Please try again.</div><button type="button" class="button secondary small" id="score-retry" ${hasActiveWork() || !eligibleBaseline(retryBaseline) ? "disabled" : ""}>Evaluate your voice agent · retry</button>` : ""}
              ${runDetailsMarkup(evaluation)}
              ${debugMode() ? `<details class="score-disclosure"><summary>Review diagnostics</summary>
                ${outputSection("Unverified list", debugJson(evaluation.unverifiedFindings))}
                ${outputSection("Validation flags", debugJson(evaluation.validationFlags))}
                ${outputSection("Computed server scores", debugJson(evaluation.computedScores))}
                ${outputSection("Dropped items", debugJson(evaluation.droppedItems))}
                ${outputSection("Parsed parameters", debugJson(result?.parameters))}
                ${outputSection("Parsed findings", debugJson(result?.findings))}
                ${outputSection("Stored prompt edits", debugJson(result?.promptEdits))}
              </details>` : ""}
            </div>`;
    const currentTest = state.submittingEvaluation || evaluationActive || sandboxActive ? "" : enhancedPerformanceMarkup(candidate, sample) + speechPatternsMarkup(candidate, { empty: true });
    const displayedTest = currentTest;
    const baselineForReview = baseline;
    const savedReview = evaluation ? `<div class="scorecard-review-heading"><div><p class="section-label">Your saved review</p><p>${esc(evaluation.useCase?.label || sample?.use_case_label || "Current use case")} · ${esc(formatDate(evaluation.createdAt))}</p></div>${reviewButton}</div>` : "";
    const reviewChoice = evaluation ? savedReview : reviewButton ? `<div class="scorecard-review-heading"><div><p class="section-label">Review your setup</p><p>${baselineForReview?.status === "partial" ? "A partial transcript is available to review." : "Choose a completed baseline transcript to review."}</p></div>${reviewButton}</div>` : "";
     ctx.content.innerHTML = `<div class="page-heading scorecard-heading"><div><div class="eyebrow">Review of your agent</div><h1>Review of your agent</h1><p class="page-intro">What we found in the transcript, and how to improve your prompt.</p></div><div class="step-count">STEP 03 / 04</div></div>
      ${state.error && !state.historyFailed ? `<div class="error-box" role="alert">${esc(state.error)}${state.retryEvaluation ? ` <button type="button" class="button secondary small" id="retry-review-post">Evaluate your voice agent · retry</button>` : ""}</div>` : ""}
      <section class="scorecard-toolbar panel">
        <div class="scorecard-select"><label for="evaluation-select">Saved reviews</label><select id="evaluation-select" ${!sample || !jobs.length || state.historyLoading ? "disabled" : ""}><option value="">${jobs.length ? "Choose a saved review…" : state.historyLoading ? "Loading your runs…" : "No saved reviews yet"}</option>${choices}</select>${evaluation && (audit?.outOfDate || mismatchedUseCase) ? `<span class="out-of-date-tag">Out of date</span>` : ""}</div>
      </section>
      ${displayedTest}
      ${reviewChoice}
      ${resultMarkup}
      ${state.historyFailed && evaluation ? `<div class="error-box" role="alert">We couldn’t load your saved reviews. Please try again. <button type="button" class="button secondary small" id="retry-run-history">Try again</button></div>` : ""}
    `;
    bindScorecard(ctx, evaluation);
  }
  function bindSimulation(ctx) {
    const select = document.getElementById("model-select");
    select?.addEventListener("change", () => {
      state.selectedModel = select.value;
      ctx.experiment.model = select.value;
      ctx.saveExperiment();
      simulation(ctx);
    });
    document.getElementById("refresh-models")?.addEventListener("click", () => refreshModels(ctx));
    document.getElementById("refresh-runs")?.addEventListener("click", () => refreshRuns(ctx));
    document.getElementById("retry-run-history")?.addEventListener("click", () => refreshRuns(ctx));
    document.querySelectorAll("[data-sim-select-job]").forEach(button => button.addEventListener("click", () => {
      state.selectedSimulationJobId = button.dataset.simSelectJob;
      simulation(ctx);
    }));
    document.getElementById("run-baseline")?.addEventListener("click", () => startBaselineRun(ctx));
    document.getElementById("run-candidate")?.addEventListener("click", () => startCandidateRun(ctx));
    document.getElementById("retry-simulation-run")?.addEventListener("click", () => {
      if (state.simulationRetryStopId) stopJob(state.simulationRetryStopId, ctx);
      else if (state.simulationRetryKind === "candidate") startCandidateRun(ctx);
      else if (state.simulationRetryKind === "baseline") startBaselineRun(ctx);
    });
    document.querySelectorAll("[data-repeat-run]").forEach(button => button.addEventListener("click", () => {
      if (button.dataset.repeatRun === "candidate") startCandidateRun(ctx);
      else if (button.dataset.repeatRun === "baseline") startBaselineRun(ctx);
    }));
    document.querySelectorAll("[data-stop-id]").forEach(button => button.addEventListener("click", () => stopJob(button.dataset.stopId, ctx)));
  }
  async function stopJob(id, ctx) {
    try {
      mergeJob(await request(`/api/jobs/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }));
      state.error = "";
      state.simulationRetryStopId = null;
      state.simulationRetryKind = null;
    } catch (error) {
      state.error = friendlyError(error);
      state.simulationRetryStopId = id;
      state.simulationRetryKind = null;
    }
    await refreshRuns(ctx, true);
    renderVisible(ctx);
  }
  async function startEvaluation(ctx, baselineId, retryJob = null) {
    const baseline = evaluationBaseline(ctx, baselineId);
    const sample = currentSample(ctx);
    const model = currentModel(ctx, retryJob?.requestedModel || "");
    if (!baseline || !sample || hasActiveWork() || !model) return;
    const context = requestContext(ctx.experiment);
    state.error = "";
    state.retryEvaluation = false;
    state.retryEvaluationBaselineId = null;
    state.submitting = true;
    state.submittingEvaluation = true;
    publishEvaluationLock();
    renderVisible(ctx);
    try {
      const body = await request("/api/evaluations", { method: "POST", body: JSON.stringify({
        baselineId: baseline.id,
        model,
        context,
        useCase: useCaseSnapshot(sample),
        referenceMaterial: ctx.experiment.reference || ""
      }) });
      const job = body?.job || body;
      if (!job?.id) throw new Error("The evaluation was accepted without a job identifier.");
      const scoreKey = sampleKey(sample);
      state.scorecardHidden[scoreKey] = false;
      state.scorecardSelection[scoreKey] = job.id;
      persistScorecardView();
      mergeJob(job); state.selectedJobId = job.id; await refreshRuns(ctx, true);
    } catch (error) {
      state.error = friendlyError(error);
      state.retryEvaluation = true;
      state.retryEvaluationBaselineId = baseline.id;
    }
    finally {
      state.submitting = false;
      state.submittingEvaluation = false;
      publishEvaluationLock();
      renderVisible(ctx);
    }
  }
  function previousBindScorecard(ctx, evaluation) {
    document.getElementById("evaluation-select")?.addEventListener("change", event => {
      const sample = currentSample(ctx);
      const key = sampleKey(sample);
      if (event.target.value) {
        state.scorecardSelection[key] = event.target.value;
        state.scorecardHidden[key] = false;
        state.selectedJobId = event.target.value;
      } else {
        delete state.scorecardSelection[key];
        state.scorecardHidden[key] = true;
      }
      persistScorecardView();
      scorecard(ctx);
    });
    document.getElementById("retry-run-history")?.addEventListener("click", () => refreshRuns(ctx));
    document.getElementById("score-retry")?.addEventListener("click", () => startEvaluation(ctx, evaluation?.baselineId, evaluation));
    document.getElementById("retry-review-detail")?.addEventListener("click", () => {
      if (evaluation?.id) ensureEvaluationDetail(ctx, evaluation.id, true);
    });
    document.getElementById("retry-state-audit")?.addEventListener("click", () => {
      if (!evaluation) return;
      const latest = window.__cadenceRenderContext || ctx;
      const snapshot = evaluationStateSnapshot(latest, evaluation);
      const signature = JSON.stringify(snapshot);
      state.auditErrors.delete(auditKey(evaluation.id, signature));
      ensureEvaluationState(latest, evaluation, snapshot, signature);
    });
    document.querySelectorAll(".theme-card[data-theme-id]").forEach(card => card.addEventListener("toggle", () => {
      const id = card.dataset.themeId;
      if (card.open) state.openThemes.add(id);
      else state.openThemes.delete(id);
    }));
    document.querySelectorAll("[data-stop-id]").forEach(button => button.addEventListener("click", () => stopJob(button.dataset.stopId, ctx)));
    const getExactPrompt = async () => {
      if (!evaluation?.id) throw new Error("No evaluation is selected.");
      const text = await requestText(`/api/evaluations/${encodeURIComponent(evaluation.id)}/suggested-prompt`);
      state.promptTextCache.set(String(evaluation.id), text);
      return text;
    };
    const showManualPrompt = text => {
      const slot = document.getElementById("manual-copy-slot");
      if (!slot) return;
      slot.replaceChildren();
      const label = document.createElement("label");
      label.className = "manual-copy-label";
      label.textContent = "Exact suggested prompt · manual copy";
      const textarea = document.createElement("textarea");
      textarea.rows = 8;
      textarea.readOnly = true;
      textarea.value = text;
      textarea.setAttribute("aria-label", "Exact suggested prompt for manual copying");
      label.appendChild(textarea);
      slot.appendChild(label);
      textarea.focus();
      textarea.select();
    };
    const copyExactPrompt = async feedbackId => {
      const feedback = document.getElementById(feedbackId);
      let text = "";
      try {
        text = await getExactPrompt();
      } catch (error) {
        text = typeof evaluation?.suggestedPrompt === "string" ? evaluation.suggestedPrompt : "";
        if (text) showManualPrompt(text);
          if (feedback) feedback.textContent = text
          ? "Couldn’t copy. Select the text and copy it manually."
          : "We couldn’t retrieve the revised prompt. Please try again.";
        return;
      }
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
        await navigator.clipboard.writeText(text);
        if (feedback) feedback.textContent = "Prompt copied.";
      } catch {
        showManualPrompt(text);
        if (feedback) feedback.textContent = "Couldn’t copy. Select the text and copy it manually.";
      }
    };
    const useExactPrompt = async () => {
      if (!evaluation || typeof evaluation.suggestedPrompt !== "string") return;
      let suggested = evaluation.suggestedPrompt;
      if (isRubricEvaluation(evaluation)) {
        try { suggested = await getExactPrompt(); }
        catch (error) {
          const feedback = document.getElementById("prompt-action-feedback") || document.getElementById("copy-feedback");
          if (feedback) feedback.textContent = "We couldn’t retrieve the revised prompt. Please try again.";
          return;
        }
      }
      const latest = window.__cadenceRenderContext || ctx;
      if (location.hash !== "#/scorecard" || String(evaluationForScore(latest)?.id) !== String(evaluation.id)) return;
      if (latest.experiment.prompt.length > 0 && latest.experiment.prompt !== suggested &&
          !window.confirm("Replace your current prompt with this version?")) return;
      latest.onUseSuggestedPrompt(suggested);
    };
    const exportExactPrompt = () => {
      if (!evaluation?.id || typeof evaluation.suggestedPrompt !== "string") return;
      const link = document.createElement("a");
      link.href = `/api/evaluations/${encodeURIComponent(evaluation.id)}/suggested-prompt?download=1`;
      link.download = "";
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
    };
    document.getElementById("copy-prompt")?.addEventListener("click", () => copyExactPrompt("prompt-action-feedback"));
    document.getElementById("copy-suggested")?.addEventListener("click", () => copyExactPrompt("copy-feedback"));
    document.getElementById("use-prompt")?.addEventListener("click", useExactPrompt);
    document.getElementById("apply-suggested")?.addEventListener("click", useExactPrompt);
    document.getElementById("export-prompt")?.addEventListener("click", exportExactPrompt);
    document.getElementById("export-suggested")?.addEventListener("click", exportExactPrompt);
  }
  function bindScorecard(ctx, evaluation) {
    document.getElementById("evaluation-select")?.addEventListener("change", event => {
      const sample = currentSample(ctx);
      const key = sampleKey(sample);
      if (event.target.value) {
        state.scorecardSelection[key] = event.target.value;
        state.scorecardHidden[key] = false;
        state.selectedJobId = event.target.value;
      } else {
        delete state.scorecardSelection[key];
        state.scorecardHidden[key] = true;
      }
      persistScorecardView();
      scorecard(ctx);
    });
    document.getElementById("retry-run-history")?.addEventListener("click", () => refreshRuns(ctx));
    document.getElementById("review-results")?.addEventListener("click", () => {
      const baseline = evaluationBaseline(ctx);
      if (baseline) startEvaluation(ctx, baseline.id);
    });
    document.getElementById("retry-review-post")?.addEventListener("click", () => {
      if (state.retryEvaluationBaselineId) startEvaluation(ctx, state.retryEvaluationBaselineId);
    });
    document.getElementById("score-retry")?.addEventListener("click", () => startEvaluation(ctx, evaluation?.baselineId, evaluation));
    document.getElementById("retry-review-detail")?.addEventListener("click", () => {
      if (evaluation?.id) ensureEvaluationDetail(ctx, evaluation.id, true);
    });
    document.getElementById("retry-state-audit")?.addEventListener("click", () => {
      if (!evaluation) return;
      const latest = window.__cadenceRenderContext || ctx;
      const snapshot = evaluationStateSnapshot(latest, evaluation);
      const signature = JSON.stringify(snapshot);
      state.auditErrors.delete(auditKey(evaluation.id, signature));
      ensureEvaluationState(latest, evaluation, snapshot, signature);
    });
    document.querySelectorAll(".theme-card[data-theme-id]").forEach(card => card.addEventListener("toggle", () => {
      if (card.open) state.openThemes.add(card.dataset.themeId);
      else state.openThemes.delete(card.dataset.themeId);
    }));
    document.querySelectorAll("[data-stop-id]").forEach(button => button.addEventListener("click", () => stopJob(button.dataset.stopId, ctx)));
    document.querySelectorAll("[data-proposal-edit]").forEach(button => button.addEventListener("click", () => {
      if (evaluation) buildPromptProposal(ctx, evaluation, [button.dataset.proposalEdit]);
    }));
    document.getElementById("proposal-all")?.addEventListener("click", () => {
      if (evaluation) buildPromptProposal(ctx, evaluation, scorePromptEdits(evaluation).map(edit => edit.id).filter(Boolean));
    });
    document.getElementById("retry-proposal")?.addEventListener("click", () => {
      if (evaluation) buildPromptProposal(ctx, evaluation, state.proposalSelection.get(String(evaluation.id)) || undefined);
    });
    document.getElementById("test-changes")?.addEventListener("click", async () => {
      if (!evaluation || !window.CadenceSimulation?.startSandboxTest) return;
      const proposal = state.proposals.get(String(evaluation.id));
      const before = matchingCandidateForEvaluation(evaluation, ctx);
      if (!proposal || !before || hasActiveWork()) return;
      state.error = "";
      scorecard(ctx);
      await window.CadenceSimulation.startSandboxTest({
        evaluationId: evaluation.id,
        beforeRunId: before.id,
        ...(Array.isArray(proposal.selectedEditIds) ? { selectedEditIds: proposal.selectedEditIds } : {}),
        ...(proposal.promptPreset ? { promptPreset: proposal.promptPreset } : {}),
        currentPrompt: evaluation.context?.systemPrompt || ""
      });
    });
  }
  function mergeJob(job) {
    if (!job || !job.id) return;
    const key = String(job.id);
    const index = state.jobs.findIndex(existing => String(existing.id) === key);
    if (index >= 0) {
      const merged = { ...state.jobs[index], ...job };
      delete merged.networkError;
      state.jobs[index] = merged;
    }
    else state.jobs.unshift(job);
    if (state.details.has(key)) state.details.set(key, { ...state.details.get(key), ...job });
    notifyRunsChanged();
  }
  function notifyRunsChanged() {
    const runs = state.jobs.slice();
    runListeners.forEach(listener => listener(runs));
  }
  function onRunsChange(listener) {
    runListeners.add(listener);
    listener(state.jobs.slice());
    return () => runListeners.delete(listener);
  }
  function matchingCandidate(experiment, sample) {
    if (!sample) return null;
    const ctx = { experiment };
    return state.jobs.filter(job => job.kind === "candidate" && !job.sandbox && !job.sandboxEvaluationId &&
      !job.parentRunId && isFinishedRun(job) && finishedWithOutput(job) &&
      runMatchesCurrent(job, ctx, sample, "candidate")).sort(byCreated)[0] || null;
  }
  async function startSandboxTest(payload) {
    if (!payload?.evaluationId || !payload?.beforeRunId || hasActiveWork()) {
      return { error: "Run with your current prompt in Simulation first." };
    }
    state.error = "";
    state.submitting = true;
    state.submittingSandbox = true;
    publishEvaluationLock();
    notifyRunsChanged();
    try {
      const body = await request("/api/runs", { method: "POST", body: JSON.stringify({
        mode: "candidate",
        sandboxEvaluationId: payload.evaluationId,
        beforeRunId: payload.beforeRunId,
        ...(Array.isArray(payload.selectedEditIds) ? { selectedEditIds: payload.selectedEditIds } : {}),
        ...(payload.promptPreset ? { promptPreset: payload.promptPreset } : {}),
        currentPrompt: payload.currentPrompt
      }) });
      const job = body?.job || body;
      if (!job?.id) throw new Error("Test could not be started.");
      mergeJob(job);
      await refreshRuns(window.__cadenceRenderContext || {}, true);
      return { job };
    } catch (error) {
      state.error = friendlyError(error);
      return { error: state.error };
    } finally {
      state.submitting = false;
      state.submittingSandbox = false;
      publishEvaluationLock();
      notifyRunsChanged();
      renderVisible(window.__cadenceRenderContext || {});
    }
  }
  async function refreshRuns(ctx, quiet = false) {
    try {
      const data = await request("/api/runs");
      if (!Array.isArray(data?.runs)) throw new Error("Run history response did not include a runs list.");
      state.jobs = data.runs.filter(job => job && job.id).map(job =>
        state.details.has(String(job.id)) ? { ...state.details.get(String(job.id)), ...job } : job);
      notifyRunsChanged();
      state.jobs.forEach(job => {
        if (state.details.has(String(job.id))) state.details.set(String(job.id), { ...state.details.get(String(job.id)), ...job });
      });
      state.historyLoading = false;
      state.historyFailed = false;
      if (!quiet) state.error = "";
      notifyRunsChanged();
      publishEvaluationLock();
      const latest = window.__cadenceRenderContext || ctx;
      const selected = currentSample(latest);
      if (selected && !forSample(latest).some(job => String(job.id) === String(state.selectedJobId))) state.selectedJobId = null;
      if (!quiet) renderVisible(latest);
    } catch (error) {
      state.historyLoading = false;
      state.historyFailed = true;
      state.error = "We couldn’t load your runs. Please try again.";
      notifyRunsChanged();
      publishEvaluationLock();
      if (!quiet) renderVisible(window.__cadenceRenderContext || ctx);
    }
  }
  async function refreshModels(ctx) {
    try {
      const data = await request("/api/models");
      if (!Array.isArray(data?.models)) throw new Error("Model response did not include a models list.");
      state.models = data.models.filter(model => model && typeof model.id === "string");
      state.preferred = typeof data.preferred === "string" ? data.preferred : "";
      state.modelError = state.models.length ? "" : "This speech model isn’t available. Choose another model and try again.";
      const storedModel = typeof ctx.experiment.model === "string" ? ctx.experiment.model : "";
      state.selectedModel = state.models.some(model => model.id === storedModel) ? storedModel :
        (state.models.some(model => model.id === state.preferred) ? state.preferred :
          (state.models.some(model => model.id === "ultravox-v0.6") ? "ultravox-v0.6" : state.models[0]?.id || ""));
      ctx.experiment.model = state.selectedModel;
      if (state.selectedModel) ctx.saveExperiment();
    } catch (error) { state.modelError = friendlyError(error, "Something went wrong. Please try again."); }
    state.modelsLoading = false;
    renderVisible(ctx);
  }
  function poll(ctx) {
    if (state.polling) return;
    const active = state.jobs.filter(job => activeStatuses.has(job.status));
    if (!active.length) return;
    state.polling = true;
    Promise.all(active.map(async job => {
      try { mergeJob(await request(`/api/jobs/${encodeURIComponent(job.id)}`)); }
      catch { job.networkError = "Connection problem. We’ll keep trying."; }
    })).finally(() => {
      state.polling = false;
      publishEvaluationLock();
        if (location.hash === "#/simulation" || location.hash === "#/scorecard") renderVisible(ctx);
        else if (location.hash === "#/comparison") notifyRunsChanged();
    });
  }
  function render(ctx) {
    if (location.hash === "#/scorecard") scorecard(ctx);
    else simulation(ctx);
  }
  function renderVisible(ctx) {
    const latestContext = window.__cadenceRenderContext || ctx;
    if (location.hash === "#/simulation" || location.hash === "#/scorecard") render(latestContext);
  }
  function init(ctx, options = {}) {
    window.__cadenceRenderContext = ctx;
    if (!state.selectedModel && ctx.experiment.model) state.selectedModel = ctx.experiment.model;
    if (!runsLoaded) {
      runsLoaded = true;
      refreshRuns(ctx);
    }
    if (options.loadModels !== false && !modelsLoaded) {
      modelsLoaded = true;
      refreshModels(ctx);
    }
    if (!window.__cadenceJobPoller) {
      window.__cadenceJobPoller = window.setInterval(() => {
        if (location.hash !== "#/setup" && location.hash !== "#/simulation" && location.hash !== "#/scorecard" && location.hash !== "#/comparison") return;
        poll(window.__cadenceRenderContext);
      }, 1100);
    }
  }
  window.CadenceSimulation = {
    init, render, refreshRuns, onEvaluationLockChange, isEvaluationLocked,
    resultPerformanceMarkup,
    scorecardMarkup: {
      performance: resultPerformanceMarkup,
      finding: findingMarkup,
      enhancedFinding: enhancedFindingMarkup,
      groupedFindings: groupedFindingsMarkup,
      enhancedEdits: enhancedEditsMarkup,
      enhancedPerformance: enhancedPerformanceMarkup,
      speechPatterns: speechPatternsMarkup,
      emptySections: scorecardEmptySections,
      edits: scoreEditsMarkup,
      promptDiff: proposalDiffMarkup
    },
    getRuns: () => state.jobs.slice(),
    getRunsState: () => ({ loading: state.historyLoading, error: state.historyFailed ? state.error : "" }),
    isSandboxStarting: () => state.submittingSandbox,
    getJob: id => state.jobs.find(job => String(job.id) === String(id)) || null,
    matchingCandidate,
    isBusy: hasActiveWork,
    startSandboxTest,
    stopJob: id => stopJob(id, window.__cadenceRenderContext || {}),
    onRunsChange
  };
})();
