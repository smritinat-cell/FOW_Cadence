(() => {
  "use strict";

  const state = {
    demo: null,
    demoLoading: false,
    demoError: "",
    livePairs: new Map(),
    liveLoading: new Set(),
    liveErrors: new Map(),
    requestedSignatures: new Map(),
    highlights: true,
    confirmParentId: null,
    copyFeedback: "",
    submittingStop: false
  };
  let latestContext = null;
  let unsubscribeRuns = null;

  function debugMode() {
    return new URLSearchParams(location.search).get("debug") === "1";
  }
  function fallbackEscape(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }
  function esc(ctx, value) {
    return typeof ctx.escapeHtml === "function" ? ctx.escapeHtml(value) : fallbackEscape(value);
  }
  function safeDebugText(value) {
    return String(value ?? "")
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[hidden link]")
      .replace(/(["']?(?:api[_-]?key|secret|token)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[hidden]")
      .replace(/(["']?authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"'\s,;}]+/gi, "$1[hidden]")
      .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [hidden]");
  }
  function displayDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Date unavailable";
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    return date.toDateString() === new Date().toDateString()
      ? `Today, ${time}`
      : new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date);
  }
  function runs() {
    return window.CadenceSimulation?.getRuns?.() || [];
  }
  function currentSample(ctx) {
    return (ctx.samples || []).find(sample => String(sample.id) === String(ctx.experiment.selectedId)) || null;
  }
  function newestFirst(a, b) {
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  }
  function findSandbox(ctx, allRuns = runs()) {
    const sample = currentSample(ctx);
    const candidates = allRuns.filter(job => job?.kind === "candidate" && job.sandbox).sort(newestFirst);
    const sameSample = sample ? candidates.filter(job => String(job.sampleId) === String(sample.id)) : [];
    const parent = (sameSample.length ? sameSample : candidates)[0] || null;
    const beforeId = parent?.sandbox?.beforeRunId || parent?.beforeRunId;
    const before = beforeId ? allRuns.find(job => String(job.id) === String(beforeId)) || null : null;
    const child = parent ? allRuns.find(job => job.kind === "evaluation" && job.reviewStage === "after" &&
      String(job.parentRunId) === String(parent.id)) || null : null;
    return { parent, before, child };
  }
  function pairKey(before, after) {
    return before && after ? `${before.id}::${after.id}` : "";
  }
  function friendlyLiveError() {
    return "We couldn’t load the comparison. Please try again.";
  }
  function ensureLiveComparison(before, after, child, retry = false) {
    const key = pairKey(before, after);
    if (!key || state.liveLoading.has(key)) return;
    const signature = `${key}|${after.status}|${after.sandbox?.stage}|${after.sandbox?.audioFinished}|${after.sandbox?.afterEvaluationId}|${child?.status || ""}`;
    if (!retry && state.requestedSignatures.get(key) === signature) return;
    state.requestedSignatures.set(key, signature);
    state.liveErrors.delete(key);
    state.liveLoading.add(key);
    const query = new URLSearchParams({ beforeId: String(before.id), afterId: String(after.id) });
    fetch(`/api/comparisons?${query.toString()}`, { credentials: "include" })
      .then(async response => {
        let body = null;
        try { body = await response.json(); } catch { body = null; }
        if (!response.ok || !body || typeof body !== "object") throw new Error("Comparison unavailable.");
        state.livePairs.set(key, body.comparison || body);
      })
      .catch(() => state.liveErrors.set(key, friendlyLiveError()))
      .finally(() => {
        state.liveLoading.delete(key);
        renderLatest();
      });
  }
  function notifyFromRuns() {
    renderLatest();
  }
  function renderLatest() {
    if (!latestContext || location.hash !== "#/comparison") return;
    if (debugMode()) renderDemo(latestContext);
    else renderLive(latestContext);
  }

  function demoValidate(data) {
    if (!data || data.mode !== "demo" || typeof data.before !== "string" || typeof data.after !== "string" ||
        typeof data.baselinePrompt !== "string" || !Array.isArray(data.segments) ||
        !data.counts || !Number.isFinite(Number(data.counts.removedWords)) ||
        !Number.isFinite(Number(data.counts.addedWords))) throw new Error("Comparison example was incomplete.");
    const segments = data.segments.filter(segment => segment &&
      ["context", "removed", "added"].includes(segment.type) && typeof segment.text === "string");
    if (segments.length !== data.segments.length) throw new Error("Comparison example was incomplete.");
    if (segments.filter(segment => segment.type === "context" || segment.type === "removed").map(segment => segment.text).join("") !== data.before ||
        segments.filter(segment => segment.type === "context" || segment.type === "added").map(segment => segment.text).join("") !== data.after) {
      throw new Error("Comparison example did not match its text.");
    }
    return { ...data, segments };
  }
  async function fetchDemo() {
    state.demoLoading = true;
    state.demoError = "";
    renderDemo(latestContext);
    try {
      const response = await fetch("/api/demo-comparison", { credentials: "include" });
      const body = await response.json();
      if (!response.ok) throw new Error("Could not load.");
      state.demo = demoValidate(body);
    } catch (error) {
      state.demo = null;
      state.demoError = friendlyLiveError();
    } finally {
      state.demoLoading = false;
      renderDemo(latestContext);
    }
  }
  function demoTranscript(side) {
    const before = side === "before";
    const visible = before ? ["context", "removed"] : ["context", "added"];
    return state.demo.segments.filter(part => visible.includes(part.type)).map(part => {
      const kind = part.type === "context" ? "" : part.type;
      return `<span${kind ? ` class="${kind}"` : ""}>${fallbackEscape(part.text)}</span>`;
    }).join("");
  }
  function bindDemo() {
    document.getElementById("highlight-changes")?.addEventListener("change", event => {
      state.highlights = event.currentTarget.checked;
      renderDemo(latestContext);
    });
    document.getElementById("retry-demo-comparison")?.addEventListener("click", fetchDemo);
  }
  function renderDemo(ctx) {
    if (!ctx || location.hash !== "#/comparison") return;
    if (state.demoLoading) {
      ctx.content.innerHTML = `<div class="page-heading"><div><div class="eyebrow">04 / Before &amp; after</div><h1>Before &amp; after</h1></div></div><section class="compare-empty" aria-busy="true"><p>Loading comparison…</p></section>`;
      return;
    }
    if (!state.demo) {
      ctx.content.innerHTML = `<div class="page-heading"><div><div class="eyebrow">04 / Before &amp; after</div><h1>Before &amp; after</h1></div></div><section class="compare-empty"><p class="error-box" role="alert">We couldn’t load the comparison. Please try again.</p><button type="button" class="button" id="retry-demo-comparison">Try again</button><details><summary>Developer details</summary><p>${fallbackEscape(safeDebugText(state.demoError))}</p></details></section>`;
      document.getElementById("retry-demo-comparison")?.addEventListener("click", fetchDemo);
      return;
    }
    const data = state.demo;
    const panel = (side, title, prompt) => `<section class="compare-panel ${side}">
      <div class="compare-panel-head"><h2>${title}</h2></div>
      <div class="compare-prompt"><p class="compare-prompt-label">${side === "old" ? "Baseline prompt" : "Current system prompt"}</p><p class="compare-prompt-text">${fallbackEscape(prompt)}</p></div>
      <div class="compare-transcript${state.highlights ? "" : " no-highlights"}">${demoTranscript(side === "old" ? "before" : "after")}</div>
    </section>`;
    ctx.content.innerHTML = `<div class="page-heading"><div><div class="eyebrow">04 / Before &amp; after</div><h1>Before &amp; after</h1></div></div>
      <section class="compare-banner"><div><strong>Developer example only</strong><p>Fixed comparison content is visible only in developer mode.</p></div></section>
      <div class="compare-header-row"><div class="compare-counts"><div class="compare-count removed"><strong>${fallbackEscape(data.counts.removedWords)}</strong><span>Removed words</span></div><div class="compare-count added"><strong>${fallbackEscape(data.counts.addedWords)}</strong><span>Added words</span></div></div><label class="compare-highlight"><input type="checkbox" id="highlight-changes"${state.highlights ? " checked" : ""}> Highlight changes</label></div>
      <div class="compare-columns">${panel("old", "Old transcript", data.baselinePrompt)}${panel("new", "New transcript", ctx.experiment.prompt || "")}</div>
      <details class="score-disclosure"><summary>Developer details</summary><pre class="output-block">${fallbackEscape(safeDebugText(JSON.stringify(data, null, 2)))}</pre></details>`;
    bindDemo();
  }

  function friendlyStatus(job) {
    if (job?.outputPartial || job?.status === "partial") return "Partial result";
    const labels = { queued: "Queued", preparing: "Queued", connecting: "Running", streaming: "Running", sending: "Running", waiting: "Running", running: "Running", finished: "Complete", complete: "Complete", partial: "Partial result", failed: "Failed", cancelled: "Stopped", stopped: "Stopped" };
    return labels[job?.status] || "Queued";
  }
  function transcriptText(record, side) {
    const explicit = side === "before" ? record?.transcriptDiff?.before : record?.transcriptDiff?.after;
    if (typeof explicit === "string") return explicit;
    const run = side === "before" ? record?.before : record?.after;
    return typeof run?.rawOutput === "string" ? run.rawOutput : "";
  }
  function transcriptSegments(ctx, comparison, side) {
    const text = transcriptText(comparison, side);
    const segments = comparison?.transcriptDiff?.segments;
    if (!Array.isArray(segments)) return fallbackEscape(text);
    const visible = side === "before" ? new Set(["context", "removed"]) : new Set(["context", "added"]);
    return segments.filter(part => part && visible.has(part.type) && typeof part.text === "string").map(part => {
      const kind = part.type === "context" ? "" : part.type;
      return `<span${kind ? ` class="${kind}"` : ""}>${esc(ctx, part.text)}</span>`;
    }).join("");
  }
  function metricText(value, suffix = "") {
    return typeof value === "number" && Number.isFinite(value) ? `${value}${suffix}` : "Not enough information to score this yet";
  }
  function metricDeltaText(value, suffix = "") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Not enough information to score this yet";
    return `${value > 0 ? "+" : ""}${value}${suffix}`;
  }
  function performanceColumns(ctx, comparison) {
    const before = comparison.before?.performance || {};
    const after = comparison.after?.performance || {};
    const deltas = comparison.deltas || {};
    const column = (title, performance) => `<article class="comparison-performance-side">
      <h3>${esc(ctx, title)}</h3>
      <div><span>Accessibility score</span><strong>${esc(metricText(performance.accessibilityScore))}${typeof performance.accessibilityScore === "number" ? "<small>/ 100</small>" : ""}</strong></div>
      <div><span>Key items captured</span><strong>${Number.isInteger(performance.keyItemsCaptured) && Number.isInteger(performance.keyItemsTotal) ? `${esc(ctx, performance.keyItemsCaptured)} of ${esc(ctx, performance.keyItemsTotal)}` : "Not enough information to score this yet"}</strong></div>
      <div><span>Word accuracy</span><strong>${esc(ctx, metricText(performance.wordAccuracy, "%"))}</strong></div>
      <p>${esc(ctx, typeof performance.outcome === "string" && performance.outcome.trim() ? performance.outcome : "Not enough information to score this yet")}</p>
    </article>`;
    return `<section class="compare-score-section"><div class="score-section-heading"><div><p class="section-label">Results from test</p><h2>What changed</h2></div>${Number.isInteger(comparison.issuesFixed) ? `<span class="compare-issues-fixed">${esc(ctx, comparison.issuesFixed)} issues fixed</span>` : ""}</div>
      <div class="comparison-performance-columns">${column("Before", before)}${column("After", after)}</div>
      <div class="comparison-deltas">
        <div><span>Accessibility score change</span><strong>${esc(ctx, metricDeltaText(deltas.accessibilityScore))}</strong></div>
        <div><span>Key items captured change</span><strong>${esc(ctx, metricDeltaText(deltas.keyItemsCaptured))}</strong></div>
        <div><span>Word accuracy change</span><strong>${esc(ctx, metricDeltaText(deltas.wordAccuracy, "%"))}</strong></div>
      </div>
      ${after.failureQuote ? `<blockquote class="performance-quote">${esc(ctx, after.failureQuote)}</blockquote>` : ""}
    </section>`;
  }
  function promptDiffColumns(ctx, comparison) {
    const parts = comparison?.promptDiff;
    if (!Array.isArray(parts)) return "";
    const column = side => parts.filter(part => part.type === "context" || part.type === side)
      .map(part => `<span class="${part.type === "context" ? "" : `prompt-diff-${part.type}`}">${esc(ctx, part.text ?? "")}</span>`).join("");
    return `<section class="score-section compare-prompt-diff"><div class="score-section-heading"><div><p class="section-label">Prompt changes</p><h2>What changed in the wording</h2></div></div>
      <div class="proposal-diff-columns"><section><h3>Before</h3><pre>${column("removed")}</pre></section><section><h3>After</h3><pre>${column("added")}</pre></section></div></section>`;
  }
  function comparisonThemes(ctx, comparison) {
    const themes = Array.isArray(comparison.themes) ? comparison.themes : [];
    if (!themes.length) return "";
    return `<section class="score-section"><div class="score-section-heading"><div><p class="section-label">Review by area</p><h2>What changed</h2></div></div><div class="compare-theme-list">${themes.map(theme => `<article class="compare-theme">
      <div><strong>${esc(ctx, theme.label || "Review area")}</strong><span class="${theme.worsened ? "worsened" : ""}">${esc(ctx, theme.worsened ? "Worsened" : theme.status || "Not enough information yet")}</span></div>
      <p>Before: ${Number.isInteger(theme.beforeCount) ? esc(ctx, theme.beforeCount) : "Not enough information"} · After: ${Number.isInteger(theme.afterCount) ? esc(ctx, theme.afterCount) : "Not enough information"}</p>
    </article>`).join("")}</div></section>`;
  }
  function transcriptPanel(ctx, comparison, side) {
    const before = side === "before";
    const run = before ? comparison.before : comparison.after;
    const transcript = transcriptText(comparison, side);
    const prompt = typeof run?.promptUsed === "string" ? run.promptUsed : "";
    const title = before ? "Before" : "After";
    return `<section class="compare-panel ${before ? "old" : "new"}">
      <div class="compare-panel-head"><h2>${title}</h2><span class="sim-state ${esc(ctx, String(run?.status || "").toLowerCase())}">${esc(ctx, friendlyStatus(run))}</span></div>
      <div class="compare-prompt"><p class="compare-prompt-label">System prompt used</p><p class="compare-prompt-text">${esc(ctx, prompt)}</p></div>
      <div class="compare-transcript${state.highlights ? "" : " no-highlights"}" aria-label="${title} transcript">${transcriptSegments(ctx, comparison, side)}</div>
      <div class="compare-actions"><button type="button" class="button secondary" data-copy-transcript="${side}">Copy response</button><button type="button" class="button secondary" data-download-transcript="${side}">Download TXT</button></div>
      <p class="compare-feedback" id="compare-copy-feedback-${side}" aria-live="polite"></p>
    </section>`;
  }
  function dataErrorMessage(ctx, message) {
    return `<p class="error-box" role="alert">${esc(ctx, message)} <button type="button" class="button secondary small" id="retry-live-comparison">Try again</button></p>`;
  }
  function activeStatus(ctx, parent, child) {
    const stage = parent.sandbox?.stage;
    const active = (job) => ["queued", "preparing", "connecting", "streaming", "sending", "waiting", "running"].includes(job?.status);
    if (!active(parent) && !active(child) && stage !== "reviewing") return "";
    const reviewIsActive = stage === "reviewing" || active(child);
    const label = reviewIsActive ? "Reviewing the response" : friendlyStatus(parent);
    const elapsed = Number(parent.elapsedMs);
    return `<section class="compare-active-test" role="status"><div><span class="live-dot"></span><strong>${esc(ctx, label)}</strong>${Number.isFinite(elapsed) ? `<span>${esc(ctx, (elapsed / 1000).toFixed(1))} sec</span>` : ""}</div>
      ${parent.progress?.percent != null ? `<div class="job-progress"><span style="width:${Math.max(0, Math.min(100, Number(parent.progress.percent) || 0))}%"></span></div>` : ""}
      <button type="button" class="button secondary small" id="stop-sandbox-run" ${state.submittingStop ? "disabled" : ""}>Stop</button></section>`;
  }
  function confirmationPanel(ctx, comparison, parent) {
    if (String(state.confirmParentId) !== String(parent.id)) return "";
    const exactPrompt = typeof comparison.after?.promptUsed === "string" ? comparison.after.promptUsed : "";
    return `<section class="apply-confirmation"><div class="score-section-heading"><div><p class="section-label">Your updated system prompt</p><h2>Copy this prompt into your agent</h2></div><button type="button" class="button secondary small" id="close-apply-confirmation">Close</button></div>
      <textarea id="sandbox-copy-text" readonly rows="9" aria-label="Exact updated system prompt">${esc(ctx, exactPrompt)}</textarea>
      <div class="prompt-actions"><button type="button" class="button" id="copy-sandbox-prompt" ${exactPrompt ? "" : "disabled"}>Copy prompt</button></div>
      <p class="copy-feedback" aria-live="polite">${esc(ctx, state.copyFeedback)}</p>
      <p class="apply-coming-note">Direct updating of connected agents is coming soon. Copy this prompt to update your agent.</p>
    </section>`;
  }
  function runDetails(ctx, parent, before, child) {
    const after = parent;
    const referenceStatus = after.inputSnapshot?.referenceMaterialSuppliedToModel === false
      ? "Reference material was saved with this run and was not supplied to the model."
      : "";
    return `<details class="score-disclosure comparison-run-details"><summary>Run details</summary>
      <p><strong>Recording:</strong> ${esc(ctx, after.recording?.fileName || after.recording?.label || "Selected recording")}</p>
      <p><strong>Use case:</strong> ${esc(ctx, after.useCase?.label || "Saved use case")}</p>
      <p><strong>Run status:</strong> ${esc(ctx, friendlyStatus(after))}</p>
      <p><strong>Reference material:</strong> ${esc(ctx, referenceStatus || "Not recorded")}</p>
      <p><strong>Original run:</strong> ${esc(ctx, displayDate(before?.createdAt))}</p>
      <p><strong>Updated run:</strong> ${esc(ctx, displayDate(after.createdAt))}</p>
      ${child?.error ? `<p>${esc(ctx, "The audio test is saved, but the additional review could not be completed.")}</p>` : ""}
      ${debugMode() ? `<pre class="output-block">${esc(ctx, safeDebugText(JSON.stringify({ before, after, child }, null, 2)))}</pre>` : ""}
    </details>`;
  }
  function bindLive(ctx, comparison, parent, before) {
    document.getElementById("highlight-changes")?.addEventListener("change", event => {
      state.highlights = event.currentTarget.checked;
      renderLive(latestContext || ctx);
    });
    document.getElementById("retry-live-comparison")?.addEventListener("click", () => {
      ensureLiveComparison(before, parent, null, true);
    });
    document.getElementById("stop-sandbox-run")?.addEventListener("click", async () => {
      if (state.submittingStop) return;
      state.submittingStop = true;
      renderLive(latestContext || ctx);
      await window.CadenceSimulation?.stopJob?.(parent.id);
      state.submittingStop = false;
      renderLatest();
    });
    document.querySelectorAll("[data-copy-transcript]").forEach(button => button.addEventListener("click", async () => {
      const side = button.dataset.copyTranscript;
      const feedback = document.getElementById(`compare-copy-feedback-${side}`);
      const value = transcriptText(comparison, side);
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Unavailable");
        await navigator.clipboard.writeText(value);
        if (feedback) feedback.textContent = "Response copied.";
      } catch {
        if (feedback) feedback.textContent = "Couldn’t copy. Select the response text and copy it manually.";
      }
    }));
    document.querySelectorAll("[data-download-transcript]").forEach(button => button.addEventListener("click", () => {
      const side = button.dataset.downloadTranscript;
      const content = transcriptText(comparison, side);
      const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${side}-response.txt`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }));
    document.getElementById("apply-sandbox-prompt")?.addEventListener("click", () => {
      state.confirmParentId = parent.id;
      state.copyFeedback = "";
      renderLive(latestContext || ctx);
    });
    document.getElementById("close-apply-confirmation")?.addEventListener("click", () => {
      state.confirmParentId = null;
      renderLive(latestContext || ctx);
    });
    document.getElementById("copy-sandbox-prompt")?.addEventListener("click", async () => {
      const prompt = typeof comparison.after?.promptUsed === "string" ? comparison.after.promptUsed : "";
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Unavailable");
        await navigator.clipboard.writeText(prompt);
        state.copyFeedback = "Prompt copied.";
      } catch {
        state.copyFeedback = "Couldn’t copy. Select the prompt above and copy it manually.";
        renderLive(latestContext || ctx);
        const textarea = document.getElementById("sandbox-copy-text");
        textarea?.focus();
        textarea?.select();
        return;
      }
      renderLive(latestContext || ctx);
    });
  }
  function renderLive(ctx) {
    if (!ctx || location.hash !== "#/comparison") return;
    const simulation = window.CadenceSimulation;
    const runsState = simulation?.getRunsState?.() || { loading: false, error: "" };
    const { parent, before, child } = findSandbox(ctx);
    const currentSampleValue = currentSample(ctx);
    if (!parent || !before) {
      const statusMarkup = simulation?.isSandboxStarting?.()
        ? `<section class="compare-active-test" role="status"><span class="live-dot"></span><strong>Starting your test…</strong></section>`
        : runsState.loading
        ? `<section class="compare-empty" aria-busy="true"><p class="compare-loading">Loading your runs…</p></section>`
        : runsState.error
          ? `<section class="compare-empty"><p class="error-box" role="alert">We couldn’t load your runs. Please try again.</p><button type="button" class="button" id="retry-runs">Try again</button></section>`
          : `<section class="compare-empty"><p>Compare transcripts before and after a prompt change. Run a baseline and a revised prompt to see the differences here.</p><div class="placeholder-actions"><a class="button" href="#/scorecard">Go to review</a><a class="button secondary" href="#/simulation">Go to Simulation</a></div></section>`;
      ctx.content.innerHTML = `<div class="page-heading"><div><div class="eyebrow">04 / Before &amp; after</div><h1>Before &amp; after</h1><p class="page-intro">See how a prompt change affected the same recording.</p></div><div class="step-count">STEP 04 / 04</div></div>${statusMarkup}`;
      document.getElementById("retry-runs")?.addEventListener("click", () => simulation?.refreshRuns?.());
      return;
    }
    const key = pairKey(before, parent);
    ensureLiveComparison(before, parent, child);
    const comparison = state.livePairs.get(key);
    const loadError = state.liveErrors.get(key);
    const loading = state.liveLoading.has(key);
    const active = activeStatus(ctx, parent, child);
    const selectedPrompt = typeof comparison?.after?.promptUsed === "string";
    const terminalProblem = ["failed", "cancelled", "stopped"].includes(parent.status);
    const stageReady = comparison?.ready === true || parent.sandbox?.stage === "complete";
    const content = !comparison
      ? terminalProblem
        ? `<section class="compare-empty"><p>This test didn’t finish. You can review the saved details or start another test.</p><div class="placeholder-actions"><a class="button" href="#/scorecard">Go to review</a><a class="button secondary" href="#/simulation">Go to Simulation</a></div></section>`
        : loadError
        ? dataErrorMessage(ctx, loadError)
        : `<section class="compare-empty" aria-busy="${loading ? "true" : "false"}"><p>${loading ? "Preparing your comparison…" : "Your before-and-after results will appear here."}</p></section>`
      : comparison.comparable === false
        ? `<section class="compare-empty"><p>This recording and its settings don’t match, so these runs can’t be compared.</p></section>`
        : !comparison.ready && terminalProblem
          ? `<section class="compare-empty"><p>This test didn’t finish. You can review the saved details or start another test.</p><div class="placeholder-actions"><a class="button" href="#/scorecard">Go to review</a><a class="button secondary" href="#/simulation">Go to Simulation</a></div></section>`
        : !stageReady && !comparison.ready
          ? `<section class="compare-empty"><p>The comparison will be ready when the test is complete.</p></section>`
          : `<div class="compare-live-results">
              ${performanceColumns(ctx, comparison)}
              ${comparisonThemes(ctx, comparison)}
              ${promptDiffColumns(ctx, comparison)}
              <div class="compare-header-row"><div class="compare-counts" aria-label="Transcript changes">
                <div class="compare-count removed"><strong>${esc(ctx, comparison.transcriptDiff?.counts?.removedWords ?? "—")}</strong><span>Removed words</span></div>
                <div class="compare-count added"><strong>${esc(ctx, comparison.transcriptDiff?.counts?.addedWords ?? "—")}</strong><span>Added words</span></div>
              </div><label class="compare-highlight"><input type="checkbox" id="highlight-changes"${state.highlights ? " checked" : ""}> Highlight changes</label></div>
              <div class="compare-columns">${transcriptPanel(ctx, comparison, "before")}${transcriptPanel(ctx, comparison, "after")}</div>
              ${selectedPrompt ? `<button type="button" class="button apply-sandbox-button" id="apply-sandbox-prompt">Apply these changes to your agent</button>` : ""}
              ${confirmationPanel(ctx, comparison, parent)}
              ${runDetails(ctx, parent, before, child)}
            </div>`;
    const stageText = parent.sandbox?.stage === "reviewing"
      ? "Your recording is complete. Reviewing the response…"
      : parent.sandbox?.stage === "complete" ? "Your test is complete." : "Your test is in progress.";
    ctx.content.innerHTML = `<div class="page-heading"><div><div class="eyebrow">04 / Before &amp; after</div><h1>Before &amp; after</h1><p class="page-intro">See how a prompt change affected the same recording.</p></div><div class="step-count">STEP 04 / 04</div></div>
      <section class="compare-test-meta"><div><p class="section-label">Selected recording</p><h2>${esc(ctx, parent.recording?.fileName || parent.recording?.label || "Selected recording")}</h2><p>${esc(ctx, parent.useCase?.label || "Saved use case")}</p>${currentSampleValue && String(parent.sampleId) !== String(currentSampleValue.id) ? `<p class="compare-history-note">Showing a saved comparison from another use case. Your current setup is unchanged.</p>` : ""}</div><span class="sim-state ${esc(ctx, String(parent.status || "").toLowerCase())}">${esc(ctx, friendlyStatus(parent))}</span></section>
      ${active}
      ${!active && parent.sandbox?.reviewError ? `<p class="review-note">${esc(ctx, "The audio test is saved, but the additional review could not be completed.")}</p>` : ""}
      ${!active ? `<p class="compare-stage-note">${esc(ctx, stageText)}</p>` : ""}
      ${content}`;
    if (comparison && comparison.comparable !== false) bindLive(ctx, comparison, parent, before);
    else {
      document.getElementById("retry-live-comparison")?.addEventListener("click", () => ensureLiveComparison(before, parent, child, true));
      document.getElementById("stop-sandbox-run")?.addEventListener("click", () => simulation?.stopJob?.(parent.id));
    }
  }
  function render(ctx) {
    latestContext = ctx;
    if (!unsubscribeRuns && window.CadenceSimulation?.onRunsChange) {
      unsubscribeRuns = window.CadenceSimulation.onRunsChange(notifyFromRuns);
    }
    if (debugMode()) {
      if (!state.demo && !state.demoLoading && !state.demoError) {
        state.demoLoading = true;
        fetchDemo();
      } else renderDemo(ctx);
      return;
    }
    renderLive(ctx);
  }
  window.CadenceComparison = { render };
})();
