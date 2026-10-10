(() => {
  "use strict";
  const MODE_KEY = "cadence-tab-mode-v1";
  let mode = "saved";
  try { if (sessionStorage.getItem(MODE_KEY) === "live") mode = "live"; } catch {}
  const key = kind => mode === "saved" && kind === "experiment" ? "speech-prompt-lab-experiment-v1" : `cadence-${mode}-${kind}-v1`;
  function setMode(next) {
    if (!["saved", "live"].includes(next) || next === mode) return;
    try { sessionStorage.setItem(MODE_KEY, next); } catch { return; }
    location.reload();
  }
  function mount() {
    const toggle = document.getElementById("cadence-mode-toggle");
    if (toggle) {
      toggle.setAttribute("aria-checked", String(mode === "live"));
      toggle.addEventListener("click", () => setMode(mode === "live" ? "saved" : "live"));
    }
    const logo = document.querySelector(".brand-logo");
    if (!logo) return;
    logo.setAttribute("tabindex", "0");
    logo.setAttribute("role", "button");
    logo.setAttribute("aria-label", "Cadence");
    const badge = document.getElementById("demo-mode-badge");
    if (mode === "live" && badge) { badge.hidden = false; badge.textContent = "Live"; }
    const panel = document.createElement("dialog");
    panel.id = "cadence-mode-panel";
    panel.className = "cadence-mode-panel";
    panel.setAttribute("aria-labelledby", "cadence-mode-title");
    panel.innerHTML = `<div class="live-panel-heading"><h2 id="cadence-mode-title">Evaluation mode</h2><button type="button" class="button secondary small" id="cadence-mode-close">Close</button></div><div class="live-mode-choices"><button type="button" class="button${mode === "saved" ? "" : " secondary"}" id="cadence-use-saved">Saved results</button><button type="button" class="button${mode === "live" ? "" : " secondary"}" id="cadence-use-live">Live evaluation</button></div><div id="live-reference-editor"></div>`;
    document.body.appendChild(panel);
    let presses = [];
    const activate = () => {
      const now = Date.now();
      presses = presses.filter(time => now - time <= 3000);
      presses.push(now);
      if (presses.length < 5) return;
      presses = [];
      if (!panel.open) {
        panel.showModal();
        window.CadenceLiveReferences?.refresh?.();
      }
    };
    logo.addEventListener("click", activate);
    logo.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); activate(); } });
    document.getElementById("cadence-mode-close").addEventListener("click", () => panel.close());
    document.getElementById("cadence-use-saved").addEventListener("click", () => setMode("saved"));
    document.getElementById("cadence-use-live").addEventListener("click", () => setMode("live"));
  }
  window.CadenceMode = { get mode() { return mode; }, get saved() { return mode === "saved"; }, get live() { return mode === "live"; }, storageKey: key, setMode };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
