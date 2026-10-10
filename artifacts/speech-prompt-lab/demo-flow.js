(() => {
  "use strict";
  const enabled = new URLSearchParams(location.search).get("demo") === "1";
  if (enabled) document.getElementById("demo-mode-badge").hidden = false;
  let pair = null, pending = null, fixed = false;
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
    if (!enabled || !pair || sample?.audio_filename !== pair.old.source.name) return "";
    return `<details class="score-disclosure"><summary>Demo transcript</summary><pre class="output-block">${escape(pair.old.text)}</pre></details>`;
  }
  function draw(ctx, route) {
    if (route === "/comparison") {
      window.CadenceComparison.renderSaved(ctx, pair);
      return;
    }
    const filename = escape(pair.old.source.name);
    const meta = `<section class="compare-test-meta"><div><h2>${filename}</h2></div><span class="sim-state finished">Demo results</span></section>`;
    if (route === "/simulation") {
      ctx.content.innerHTML = `${heading("Simulation", "02", "Review the recording’s baseline result.")}${meta}
        <div class="demo-stage-grid">${transcript("Baseline response", pair.old.text)}<section class="score-section"><p class="section-label">System prompt used</p><pre class="output-block">${escape(pair.old.prompt)}</pre><div class="demo-actions"><a class="button" href="#/scorecard">Continue to Scorecard</a></div></section></div>`;
      return;
    }
    const changes = window.TranscriptDiff.compare(pair.old.text, pair.new.text);
    ctx.content.innerHTML = `${heading("Review of your agent", "03", "Review the transcript and improve its wording.")}${meta}
      <div class="demo-stage-grid">${transcript("Original response", pair.old.text)}<section class="score-section"><p class="section-label">Prompt improvement</p><h2>Make the transcript clearer</h2><p class="demo-review-copy">Remove hesitation fillers and repeated wording while preserving the speaker’s meaning. Use the reference vocabulary for unfamiliar terms.</p><button type="button" class="button" id="demo-fix">${fixed ? "View completed fix" : "Fix prompt"}</button>
      ${fixed ? `<div class="demo-completed" role="status"><span class="sim-state finished">Completed demo result</span><div class="compare-counts"><div class="compare-count removed"><strong>${changes.removedWords}</strong><span>Words removed</span></div><div class="compare-count added"><strong>${changes.addedWords}</strong><span>Words added</span></div></div></div>` : ""}</section></div>
      ${fixed ? `<div class="demo-fixed-output">${transcript("Improved response", pair.new.text)}<details class="score-disclosure"><summary>Improved system prompt</summary><pre class="output-block">${escape(pair.new.prompt)}</pre></details><div class="demo-actions"><a class="button" href="#/comparison">View before &amp; after</a></div></div>` : ""}`;
    document.getElementById("demo-fix")?.addEventListener("click", () => { fixed = true; draw(ctx, route); document.querySelector(".demo-fixed-output")?.scrollIntoView({ behavior: "smooth", block: "start" }); });
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
