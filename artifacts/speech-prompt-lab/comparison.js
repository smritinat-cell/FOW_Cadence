/* Saved response comparison. Provider execution belongs to the simulation flow. */
(function (root) {
  "use strict";
  const MAX_TEXT = 100000;
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_ALIGNMENT_CELLS = 16000000;
  const diff = typeof module !== "undefined" && module.exports
    ? require("./transcript-diff.js") : root.TranscriptDiff;

  function normalizeResult(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.text !== "string") {
      throw new Error('Choose a result JSON with a "text" field, or a plain TXT transcript.');
    }
    if (raw.text.length > MAX_TEXT) throw new Error("Use a transcript of up to 100,000 characters.");
    // Export only documented result fields; credentials and session URLs are omitted.
    const result = { text: raw.text };
    for (const key of ["run_id", "created_at", "prompt", "service_input_transcript"]) {
      if (typeof raw[key] === "string") result[key] = raw[key];
    }
    if (typeof raw.complete === "boolean") result.complete = raw.complete;
    for (const [group, keys] of Object.entries({
      source: ["name", "sha256"],
      audio: ["sha256", "start_seconds", "duration_seconds"],
      engine: ["name", "model", "requested_model", "temperature", "replay_speed", "vad", "trailing_silence_seconds"],
      timing: ["cloud_seconds", "total_seconds"]
    })) {
      result[group] = {};
      for (const key of keys) {
        const value = raw[group]?.[key];
        if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) result[group][key] = value;
      }
    }
    return result;
  }

  function parseImport(text, filename) {
    if (/\.json$/i.test(filename)) {
      let raw;
      try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); }
      catch { throw new Error("This JSON could not be read. Choose a valid result export."); }
      return normalizeResult(raw);
    }
    if (!/\.txt$/i.test(filename)) throw new Error("Choose a JSON result export or a TXT transcript.");
    return normalizeResult({ text });
  }

  function compareResults(oldResult, newResult) {
    // Bound the quadratic alignment work for untrusted imported transcripts.
    const tokens = text => (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) || []).length;
    if (tokens(oldResult.text) * tokens(newResult.text) > MAX_ALIGNMENT_CELLS) return null;
    return diff.compare(oldResult.text, newResult.text);
  }

  function comparisonContext(a, b) {
    if (!a || !b) return "Load both results to compare their wording.";
    const hashA = a.audio?.sha256, hashB = b.audio?.sha256;
    const modelA = a.engine?.model, modelB = b.engine?.model;
    if ((hashA && hashB && hashA !== hashB) || (modelA && modelB && modelA !== modelB)) {
      return "Different audio or models. Use matching inputs to evaluate a prompt change.";
    }
    for (const key of ["requested_model", "temperature", "replay_speed", "vad", "trailing_silence_seconds"]) {
      if (a.engine?.[key] != null && b.engine?.[key] != null && a.engine[key] !== b.engine[key]) {
        return "Different model settings. Use matching settings to evaluate a prompt change.";
      }
    }
    return hashA && hashB && modelA && modelB
      ? "Same audio and model. Changes describe wording; accuracy requires a reference transcript."
      : "Audio and model metadata unavailable. Changes describe wording; accuracy requires a reference transcript.";
  }

  const records = { old: null, new: null };
  const imports = { old: 0, new: 0 };
  let host = null;
  let highlighted = true;
  let comparison = null;
  let demoRequested = false;
  let revision = 0;
  let selectedFilename = "";

  function element(id) { return host.querySelector(`#${id}`); }
  function announce(message) {
    const feedback = element("comparison-feedback");
    if (feedback) feedback.textContent = message;
  }

  function setResult(side, raw) {
    if (side !== "old" && side !== "new") throw new Error("Choose the old or new result slot.");
    records[side] = normalizeResult(raw);
    revision++;
    if (host?.isConnected && host.querySelector(".comparison-screen")) update();
  }

  function card(side, letter, title, subtitle) {
    return `<section class="panel response-card response-${side}" aria-labelledby="${side}-heading">
      <div class="response-heading"><div><p class="response-kicker">${letter} · ${subtitle}</p><h2 id="${side}-heading">${title}</h2></div><span class="response-status" id="${side}-status">Awaiting result</span></div>
      <div class="response-meta" id="${side}-meta"></div>
      <p class="response-partial" id="${side}-partial" hidden>Partial response: the saved session ended before all output was confirmed final.</p>
      <div class="response-transcript" id="${side}-text" tabindex="0" role="region" aria-label="${title} model response"></div>
      <div class="response-actions"><button class="button secondary small" type="button" id="${side}-copy" disabled>Copy response</button><div><button class="comparison-link" type="button" id="${side}-txt" disabled>↓ TXT</button><button class="comparison-link" type="button" id="${side}-json" disabled>↓ JSON</button></div></div>
      <details class="response-details" id="${side}-details" hidden><summary>Inspect run details</summary><dl id="${side}-run-details"></dl></details>
      <details class="response-import"><summary>Load ${side} result <span>JSON / TXT / paste</span></summary>
        <label class="result-upload" for="${side}-file">Choose a saved result<input type="file" id="${side}-file" accept=".json,.txt,application/json,text/plain"></label>
        <form id="${side}-paste-form"><label for="${side}-paste">Or paste the raw response</label><textarea id="${side}-paste" rows="3" maxlength="100000" placeholder="Paste transcript text…"></textarea><button class="button secondary small" type="submit">Use this response</button></form>
      </details>
    </section>`;
  }

  function mount(container, context = {}) {
    host = container;
    selectedFilename = typeof context.filename === "string" ? context.filename : "";
    host.innerHTML = `<div class="comparison-screen">
      <div class="page-heading"><div><div class="eyebrow">Evaluation workspace / 04</div><h1>Before &amp; after</h1><p class="page-intro">See what changed between the original and revised transcripts.</p></div><div class="step-count">STEP 04 / 04</div></div>
      <div class="comparison-source"><span id="comparison-source-name">Load a pair of results</span></div>
      <div class="comparison-toolbar"><div class="comparison-counts" role="status" aria-live="polite"><span class="change-count removed" id="comparison-removed">Removed from old · —</span><span class="change-count added" id="comparison-added">Added in new · —</span></div><label class="comparison-toggle"><input id="comparison-highlight" type="checkbox" checked>Highlight changes</label></div>
      <div class="response-grid">${card("old", "A", "Old transcript", "BASELINE")}${card("new", "B", "New transcript", "REVISED PROMPT")}</div>
      <p class="comparison-context" id="comparison-context"></p>
      <p class="comparison-feedback" id="comparison-feedback" role="status" aria-live="polite"></p>
      <p class="comparison-footnote">Original response text is preserved, including repetitions and line breaks. Punctuation changes are highlighted separately from the word counts. Imported results stay in this tab.</p>
    </div>`;
    element("comparison-highlight").checked = highlighted;
    element("comparison-highlight").addEventListener("change", event => {
      highlighted = event.target.checked;
      renderTranscripts();
    });
    for (const side of ["old", "new"]) {
      element(`${side}-file`).addEventListener("change", async event => {
        const file = event.target.files[0];
        if (!file) return;
        const request = ++imports[side];
        try {
          if (file.size > MAX_FILE_BYTES) throw new Error("Choose a result file smaller than 2 MB.");
          const result = parseImport(await file.text(), file.name);
          if (request !== imports[side]) return;
          setResult(side, result);
          if (host.querySelector(".comparison-screen")) announce(`Loaded ${side} response from ${file.name}.`);
        } catch (error) {
          if (host.querySelector(".comparison-screen")) announce(error.message);
        }
        event.target.value = "";
      });
      element(`${side}-paste-form`).addEventListener("submit", event => {
        event.preventDefault();
        imports[side]++;
        setResult(side, { text: element(`${side}-paste`).value });
        announce(`Loaded ${side} response. Audio and model metadata are unavailable for pasted text.`);
      });
      element(`${side}-copy`).addEventListener("click", async () => {
        const rawText = records[side].text;
        try { await navigator.clipboard.writeText(rawText); announce(`Copied the ${side} response.`); }
        catch {
          if (!element(`${side}-text`)) return;
          const range = document.createRange();
          range.selectNodeContents(element(`${side}-text`));
          const selection = root.getSelection();
          selection.removeAllRanges(); selection.addRange(range);
          announce("Response selected. Press ⌘C or Ctrl+C to copy.");
        }
      });
      for (const format of ["txt", "json"]) element(`${side}-${format}`).addEventListener("click", () => {
        const contents = format === "txt" ? records[side].text : JSON.stringify(records[side], null, 2);
        const url = URL.createObjectURL(new Blob([contents], { type: format === "txt" ? "text/plain;charset=utf-8" : "application/json" }));
        const link = document.createElement("a");
        link.href = url; link.download = `${side}-response.${format}`;
        document.body.append(link);
        link.click(); link.remove();
        root.setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    }
    update();
    if (!demoRequested && !records.old && !records.new) {
      demoRequested = true;
      const startingRevision = revision;
      fetch("./comparison-results.json")
        .then(response => { if (!response.ok) throw new Error(); return response.json(); })
        .then(pair => {
          const oldResult = normalizeResult(pair.old), newResult = normalizeResult(pair.new);
          if (revision !== startingRevision) return;
          records.old = oldResult; records.new = newResult;
          revision++;
          if (host?.querySelector(".comparison-screen")) update();
        })
        .catch(() => {
          if (host?.querySelector(".comparison-screen")) announce("Load saved JSON or TXT results using the controls beneath each transcript.");
        });
    }
  }

  function update() {
    const ready = Boolean(records.old && records.new);
    comparison = ready ? compareResults(records.old, records.new) : null;
    element("comparison-removed").textContent = comparison ? `Removed from old · ${comparison.removedWords} words` : "Removed from old · —";
    element("comparison-added").textContent = comparison ? `Added in new · ${comparison.addedWords} words` : "Added in new · —";
    element("comparison-highlight").disabled = !comparison;
    let context = comparisonContext(records.old, records.new);
    if (ready && !comparison) context += " Highlights unavailable for transcripts this long; raw responses remain available.";
    else if (comparison?.changedTokens === 0) context += " No word or punctuation changes.";
    const names = [...new Set([records.old?.source?.name, records.new?.source?.name].filter(Boolean))];
    element("comparison-source-name").textContent = selectedFilename || (names.length ? names.join(" ↔ ") : "Two raw model responses");
    if (selectedFilename && names.some(name => name !== selectedFilename)) {
      context += ` Displayed saved responses are from ${names.join(" and ")}. Load results for ${selectedFilename} to compare the selected audio.`;
    }
    element("comparison-context").textContent = context;
    for (const side of ["old", "new"]) {
      const result = records[side];
      element(`${side}-status`).textContent = result ? "Saved response" : "Awaiting result";
      element(`${side}-partial`).hidden = result?.complete !== false;
      element(`${side}-details`).hidden = !result;
      for (const action of ["copy", "txt", "json"]) element(`${side}-${action}`).disabled = !result;
      const metadata = [result?.engine?.model];
      if (typeof result?.audio?.start_seconds === "number" && typeof result?.audio?.duration_seconds === "number") {
        metadata.push(`${result.audio.start_seconds}s → ${(result.audio.start_seconds + result.audio.duration_seconds).toFixed(1)}s`);
      }
      element(`${side}-meta`).textContent = metadata.filter(Boolean).join(" · ") || (result ? "Audio and model metadata unavailable" : "Load a saved model response");
      const detail = element(`${side}-run-details`);
      detail.replaceChildren();
      if (result) for (const [label, value] of [
        ["Run ID", result.run_id], ["Recorded", result.created_at],
        ["System prompt sent", result.prompt], ["Ultravox input transcript", result.service_input_transcript]
      ]) {
        if (typeof value !== "string") continue;
        const dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = label; dd.textContent = value;
        detail.append(dt, dd);
      }
      if (result && !detail.childNodes.length) detail.textContent = "Run details are unavailable for this response.";
    }
    renderTranscripts();
  }

  function renderTranscripts() {
    for (const side of ["old", "new"]) {
      const target = element(`${side}-text`), result = records[side];
      const scroll = target.scrollTop;
      target.replaceChildren();
      target.classList.toggle("response-empty", !result);
      if (!result) target.textContent = `Your ${side} transcript will appear here. Load a saved result below.`;
      else if (!highlighted || !comparison) target.textContent = result.text;
      else for (const segment of comparison[side]) {
        if (!segment.changed) target.append(document.createTextNode(segment.text));
        else {
          const mark = document.createElement(side === "old" ? "del" : "ins");
          mark.className = `transcript-${side}`; mark.textContent = segment.text;
          target.append(mark);
        }
      }
      target.scrollTop = scroll;
    }
  }

  const api = { mount, setResult, normalizeResult, parseImport, compareResults, comparisonContext };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CadenceComparison = api;
})(typeof window !== "undefined" ? window : globalThis);
