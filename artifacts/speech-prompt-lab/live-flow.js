(() => {
  "use strict";
  const enabled = Boolean(window.CadenceMode?.live);
  const BASELINE_PROMPT = "Transcribe the audio. Output only the transcript.";
  const TERMINAL = new Set(["finished", "complete", "failed", "partial", "cancelled", "stopped"]);
  const progressKey = window.CadenceMode?.storageKey("progress") || "cadence-live-progress-v1";
  let progress = {};
  try { progress = JSON.parse(sessionStorage.getItem(progressKey) || "{}"); } catch {}
  const state = { ctx: null, route: "/simulation", loading: false, loaded: false, status: null, history: [], historyId: "", adopted: null, displayed: null, pinned: false, active: null, posting: false, stopping: false, timer: null, error: "", selectionVersion: 0, activeVersion: 0, progress };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const finished = run => run && ["finished", "complete"].includes(run.status) && !run.error && !run.outputPartial && typeof (run.rawOutput ?? run.text) === "string" && Boolean((run.rawOutput ?? run.text).trim());
  const hasScores = run => !run?.performance?.demo && [run?.performance?.accessibilityScore, run?.performance?.wordAccuracy, run?.performance?.keyItemsCaptured].some(Number.isFinite);
  const terminal = run => Boolean(run && TERMINAL.has(run.status));
  const busy = () => state.posting || state.stopping || Boolean(state.active && !terminal(state.active));
  const sample = () => (state.ctx?.samples || []).find(item => String(item.id) === String(state.ctx?.experiment.selectedId));
  const selectedModel = () => state.ctx?.experiment.model || state.status?.preferred || state.status?.models?.[0]?.id || "";
  const pairParts = entry => ({ ...entry, before: entry.before || entry.baseline, after: entry.after || entry.candidate, review: entry.review || entry.evaluation, id: entry.pairId || entry.id });
  const completePair = entry => {
    const pair = pairParts(entry);
    if (!finished(pair.before) || !finished(pair.after) || entry.comparable === false) return false;
    if (entry.comparable === true) return true;
    const a = pair.before, b = pair.after;
    return a.sampleId != null && a.sampleId === b.sampleId && a.requestedModel === b.requestedModel &&
      JSON.stringify(a.excerpt || {}) === JSON.stringify(b.excerpt || {}) &&
      Boolean(a.audioHashes?.sourceSha256) && a.audioHashes.sourceSha256 === b.audioHashes?.sourceSha256 &&
      Boolean(a.audioHashes?.excerptPcmSha256) && a.audioHashes.excerptPcmSha256 === b.audioHashes?.excerptPcmSha256;
  };
  function storeProgress() {
    try { sessionStorage.setItem(progressKey, JSON.stringify({ selectedPairId: state.displayed?.id || null, activeRunId: state.active?.id || null, baselineId: state.adopted?.before?.id || null })); } catch {}
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: "include", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
    let data;
    try { data = await response.json(); } catch { throw new Error("We couldn’t read these results. Please try again."); }
    if (!response.ok) throw new Error(data?.error?.message || "We couldn’t complete that action. Please try again.");
    return data;
  }
  const post = (url, body) => request(url, { method: "POST", body: JSON.stringify(body) });
  function filename(run, fallback) { return run?.recording?.fileName || run?.recording?.filename || run?.source?.name || fallback?.audio_filename || "Selected recording"; }
  function rangeText(run) {
    const excerpt = run?.excerpt || run?.runSnapshot?.excerpt || {};
    const start = excerpt.startOffset ?? run?.startOffset ?? run?.runSnapshot?.startOffset;
    const length = excerpt.length ?? excerpt.requestedLength ?? run?.excerptLength ?? run?.runSnapshot?.excerptLength;
    const seconds = value => Math.round(value * 10) / 10;
    return Number.isFinite(Number(start)) && Number.isFinite(Number(length)) ? `${seconds(Number(start))}–${seconds(Number(start) + Number(length))} sec` : "Saved excerpt";
  }
  function previousMarkup() {
    const history = state.history.filter(completePair);
    return `<section class="panel live-history-panel"><div class="live-history-heading"><div><p class="section-label">Previous runs</p><h2 class="section-title">Open a completed comparison</h2></div>${state.loading ? '<span role="status">Loading runs…</span>' : ""}</div><div class="live-history-actions"><div class="field"><label for="live-previous-run">Completed runs</label><select id="live-previous-run"${history.length ? "" : " disabled"}><option value="">${history.length ? "Choose a previous run…" : state.loading ? "Loading previous runs…" : "No completed runs yet"}</option>${history.map(entry => { const pair = pairParts(entry); return `<option value="${esc(entry.id || pair.id)}"${String(state.historyId) === String(entry.id || pair.id) ? " selected" : ""}>${esc(filename(pair.before))} · ${esc(rangeText(pair.before))} · ${esc(pair.before.requestedModel || pair.before.resolvedModel || "Saved model")}</option>`; }).join("")}</select></div><button type="button" class="button secondary" id="live-use-previous"${state.historyId && !state.posting ? "" : " disabled"}>${busy() ? "Stop & use" : "Use previous run"}</button></div></section>`;
  }
  function heading(title, step, intro) { return `<div class="page-heading"><div><div class="eyebrow">Evaluation workspace / ${step}</div><h1>${title}</h1><p class="page-intro">${intro}</p></div><div class="step-count">STEP ${step} / 04</div></div>`; }
  function activeMarkup() {
    if (!busy()) return "";
    const progress = Number(state.active?.progress?.percent);
    return `<section class="score-section live-active-run" role="status" aria-live="polite"><div class="score-section-heading"><div><p class="section-label">Live evaluation</p><h2>${state.stopping ? "Stopping…" : state.posting ? "Starting…" : "Processing recording…"}</h2></div><button type="button" class="button secondary small" id="live-stop"${state.stopping || !state.active?.id ? " disabled" : ""}>Stop</button></div>${Number.isFinite(progress) ? `<div class="job-progress"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>` : ""}<p>${esc(state.active?.recording?.fileName || sample()?.audio_filename || "")}</p></section>`;
  }
  function prepared() {
    return (state.status?.prepared || []).find(entry => String(entry.sampleId) === String(sample()?.id) && (!entry.model || entry.model === selectedModel()));
  }
  function adoptionMatches() { return state.adopted?.before && String(state.adopted.before.sampleId) === String(sample()?.id) && (!state.adopted.before.requestedModel || state.adopted.before.requestedModel === selectedModel()); }
  function simulationMarkup() {
    const current = sample();
    const ready = prepared();
    const models = state.status?.models || [];
    const model = selectedModel();
    const baseline = adoptionMatches() ? state.adopted.before : null;
    return `${heading("Simulation", "02", "Evaluate the first 15 seconds of the selected recording.")}<section class="panel sim-config-panel"><div class="panel-header"><div><p class="section-label">Run settings</p><h2 class="section-title">Choose a speech model</h2></div>${ready?.ready ? '<span class="sim-state finished">Baseline prepared</span>' : ""}</div><div class="sim-model-actions"><div class="field sim-model-field"><label for="live-model">Model</label><select id="live-model"${busy() || !models.length ? " disabled" : ""}>${models.length ? models.map(item => `<option value="${esc(item.id)}"${item.id === model ? " selected" : ""}>${esc(item.label || item.name || item.id)}</option>`).join("") : '<option value="">Load available speech models</option>'}</select></div><div class="sim-run-buttons"><button type="button" class="button secondary" id="live-load-models"${busy() || !state.status?.authorized || !state.status?.configured ? " disabled" : ""}>Load models</button><button type="button" class="button" id="live-run-baseline"${!current || !model || !state.status?.canRun || busy() ? " disabled" : ""}>Run baseline</button>${ready?.ready ? `<button type="button" class="button secondary" id="live-load-baseline"${!current || busy() ? " disabled" : ""}>Load prepared baseline</button>` : ""}</div></div></section><div class="live-source-meta"><strong>${esc(current?.audio_filename || "Choose a recording in Set up an eval")}</strong><span>0–15 sec</span></div><section class="score-section"><div class="field"><label for="live-baseline-prompt">System prompt used</label><textarea id="live-baseline-prompt" readonly rows="3">${esc(BASELINE_PROMPT)}</textarea></div></section>${baseline ? `<section class="score-section"><div class="score-section-heading"><div><p class="section-label">Baseline response</p><h2>${esc(filename(baseline, current))}</h2></div><span class="sim-state finished">Complete</span></div><pre class="output-block">${esc(baseline.rawOutput)}</pre><a class="button" href="#/scorecard">Continue to Scorecard</a></section>` : ""}<details class="score-disclosure live-private-prepare"><summary>Prepare results in advance</summary><p>Save a baseline, review, and improved result for this recording and model.</p>${ready?.reason ? `<p class="field-help">${esc({ REFERENCE_UNVERIFIED: "Check this recording’s reference before preparing scored results.", NOT_PREPARED: "This recording and model have no prepared results." }[ready.reason] || ready.reason)}</p>` : ""}<button type="button" class="button secondary" id="live-prepare"${!current || !model || !state.status?.authorized || !state.status?.configured || busy() ? " disabled" : ""}>Prepare results</button></details>`;
  }
  function scorecardMarkup() {
    const adopted = state.adopted;
    if (!adoptionMatches()) return `${heading("Review of your agent", "03", "Review the recording before improving its prompt.")}<section class="compare-empty"><p>Run a baseline for the selected recording and model in Simulation.</p><a class="button" href="#/simulation">Go to Simulation</a></section>`;
    const ui = window.CadenceSimulation.scorecardMarkup;
    const before = adopted.before;
    const review = adopted.review || {};
    const findings = (review.verifiedFindings || review.parsedResult?.findings || []).filter(finding => finding.verified !== false && typeof finding.quote === "string" && before.rawOutput.includes(finding.quote));
    const edits = review.promptUpdates || review.parsedResult?.promptEdits || [];
    const proposed = adopted.proposedPrompt || review.suggestedPrompt || review.proposedPrompt || state.status?.promptPreset?.prompt || "";
    const diff = adopted.promptDiff || review.diff || [{ type: "removed", text: before.promptUsed || BASELINE_PROMPT }, { type: "added", text: proposed }];
    const reviewMarkup = review.id ? `<section class="score-section review-findings"><div class="score-section-heading"><div><p class="section-label">Transcript findings</p><h2>What to improve</h2></div></div>${findings.length ? `<div class="finding-list">${findings.map(ui.finding).join("")}</div>` : '<p class="quiet-empty">No findings were saved for this review.</p>'}</section>` : `<section class="score-section"><div class="score-section-heading"><div><p class="section-label">Baseline response</p><h2>${esc(filename(before))}</h2></div></div><pre class="output-block">${esc(before.rawOutput)}</pre></section>`;
    return `${heading("Review of your agent", "03", "Review the transcript and test the improved system prompt.")}<div class="scorecard-content live-scorecard">${hasScores(before) ? ui.performance(before, (state.ctx.samples || []).find(item => String(item.id) === String(before.sampleId))) : ""}${reviewMarkup}<section class="score-section"><div class="score-section-heading"><div><p class="section-label">Recommended system prompt edits</p><h2>Make the next test clearer</h2></div></div>${edits.length ? ui.edits({ ...review, verifiedFindings: findings }, edits, { showApplyButtons: false }) : ""}<div class="score-proposal-preview"><div class="score-section-heading"><div><p class="section-label">Prompt changes</p><h2>Current and proposed</h2></div></div>${ui.promptDiff(diff)}<div class="proposal-test-actions"><button type="button" class="button" id="live-test-changes"${busy() || !state.status?.canRun || !proposed ? " disabled" : ""}>Test these changes</button></div></div></section></div>`;
  }
  function normalizedPair(entry) {
    const pair = pairParts(entry);
    const run = value => ({ text: value.rawOutput, prompt: value.promptUsed || value.context?.systemPrompt || "", performance: value.performance?.demo ? undefined : value.performance, source: { name: filename(value) } });
    return { old: run(pair.before), new: run(pair.after) };
  }
  function decorateComparison() {
    const content = state.ctx.content;
    const meta = content.querySelector?.(".compare-test-meta .sim-state");
    if (meta) meta.textContent = "Live results";
    const pair = normalizedPair(state.displayed);
    const actual = pairParts(state.displayed);
    if (!hasScores(actual.before)) content.querySelector?.(".compare-panel.old .compare-result-score")?.remove();
    if (!hasScores(actual.after)) content.querySelector?.(".compare-panel.new .compare-result-score")?.remove();
    const beforeScore = pair.old.performance?.accessibilityScore;
    const afterScore = pair.new.performance?.accessibilityScore;
    const result = content.querySelector?.(".compare-live-results");
    if (result) {
      result.classList.add("live-result-summary");
      result.dataset.scoreChange = Number.isFinite(beforeScore) && Number.isFinite(afterScore)
        ? afterScore < beforeScore ? "negative" : afterScore > beforeScore ? "positive" : "neutral"
        : "unscored";
    }
    const before = pairParts(state.displayed).before;
    content.insertAdjacentHTML("afterbegin", `<div class="live-source-meta"><span>${esc(rangeText(before))}</span><span>${esc(before.requestedModel || "Saved model")}</span></div>`);
  }
  function draw() {
    const ctx = state.ctx;
    if (!ctx || !["#/simulation", "#/scorecard", "#/comparison"].includes(location.hash)) return;
    state.route = location.hash.slice(1);
    const header = previousMarkup() + (state.error ? `<p class="error-box" role="alert">${esc(state.error)} <button type="button" class="button secondary small" id="live-retry">Try again</button></p>` : "") + activeMarkup();
    if (state.route === "/comparison") {
      if (state.displayed && completePair(state.displayed)) {
        const pair = normalizedPair(state.displayed);
        window.CadenceComparison.renderSaved(ctx, pair, pair.old.source.name);
        // The shared saved renderer draws actual supplied metrics; it never starts calls.
        decorateComparison();
        ctx.content.insertAdjacentHTML("afterbegin", header);
      } else ctx.content.innerHTML = `${header}${heading("Results Summary", "04", "Review completed results from the same recording.")}<section class="compare-empty"><p>${busy() ? "Your comparison will appear when the recording is complete." : "Complete a test in Scorecard, or choose a previous run."}</p><a class="button" href="#/scorecard">Go to Scorecard</a></section>`;
    } else ctx.content.innerHTML = header + (state.route === "/scorecard" ? scorecardMarkup() : simulationMarkup());
    bind();
  }
  function bind() {
    document.getElementById("live-previous-run")?.addEventListener("change", event => { state.historyId = event.currentTarget.value; draw(); });
    document.getElementById("live-use-previous")?.addEventListener("click", usePrevious);
    document.getElementById("live-model")?.addEventListener("change", event => { state.ctx.experiment.model = event.currentTarget.value; state.ctx.saveExperiment?.(); state.adopted = null; draw(); });
    document.getElementById("live-load-baseline")?.addEventListener("click", loadBaseline);
    document.getElementById("live-run-baseline")?.addEventListener("click", runBaseline);
    document.getElementById("live-load-models")?.addEventListener("click", loadModels);
    document.getElementById("live-prepare")?.addEventListener("click", prepareBaseline);
    document.getElementById("live-test-changes")?.addEventListener("click", testChanges);
    document.getElementById("live-stop")?.addEventListener("click", () => stop());
    document.getElementById("live-retry")?.addEventListener("click", refresh);
    const highlight = document.getElementById("highlight-changes");
    if (highlight && state.route === "/comparison") highlight.addEventListener("change", () => { // Reattach persistent live controls after the shared transcript redraw.
      decorateComparison();
      state.ctx.content.insertAdjacentHTML("afterbegin", previousMarkup() + activeMarkup());
      bind();
    });
  }
  async function refresh(options = {}) {
    if (!enabled || !state.ctx) return;
    state.loading = true;
    if (!options.keepError) state.error = "";
    draw();
    const results = await Promise.allSettled([request("/api/live/status"), request("/api/live/previous-runs")]);
    if (results[0].status === "fulfilled") {
      state.status = results[0].value;
      if (state.status.running) { state.active = state.status.running; if (state.progress.activeRunId === state.active.id) state.activeVersion = state.selectionVersion; schedulePoll(); }
      const models = state.status.models || [];
      if (models.length && !models.some(model => model.id === state.ctx.experiment.model)) {
        state.ctx.experiment.model = models.some(model => model.id === state.status.preferred) ? state.status.preferred : models[0].id;
        state.ctx.saveExperiment?.();
      }
    } else state.error = results[0].reason.message;
    if (results[1].status === "fulfilled") {
      const previous = [...(results[1].value.runs || []), ...(results[1].value.historicalRuns || [])];
      state.history = [...new Map(previous.map(entry => [entry.id, entry])).values()];
      if (!state.displayed && state.progress.selectedPairId) { const prior = state.history.find(entry => String(entry.id) === String(state.progress.selectedPairId)); if (prior && completePair(prior)) { state.displayed = prior; state.pinned = true; state.historyId = String(prior.id); } }
    } else state.error = results[1].reason.message;
    if (!state.adopted && state.progress.baselineId) {
      const pair = state.history.find(entry => String(pairParts(entry).before?.id) === String(state.progress.baselineId));
      if (pair) state.adopted = { ...pairParts(pair), proposedPrompt: state.status?.promptPreset?.prompt || "" };
      else {
        try {
          const data = await request(`/api/jobs/${encodeURIComponent(state.progress.baselineId)}`);
          const before = data.job || data;
          if (before.kind === "baseline" && finished(before)) state.adopted = { before, proposedPrompt: state.status?.promptPreset?.prompt || "" };
        } catch { /* A discarded server session can start a fresh baseline. */ }
      }
    }
    state.loading = false;
    state.loaded = true;
    draw();
  }
  function schedulePoll() {
    if (state.timer || !state.active?.id || terminal(state.active)) return;
    state.timer = window.setTimeout(async () => {
      state.timer = null;
      const id = state.active?.id;
      if (!id) return;
      try {
        const job = await request(`/api/jobs/${encodeURIComponent(id)}`);
        state.active = job.job || job;
        if (terminal(state.active)) {
          state.stopping = false;
          if (state.active.kind === "preparation") {
            if (!["finished", "complete", "cancelled", "stopped"].includes(state.active.status)) state.error = state.active.error?.message || "Preparation did not complete. Please try again.";
          } else if (state.active.kind === "baseline" && finished(state.active)) {
            if (!state.pinned && state.activeVersion === state.selectionVersion) {
              state.adopted = { before: state.active, proposedPrompt: state.status?.promptPreset?.prompt || "", promptDiff: state.status?.promptPreset?.diff };
              location.hash = "#/scorecard";
            }
          } else if (finished(state.active) && (state.active.workflow === "recording-comparison" || state.active.kind === "candidate") && !state.active.preparationId) {
            const beforeId = state.active.sandbox?.beforeRunId || state.active.beforeRunId || state.adopted?.before?.id;
            const result = await request(`/api/comparisons?beforeId=${encodeURIComponent(beforeId)}&afterId=${encodeURIComponent(id)}`);
            const comparison = result.comparison || result;
            if (completePair(comparison)) {
              const entry = { ...comparison, id, review: state.adopted?.review };
              if (!state.pinned && state.activeVersion === state.selectionVersion) { state.displayed = entry; location.hash = "#/comparison"; }
            }
          } else if (!finished(state.active) && !["cancelled", "stopped"].includes(state.active.status)) state.error = state.active.error?.message || "This run did not complete. Your previous results are still available.";
          storeProgress();
          await refresh({ keepError: true });
        }
      } catch (error) { state.error = error.message; }
      draw();
      schedulePoll();
    }, 1100);
  }
  async function loadBaseline() {
    if (busy()) return;
    state.error = "";
    const current = sample();
    const match = state.history.find(entry => entry.prepared && String(pairParts(entry).before?.sampleId || entry.sampleId) === String(current?.id) && (!pairParts(entry).before?.requestedModel || pairParts(entry).before.requestedModel === selectedModel()));
    const ready = prepared();
    const id = match?.id || ready?.pairId || ready?.id;
    if (!id) { state.error = "Prepare a baseline for this recording and model first."; draw(); return; }
    try { state.adopted = pairParts(await post("/api/live/adopt", { id })); state.pinned = false; state.displayed = null; state.selectionVersion++; storeProgress(); }
    catch (error) { state.error = error.message; }
    draw();
  }
  async function loadModels() {
    if (busy()) return;
    state.error = "";
    try {
      const data = await request("/api/live/models");
      state.status = { ...state.status, models: data.models || [], preferred: data.preferred || "" };
      if (!(data.models || []).some(model => model.id === state.ctx.experiment.model)) {
        state.ctx.experiment.model = data.preferred || data.models?.[0]?.id || "";
        state.ctx.saveExperiment?.();
      }
    } catch (error) { state.error = error.message; }
    draw();
  }
  async function runBaseline() {
    if (busy() || !sample() || !selectedModel() || !state.status?.canRun) return;
    state.posting = true; state.error = ""; state.pinned = false; state.displayed = null; state.adopted = null;
    state.selectionVersion++; state.activeVersion = state.selectionVersion; draw();
    try {
      const data = await post("/api/live/baseline", { sampleId: sample().id, model: selectedModel() });
      state.active = data.job || data; storeProgress(); schedulePoll();
    } catch (error) { state.error = error.message; }
    finally { state.posting = false; draw(); }
  }
  async function prepareBaseline() {
    if (busy() || !sample() || !selectedModel()) return;
    state.posting = true; state.error = ""; draw();
    try { const data = await post("/api/live/prepare", { sampleId: sample().id, model: selectedModel() }); state.active = data.job || data; state.activeVersion = state.selectionVersion; storeProgress(); schedulePoll(); }
    catch (error) { state.error = error.message; }
    finally { state.posting = false; draw(); }
  }
  async function testChanges() {
    if (busy() || !adoptionMatches() || !state.status?.canRun) return;
    state.posting = true; state.error = ""; state.pinned = false; state.displayed = null; state.selectionVersion++; state.activeVersion = state.selectionVersion; draw();
    try {
      const before = state.adopted.before;
      const data = await post("/api/runs", { workflow: "recording-comparison", mode: "candidate", beforeRunId: before.id, ...(state.adopted.review?.id ? { sandboxEvaluationId: state.adopted.review.id } : {}), promptPreset: "readable-transcript-v1", currentPrompt: before.promptUsed || BASELINE_PROMPT });
      state.active = data.job || data; storeProgress(); schedulePoll();
    } catch (error) { state.error = error.message; }
    finally { state.posting = false; draw(); }
  }
  async function stop() {
    if (!state.active?.id || terminal(state.active) || state.stopping) return;
    state.stopping = true; state.error = ""; draw();
    try { await post(`/api/jobs/${encodeURIComponent(state.active.id)}/stop`, {}); }
    catch (error) { state.error = error.message; state.stopping = false; }
    schedulePoll(); draw();
  }
  async function usePrevious() {
    if (state.posting) return;
    const entry = state.history.find(item => String(item.id) === String(state.historyId));
    if (!entry || !completePair(entry)) return;
    if (busy()) {
      if (!state.active?.id) return;
      state.stopping = true; draw();
      try { await post(`/api/jobs/${encodeURIComponent(state.active.id)}/stop`, {}); }
      catch (error) { state.error = error.message; state.stopping = false; draw(); return; }
    }
    state.selectionVersion++; state.pinned = true; state.displayed = entry; storeProgress(); location.hash = "#/comparison"; draw(); schedulePoll();
  }
  function render(ctx, route) {
    state.ctx = ctx; state.route = route;
    draw();
    if (!state.loaded && !state.loading) refresh();
  }
  window.CadenceLiveFlow = { enabled, render, refresh, isBusy: busy };
})();
