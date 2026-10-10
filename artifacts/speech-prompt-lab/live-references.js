(() => {
  "use strict";
  const recordings = [
    { id: "sample-01", title: "Stuttering and repetitions", filename: "M_0061_14y8m_1.wav" },
    { id: "sample-02", title: "Slower speech", filename: "F_0101_10y4m_1.wav" },
    { id: "sample-03", title: "Longer pauses", filename: "F_0558_10y0m_1.wav" }
  ];
  let generation = 0;
  let mounted = false;
  let status = null;
  let current = null;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: "include", ...options });
    let data;
    try { data = await response.json(); } catch { throw new Error("The live server could not be reached."); }
    if (!response.ok) throw new Error(data?.error?.message || "Unlock live evaluation before checking references.");
    return data;
  }
  function message(text) { const node = document.getElementById("live-reference-feedback"); if (node) node.textContent = text; }
  async function load(id) {
    const version = ++generation;
    current = null;
    const body = document.getElementById("live-reference-body");
    if (!body) return;
    body.innerHTML = '<p role="status">Loading reference…</p>';
    try {
      const reference = await request(`/api/live/references?sampleId=${encodeURIComponent(id)}`);
      if (version !== generation) return;
      current = reference;
      const recording = recordings.find(item => item.id === id);
      const clip = status?.clips?.find(item => item.sampleId === id);
      const source = clip?.audioSrc || clip?.audio_url || `/api/demo-samples/${encodeURIComponent(id)}/audio`;
      const audioSrc = /^\/(?!\/)/.test(source) ? source : "";
      const items = (reference.criticalItems || []).map(item => [item.label, ...(item.phrases || []).filter(phrase => phrase !== item.label)].join(" | ")).join("\n");
      body.innerHTML = `<form id="live-reference-form"><p class="field-help">${esc(recording?.filename)} · ${Number(reference.excerpt?.startOffset || 0)}–${Number(reference.excerpt?.startOffset || 0) + 15} sec</p><audio id="live-reference-audio" controls preload="metadata" src="${esc(audioSrc)}"></audio><div class="field"><label for="live-reference-text">Readable reference transcript</label><textarea id="live-reference-text" rows="5" required maxlength="10000">${esc(reference.referenceTranscript)}</textarea><p class="field-help">Keep the spoken meaning and order. Remove fillers and repeated starts; use [unclear] for uncertain wording.</p></div><div class="field"><label for="live-reference-items">Key details</label><textarea id="live-reference-items" rows="4" required>${esc(items)}</textarea><p class="field-help">One detail per line. Add alternative wording with | when needed.</p></div><label class="live-reference-confirm"><input type="checkbox" id="live-reference-checked" required> I checked this reference and its key details against the 15-second excerpt.</label><button type="submit" class="button secondary" id="live-reference-save">Save checked reference</button><p id="live-reference-feedback" role="status" aria-live="polite">${reference.verified ? "Checked reference saved. Recheck before changing it." : "Listen to the excerpt and check the draft before saving."}</p></form>`;
      const audio = document.getElementById("live-reference-audio");
      const start = Number(reference.excerpt?.startOffset || 0), end = start + 15;
      audio.addEventListener("play", () => { if (audio.currentTime < start || audio.currentTime >= end) audio.currentTime = start; });
      audio.addEventListener("timeupdate", () => { if (audio.currentTime >= end) { audio.pause(); audio.currentTime = start; } });
      audio.addEventListener("error", () => message("The recording could not be loaded. Check the live server’s audio files."));
      for (const field of ["live-reference-text", "live-reference-items"]) document.getElementById(field).addEventListener("input", () => { document.getElementById("live-reference-checked").checked = false; });
      document.getElementById("live-reference-form").addEventListener("submit", save);
    } catch (error) { if (version === generation) body.innerHTML = `<p role="alert">${esc(error.message)}</p>`; }
  }
  async function save(event) {
    event.preventDefault();
    if (!current || !document.getElementById("live-reference-checked")?.checked) return;
    if (window.CadenceLiveFlow?.isBusy?.()) { message("Stop the active run before changing the reference."); return; }
    const reference = current, version = generation;
    const criticalItems = document.getElementById("live-reference-items").value.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
      const [label, ...alternatives] = line.split("|").map(part => part.trim()).filter(Boolean);
      return { label, phrases: alternatives.length ? alternatives : [label] };
    });
    const button = document.getElementById("live-reference-save");
    button.disabled = true;
    message("Saving checked reference…");
    try {
      const saved = await request("/api/live/references", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sampleId: reference.sampleId, referenceTranscript: document.getElementById("live-reference-text").value, criticalItems, startOffset: reference.excerpt.startOffset, excerptLength: 15, verified: true }) });
      if (version !== generation) return;
      current = saved;
      message("Reference saved. This recording is ready to prepare.");
      window.CadenceLiveFlow?.refresh?.();
    } catch (error) { if (version === generation) message(error.message); }
    finally { if (version === generation) button.disabled = false; }
  }
  async function refresh() {
    const mount = document.getElementById("live-reference-editor");
    if (!mount || !document.getElementById("cadence-mode-panel")?.open) return;
    try {
      status = await request("/api/live/status");
      if (!status.authorized || !status.configured) { mount.innerHTML = ""; mounted = false; return; }
      if (mounted) return;
      mounted = true;
      mount.innerHTML = `<details class="live-reference-details"><summary>Check recording references</summary><div class="field"><label for="live-reference-recording">Recording</label><select id="live-reference-recording">${recordings.map(item => `<option value="${item.id}">${esc(item.title)}</option>`).join("")}</select></div><div id="live-reference-body"></div></details>`;
      const select = document.getElementById("live-reference-recording");
      select.addEventListener("change", () => load(select.value));
      await load(select.value);
    } catch { /* Authentication feedback belongs to the mode controls. */ }
  }
  function mount() {
    const panel = document.getElementById("cadence-mode-panel");
    if (!panel) return;
    new MutationObserver(() => { if (panel.open) refresh(); }).observe(panel, { attributes: true, attributeFilter: ["open"] });
  }
  window.CadenceLiveReferences = { refresh };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
