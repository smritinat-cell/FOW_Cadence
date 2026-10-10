(() => {
  "use strict";
  const enabled = document.documentElement?.dataset.demo === "true" || new URLSearchParams(location.search).get("demo") === "1";
  if (enabled) document.getElementById("demo-mode-badge").hidden = false;
  let pair = null, pending = null, fixed = false, running = false, runKind = "baseline", hasRun = false, runSampleId = null, runSequence = 0;
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function load() {
    if (!pending) pending = fetch("./comparison-results.json").then(async response => {
      if (!response.ok) throw new Error("Demo results unavailable.");
      const data = await response.json();
      if (typeof data.old?.text !== "string" || typeof data.new?.text !== "string" || typeof data.new?.prompt !== "string") throw new Error("Demo results unavailable.");
      pair = data;
      return data;
    }).catch(error => { pending = null; throw error; });
    return pending;
  }
  const heading = (title, step, intro) => `<div class="page-heading"><div><div class="eyebrow">Evaluation workspace / ${step}</div><h1>${title}</h1><p class="page-intro">${intro}</p></div><div class="step-count">STEP ${step} / 04</div></div>`;
  function transcript(title, text) {
    return `<section class="score-section"><div class="score-section-heading"><div><p class="section-label">Demo transcript</p><h2>${title}</h2></div><span class="sim-state finished">Complete</span></div><pre class="output-block demo-transcript">${escape(text)}</pre></section>`;
  }
  function preview(sample) {
    if (!enabled || !pair || !sample) return "";
    return `<details class="score-disclosure"><summary>Demo transcript</summary><pre class="output-block">${escape(pair.old.text)}</pre></details>`;
  }
  function draw(ctx, route) {
    const selected = (ctx.samples || []).find(sample => String(sample.id) === String(ctx.experiment?.selectedId));
    const selectedFilename = selected?.audio_filename || pair.old.source.name;
    const selectedId = String(ctx.experiment?.selectedId || "default");
    if (runSampleId !== null && runSampleId !== selectedId) {
      hasRun = false;
      running = false;
      fixed = false;
      runSampleId = null;
      runSequence++;
    }
    if (route !== "/simulation" && !hasRun) {
      ctx.content.innerHTML = `${heading(route === "/comparison" ? "Results Summary" : "Review of your agent", route === "/comparison" ? "04" : "03", "Review your completed run.")}<section class="compare-empty"><p>Run the recording in Simulation to view your results.</p><a class="button" href="#/simulation">Go to Simulation</a></section>`;
      return;
    }
    if (route === "/comparison") {
      window.CadenceComparison.renderSaved(ctx, pair, selectedFilename);
      return;
    }
    const filename = escape(selectedFilename);
    const meta = `<section class="compare-test-meta"><div><h2>${filename}</h2></div><span class="sim-state finished">Demo results</span></section>`;
    if (route === "/simulation") {
      const model = /^demo-model-[1-4]$/.test(ctx.experiment?.model || "") ? ctx.experiment.model : "demo-model-1";
      const prompt = typeof ctx.experiment?.prompt === "string" ? ctx.experiment.prompt : pair.old.prompt;
      const output = running
        ? `<section class="score-section demo-run-loading" role="status" aria-live="polite" aria-busy="true"><span class="demo-run-spinner" aria-hidden="true"></span><h2>Processing recording…</h2><p>Your response is on its way.</p></section>`
        : hasRun ? transcript(runKind === "candidate" ? "Your prompt response" : "Baseline response", pair.old.text) : "";
      ctx.content.innerHTML = `${heading("Simulation", "02", "Review the recording’s baseline result.")}${meta}
        <section class="panel sim-config-panel"><div class="panel-header"><div><p class="section-label">Run settings</p><h2 class="section-title">Choose a speech model</h2></div></div>
          <div class="sim-model-actions"><div class="field sim-model-field"><label for="model-select">Model</label><select id="model-select"${running ? " disabled" : ""}>${[1, 2, 3, 4].map(index => `<option value="demo-model-${index}"${model === `demo-model-${index}` ? " selected" : ""}>Speech model ${index}</option>`).join("")}</select></div>
          <div class="sim-run-buttons"><button type="button" class="button" id="demo-run-baseline"${running ? " disabled" : ""}>${running && runKind === "baseline" ? "Running…" : "Run baseline"}</button><button type="button" class="button secondary" id="demo-run-candidate"${running ? " disabled" : ""}>${running && runKind === "candidate" ? "Running…" : "Run with my prompt"}</button></div></div></section>
        <div class="demo-stage-grid${!hasRun && !running ? " demo-before-run" : ""}" id="demo-run-output">${output}<section class="score-section"><div class="field"><label class="section-label" for="demo-system-prompt">System prompt used</label><textarea id="demo-system-prompt" class="output-block demo-prompt-editor" rows="5" spellcheck="false">${escape(prompt)}</textarea></div>${hasRun && !running ? '<div class="demo-actions"><a class="button" href="#/scorecard">Continue to Scorecard</a></div>' : ""}</section></div>`;
      document.getElementById("demo-system-prompt").addEventListener("input", event => {
        if (ctx.experiment) ctx.experiment.prompt = event.currentTarget.value;
        ctx.saveExperiment?.();
      });
      document.getElementById("model-select").addEventListener("change", event => {
        if (ctx.experiment) ctx.experiment.model = event.currentTarget.value;
        ctx.saveExperiment?.();
      });
      for (const kind of ["baseline", "candidate"]) document.getElementById(`demo-run-${kind}`).addEventListener("click", () => {
        if (running) return;
        const sequence = ++runSequence;
        runSampleId = selectedId;
        runKind = kind;
        hasRun = false;
        fixed = false;
        running = true;
        draw(ctx, route);
        window.setTimeout(() => {
          if (sequence !== runSequence) return;
          running = false;
          hasRun = String(ctx.experiment?.selectedId || "default") === runSampleId;
          const currentRoute = location.hash.slice(1);
          if (!["/simulation", "/scorecard", "/comparison"].includes(currentRoute)) return;
          draw(ctx, currentRoute);
          if (currentRoute === "/simulation") document.getElementById("demo-run-output")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 1600);
      });
      return;
    }
    const changes = window.TranscriptDiff.compare(pair.old.text, pair.new.text);
    const ui = window.CadenceSimulation.scorecardMarkup;
    const result = fixed ? pair.new : pair.old;
    const findings = [
      { id: "repetition", severity: "medium", parameterLabel: "Speech patterns", title: "Repeated wording obscures the completed phrase", quote: "new, new, um, new, um, books", why_it_matters: "Hesitation fillers and repetitions make the response harder to read.", prompt_coverage: "none" },
      { id: "vocabulary", severity: "medium", parameterLabel: "Vocabulary and uncertainty", title: "Unfamiliar terms need clearer guidance", quote: "Nin, for my Nin Ten, Nin Ten", why_it_matters: "Reference vocabulary can help identify unfamiliar terms while preserving uncertainty.", prompt_coverage: "none" }
    ].filter(finding => pair.old.text.includes(finding.quote));
    const paragraphs = pair.new.prompt.split(/\r?\n\r?\n/);
    const updates = [
      { id: "speech-patterns", category: "Speech patterns", type: "append", addresses: ["repetition"], rationale: "Preserve the completed wording when the speaker hesitates or repeats a word.", new_text: paragraphs.slice(2, 4).join("\n\n"), expected_effect: "A clearer transcript with meaningful short responses retained.", verify_by: "Compare the original and improved wording." },
      { id: "vocabulary", category: "Vocabulary and uncertainty", type: "append", addresses: ["vocabulary"], rationale: "Use the saved reference vocabulary to help with unfamiliar terms.", new_text: paragraphs[4], expected_effect: "Terms follow the audio and context, with uncertainty preserved.", verify_by: "Check unfamiliar terms against the recording." }
    ];
    const review = { id: "saved-demo-review", verifiedFindings: findings, promptUpdates: updates };
    const accessibility = ui.performance({
      status: "finished", rawOutput: result.text, performance: result.performance || result.demoPerformance,
      recording: { fileName: selectedFilename },
      useCase: { label: selected?.use_case_label || "" }
    }, selected);
    const promptDiff = [{ type: "removed", text: pair.old.prompt }, { type: "added", text: pair.new.prompt }];
    ctx.content.innerHTML = `<div class="demo-scorecard">${heading("Review of your agent", "03", "What we found in the transcript, and how to improve your prompt.")}
      <section class="scorecard-toolbar panel"><div class="scorecard-select"><label for="demo-review-select">Saved reviews</label><select id="demo-review-select"><option>${escape(selected?.title || "Selected recording")} · Complete</option></select></div></section>
      <div class="scorecard-review-heading"><div><p class="section-label">Your saved review</p><p>${filename} · ${escape(selected?.use_case_label || "")}</p></div><span class="sim-state finished">Complete</span></div>
      <div class="scorecard-content">${accessibility}
        <section class="score-section review-findings"><p class="review-summary-copy">Review how the agent handles speech patterns and unfamiliar terms.</p><div class="score-section-heading"><div><p class="section-label">Verified findings</p><h2>What to improve</h2></div></div><div class="finding-list">${findings.map(ui.finding).join("")}</div></section>
        <section class="score-section"><div class="score-section-heading"><div><p class="section-label">Recommended system prompt edits</p><h2>Make the next test clearer</h2></div></div>
          <div class="score-proposal-controls"><button type="button" class="button secondary small" id="demo-fix">${fixed ? "View completed fix" : "Fix prompt"}</button></div>
          ${ui.edits(review, updates, { showApplyButtons: false })}
          <div class="score-proposal-preview"><div class="score-section-heading"><div><p class="section-label">Prompt changes</p><h2>Current and proposed</h2></div></div>${ui.promptDiff(promptDiff)}
            <div class="proposal-test-actions"><button type="button" class="button" id="demo-test-changes">${fixed ? "View completed test" : "Test these changes"}</button><a class="button secondary" href="#/comparison">View results summary</a></div>
          </div>
        </section>
        ${fixed ? `<section class="score-section demo-fixed-output"><div class="score-section-heading"><div><p class="section-label">Completed demo result</p><h2>Improved response</h2></div><span class="sim-state finished">Complete</span></div><div class="compare-counts"><div class="compare-count removed"><strong>${changes.removedWords}</strong><span>Words removed</span></div><div class="compare-count added"><strong>${changes.addedWords}</strong><span>Words added</span></div></div><pre class="output-block demo-transcript">${escape(pair.new.text)}</pre><div class="demo-actions"><a class="button" href="#/comparison">View results summary</a></div></section>` : ""}
        <details class="score-disclosure"><summary>Run details</summary><p>${filename}</p><pre class="output-block">${escape(pair.old.text)}</pre></details>
      </div></div>`;
    const showCompletedFix = () => {
      fixed = true;
      draw(ctx, route);
      document.querySelector(".demo-fixed-output")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    document.getElementById("demo-fix")?.addEventListener("click", showCompletedFix);
    document.getElementById("demo-test-changes")?.addEventListener("click", showCompletedFix);
  }
  function render(ctx, route) {
    ctx.content.innerHTML = `<section class="compare-empty" aria-busy="true"><p>Loading demo results…</p></section>`;
    load().then(() => { if (location.hash === `#${route}`) draw(ctx, route); }).catch(() => {
      if (location.hash !== `#${route}`) return;
      ctx.content.innerHTML = `<section class="compare-empty"><p>We couldn’t load the demo results.</p><button type="button" class="button" id="retry-demo">Try again</button></section>`;
      document.getElementById("retry-demo")?.addEventListener("click", () => render(ctx, route));
    });
  }
  window.CadenceDemoFlow = { enabled, load, render, preview };
})();
