(() => {
  "use strict";

  const STORE_KEY = "speech-prompt-lab-experiment-v1";
  const routes = [
    { path: "/setup", title: "Set up an eval", index: "01" },
    { path: "/simulation", title: "Simulation", index: "02" },
    { path: "/scorecard", title: "Scorecard", index: "03" },
    { path: "/comparison", title: "Before & after", index: "04" }
  ];
  const content = document.getElementById("app-content");
  const breadcrumb = document.getElementById("breadcrumb-title");
  let samples = [];
  let samplesError = "";
  let route = "/setup";
  let waveformRequest = 0;
  let saveTimer = null;

  function readStored() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  const stored = readStored();
  const experiment = {
    selectedId: stored.selectedId || null,
    purpose: typeof stored.purpose === "string" ? stored.purpose : "",
    agentId: typeof stored.agentId === "string" ? stored.agentId : "",
    prompt: typeof stored.prompt === "string" ? stored.prompt : "",
    reference: typeof stored.reference === "string" ? stored.reference : "",
    startOffset: Number.isFinite(Number(stored.startOffset)) ? Math.max(0, Number(stored.startOffset)) : 0,
    excerptLength: ["15", "30", "60", "rest"].includes(String(stored.excerptLength)) ? String(stored.excerptLength) : "15"
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function saveExperiment() {
    const indicator = document.getElementById("save-state");
    if (indicator) indicator.innerHTML = '<span class="save-dot"></span>Saving…';
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(experiment));
        const current = document.getElementById("save-state");
        if (current) current.innerHTML = '<span class="save-dot"></span>Saved on this device';
      } catch {
        const current = document.getElementById("save-state");
        if (current) current.textContent = "Could not save in this browser";
      }
    }, 180);
  }

  function durationText(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "Duration unavailable";
    const whole = Math.round(value);
    const minutes = Math.floor(whole / 60);
    const remainder = whole % 60;
    return minutes ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${remainder}s`;
  }

  function validSamples(raw) {
    return Array.isArray(raw) ? raw.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [];
  }

  function getCurrentSample() {
    return samples.find(sample => String(sample.id) === String(experiment.selectedId)) || null;
  }

  function sampleCards() {
    const cards = samples.slice(0, 3).map((sample, index) => ({
      sample,
      id: String(sample.id ?? `sample-${index}`),
      title: sample.title || "Untitled demo sample",
      profile: sample.speech_profile || "Speech profile not specified",
      duration: durationText(sample.duration_seconds)
    }));
    while (cards.length < 3) {
      cards.push({ sample: null, id: `placeholder-${cards.length + 1}`, title: "Sample unavailable", profile: "No demo sample available", duration: "" });
    }
    return cards;
  }

  function audioPanel(sample) {
    if (!sample) return "";
    const audioUrl = typeof sample.audio_url === "string" ? sample.audio_url.trim() : "";
    if (!audioUrl) {
      return `<div class="selected-audio" aria-live="polite">
        <div class="audio-title"><strong class="section-title">Audio preview</strong><span class="audio-tag">NOT AVAILABLE</span></div>
        <div class="waveform"><div class="wave-empty">No audio file is available for this sample.</div></div>
      </div>`;
    }
    return `<div class="selected-audio" id="selected-audio">
      <div class="audio-title"><strong class="section-title">Audio preview</strong><span class="audio-tag">SOURCE AUDIO</span></div>
      <div class="waveform" id="waveform" role="img" aria-label="Waveform will appear after the source audio is decoded">
        <div class="wave-empty">Loading waveform from source audio…</div>
      </div>
      <audio id="sample-audio" controls preload="metadata" src="${escapeHtml(audioUrl)}">
        Your browser does not support audio playback.
      </audio>
      <div class="field-help">Preview of the selected sample audio.</div>
    </div>`;
  }

  function setupScreen() {
    const sample = getCurrentSample();
    const cards = sampleCards();
    const cardMarkup = cards.map(card => {
        const selected = String(experiment.selectedId) === card.id;
      const placeholder = !card.sample;
      const playDisabled = placeholder || !card.sample.audio_url;
      return `<div class="sample-card${selected ? " selected" : ""}">
        <button type="button" class="sample-select" data-sample-id="${escapeHtml(card.id)}" aria-pressed="${selected}">
          <span class="sample-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none"><path d="M3.5 8v4M7 5.5v9M10.5 3.5v13M14 6.5v7M17 8.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </span>
          <span class="sample-copy"><span class="sample-title">${escapeHtml(card.title)}</span><span class="sample-profile">${escapeHtml(card.profile)}</span></span>
        </button>
        <span class="sample-meta">${escapeHtml(card.duration)}${placeholder ? '<span class="sample-state">UNAVAILABLE</span>' : ""}</span>
        <button type="button" class="sample-play" data-play-sample="${escapeHtml(card.id)}"${playDisabled ? " disabled" : ""} aria-label="Play ${escapeHtml(card.title)} preview">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5 12 8l-7 4.5z" fill="currentColor"/></svg><span>Play</span>
        </button>
      </div>`;
    }).join("");
    const selectedDuration = sample ? Number(sample.duration_seconds) : 0;
    const start = Number(experiment.startOffset) || 0;
    const requested = experiment.excerptLength === "rest" ? Math.max(0, selectedDuration - start) : Number(experiment.excerptLength);
    const effective = selectedDuration > 0 ? Math.min(requested, Math.max(0, selectedDuration - start)) : requested;
    const excerptInfo = sample && selectedDuration > 0
      ? `Selected excerpt: ${durationText(effective)} · ends at ${durationText(Math.min(selectedDuration, start + requested))} of ${durationText(selectedDuration)}`
      : "Excerpt length will be clamped to the recording when its duration is available.";

    content.innerHTML = `<div class="page-heading">
      <div><div class="eyebrow">Evaluation workspace / 01</div><h1>Set up an eval</h1>
      <p class="page-intro">Choose a speech sample, describe the agent, and add evaluation context.</p></div>
      <div class="step-count">STEP 01 / 04</div>
    </div>
    <div class="layout-grid">
      <div class="stack">
        <section class="panel" aria-labelledby="samples-title">
          <div class="panel-header"><div><h2 class="section-title" id="samples-title">Choose a demo sample</h2><p class="section-subtitle">Select a demo recording to preview its audio.</p></div><span class="tiny-label">AUDIO INPUT</span></div>
          ${samplesError ? `<p class="load-state error" role="status">${escapeHtml(samplesError)}</p>` : ""}
          ${!samplesError && samples.length === 0 ? '<p class="load-state" role="status">No demo samples are available. You can still complete the setup.</p>' : ""}
          ${!samplesError && samples.length > 0 && samples.length < 3 ? `<p class="load-state" role="status">Showing ${samples.length} of 3 demo samples. Missing samples are clearly marked.</p>` : ""}
          <div class="sample-list" role="group" aria-label="Demo sample choices">${cardMarkup}</div>
          ${audioPanel(sample)}
        </section>
        <section class="panel" aria-labelledby="purpose-label">
          <div class="panel-header"><div><h2 class="section-title">Agent context</h2><p class="section-subtitle">The purpose is prefilled from the selected sample and remains editable.</p></div><span class="tiny-label">EXPERIMENT SETUP</span></div>
          <div class="field">
            <label for="purpose-input" id="purpose-label">What is this agent for?</label>
            <textarea class="purpose-input" id="purpose-input" placeholder="Select a sample to prefill its agent purpose…">${escapeHtml(experiment.purpose)}</textarea>
          </div>
          <div class="field" style="margin-top:16px">
            <span class="field-label">Use cases we'll test</span>
            <div class="usecases"><span class="usecase-mark" aria-hidden="true">i</span><span>Describe the requests this agent should handle in the purpose field above.</span></div>
          </div>
        </section>
        <section class="panel ref-panel" aria-labelledby="reference-title">
          <div class="panel-header"><div><h2 class="section-title" id="reference-title">Reference material</h2><p class="section-subtitle">Add context to inform your evaluation. Paste text below; file uploads and suggested references are unavailable.</p></div><span class="tiny-label">OPTIONAL</span></div>
          <div class="field"><label for="reference-input">Paste reference material</label><textarea id="reference-input" placeholder="Paste policies, terminology, or other relevant context…">${escapeHtml(experiment.reference)}</textarea></div>
          <div class="excerpt-row">
            <div class="field"><label for="start-offset">Start offset</label><input id="start-offset" type="number" inputmode="decimal" min="0" step="1" value="${escapeHtml(start)}" aria-describedby="offset-help excerpt-feedback"><span class="field-help" id="offset-help">Seconds from the beginning · default 0</span></div>
            <div class="field duration-select"><label for="excerpt-length">Excerpt length</label><select id="excerpt-length">
              <option value="15"${experiment.excerptLength === "15" ? " selected" : ""}>15 seconds</option>
              <option value="30"${experiment.excerptLength === "30" ? " selected" : ""}>30 seconds</option>
              <option value="60"${experiment.excerptLength === "60" ? " selected" : ""}>60 seconds</option>
              <option value="rest"${experiment.excerptLength === "rest" ? " selected" : ""}>Rest of recording</option>
            </select><span class="field-help">${escapeHtml(excerptInfo)}</span></div>
          </div>
          <p class="inline-feedback" id="excerpt-feedback" aria-live="polite"></p>
        </section>
      </div>
      <div class="stack right-column">
        <section class="panel" aria-labelledby="agent-tabs-title">
          <div class="panel-header"><div><h2 class="section-title" id="agent-tabs-title">Agent setup</h2><p class="section-subtitle">Choose how the agent context is provided.</p></div></div>
          <div class="tab-list" role="tablist" aria-label="Agent setup method">
            <button class="tab-button" id="tab-connect" role="tab" aria-selected="true" aria-controls="panel-connect" type="button">Connect agent</button>
            <button class="tab-button" id="tab-prompt" role="tab" aria-selected="false" aria-controls="panel-prompt" type="button">Paste system prompt</button>
            <button class="tab-button" id="tab-upload" role="tab" aria-selected="false" aria-controls="panel-upload" type="button">Upload call audio</button>
          </div>
          <div class="tab-panel" id="panel-connect" role="tabpanel" aria-labelledby="tab-connect">
            <div class="connect-row"><div class="field"><label for="agent-id">Agent ID</label><input id="agent-id" type="text" value="${escapeHtml(experiment.agentId)}" placeholder="Enter an agent ID"></div><button class="button secondary" id="connect-button" type="button">Unavailable</button></div>
            <p class="inline-feedback" id="connect-feedback" aria-live="polite"></p>
          </div>
          <div class="tab-panel" id="panel-prompt" role="tabpanel" aria-labelledby="tab-prompt" hidden>
            <div class="field"><label for="prompt-input">System prompt</label><textarea id="prompt-input" placeholder="Paste the agent's system prompt…">${escapeHtml(experiment.prompt)}</textarea></div>
          </div>
          <div class="tab-panel" id="panel-upload" role="tabpanel" aria-labelledby="tab-upload" hidden>
            <div class="usecases"><span class="usecase-mark" aria-hidden="true">i</span><span>Call audio upload is unavailable. You can preview an available demo sample instead.</span></div>
          </div>
        </section>
        <section class="panel" aria-labelledby="save-heading">
          <div class="panel-header"><div><h2 class="section-title" id="save-heading">Experiment setup</h2><p class="section-subtitle">Your selections stay in this browser.</p></div></div>
          <div class="save-state" id="save-state"><span class="save-dot"></span>Saved on this device</div>
          <div class="footer-line">No provider calls are made from this workspace.</div>
        </section>
      </div>
    </div>`;
    bindSetup();
    if (sample && sample.audio_url) loadWaveform(sample);
  }

  function unavailableScreen(path) {
    const page = routes.find(item => item.path === path);
    const copy = {
      "/simulation": {
        title: "Simulation unavailable",
        intro: "No agent conversation has been run for this experiment.",
        detail: "Simulation results are not available."
      },
      "/scorecard": {
        title: "No scorecard yet",
        intro: "No measured or reviewed results are available for this experiment.",
        detail: "Scores, findings, and prompt fixes are unavailable because no evaluation results exist."
      },
      "/comparison": {
        title: "Comparison unavailable",
        intro: "A before-and-after comparison requires baseline and revised evaluation results.",
        detail: "There are no saved results to compare."
      }
    }[path];
    content.innerHTML = `<div class="page-heading">
      <div><div class="eyebrow">Evaluation workspace / ${page.index}</div><h1>${escapeHtml(page.title)}</h1>
      <p class="page-intro">${escapeHtml(copy.intro)}</p></div><div class="step-count">STEP ${page.index} / 04</div>
    </div>
    <section class="screen-placeholder" aria-labelledby="unavailable-title">
      <span class="status-kicker">Current status</span>
      <h2 id="unavailable-title">${escapeHtml(copy.title)}</h2>
      <p>${escapeHtml(copy.intro)}</p>
      <div class="unavailable-box"><strong>Results unavailable</strong><p>${escapeHtml(copy.detail)}</p></div>
      <div class="placeholder-actions">
        <a class="button" href="#/setup">Return to setup</a>
        ${path !== "/simulation" ? '<a class="button secondary" href="#/simulation">View simulation status</a>' : ""}
      </div>
      <div class="footer-line">No agent or speech provider is contacted.</div>
    </section>`;
  }

  function render() {
    route = location.hash.startsWith("#/") ? location.hash.slice(1) : "/setup";
    if (!routes.some(item => item.path === route)) route = "/setup";
    const page = routes.find(item => item.path === route);
    breadcrumb.textContent = page.title;
    document.querySelectorAll(".nav-link").forEach(link => {
      const active = link.dataset.route === route;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    if (route === "/setup") setupScreen();
    else unavailableScreen(route);
  }

  function bindSetup() {
    function selectSample(id) {
      const selected = samples.find(sample => String(sample.id) === id);
      experiment.selectedId = selected ? selected.id : id;
      experiment.purpose = selected && typeof selected.agent_purpose === "string" ? selected.agent_purpose : "";
      const recordingLength = Number(selected?.duration_seconds) || 0;
      if (recordingLength > 0 && experiment.startOffset > recordingLength) {
        experiment.startOffset = recordingLength;
      }
      saveExperiment();
      setupScreen();
    }

    document.querySelectorAll(".sample-select").forEach(card => {
      card.addEventListener("click", () => {
        selectSample(card.dataset.sampleId);
      });
    });
    document.querySelectorAll(".sample-play").forEach(button => {
      button.addEventListener("click", () => {
        if (button.disabled) return;
        const id = button.dataset.playSample;
        const selected = samples.find(sample => String(sample.id) === id);
        if (!selected?.audio_url) return;
        if (String(experiment.selectedId) !== id) selectSample(id);
        const player = document.getElementById("sample-audio");
        if (player) {
          player.play().catch(() => {
            const feedback = document.querySelector(".selected-audio .field-help");
            if (feedback) feedback.textContent = "Playback could not start. Use the audio controls to try again.";
          });
        }
      });
    });

    const purpose = document.getElementById("purpose-input");
    const prompt = document.getElementById("prompt-input");
    const reference = document.getElementById("reference-input");
    const agentId = document.getElementById("agent-id");
    purpose.addEventListener("input", () => { experiment.purpose = purpose.value; saveExperiment(); });
    prompt.addEventListener("input", () => { experiment.prompt = prompt.value; saveExperiment(); });
    reference.addEventListener("input", () => { experiment.reference = reference.value; saveExperiment(); });
    agentId.addEventListener("input", () => { experiment.agentId = agentId.value; saveExperiment(); });

    document.querySelectorAll(".tab-button").forEach(tab => tab.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach(other => {
        const selected = other === tab;
        other.setAttribute("aria-selected", String(selected));
        other.tabIndex = selected ? 0 : -1;
      });
      document.querySelectorAll(".tab-panel").forEach(panel => { panel.hidden = panel.id !== tab.getAttribute("aria-controls"); });
    }));
    document.getElementById("connect-button").addEventListener("click", () => {
      document.getElementById("connect-feedback").textContent = "Live agent connection is unavailable.";
    });

    const offsetInput = document.getElementById("start-offset");
    const lengthSelect = document.getElementById("excerpt-length");
    const feedback = document.getElementById("excerpt-feedback");
    const duration = Number(getCurrentSample()?.duration_seconds) || 0;
    offsetInput.addEventListener("input", () => {
      const raw = offsetInput.value.trim();
      if (raw === "" || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
        feedback.textContent = "Enter a start offset of zero seconds or more.";
        offsetInput.setAttribute("aria-invalid", "true");
        return;
      }
      let value = Number(raw);
      if (duration > 0 && value > duration) {
        value = duration;
        offsetInput.value = String(value);
        feedback.textContent = `Start offset clamped to the recording end (${durationText(duration)}).`;
      } else {
        feedback.textContent = "";
      }
      offsetInput.removeAttribute("aria-invalid");
      experiment.startOffset = value;
      saveExperiment();
    });
    offsetInput.addEventListener("blur", () => {
      if (offsetInput.value.trim() === "" || Number(offsetInput.value) < 0 || !Number.isFinite(Number(offsetInput.value))) {
        offsetInput.value = String(experiment.startOffset);
        offsetInput.removeAttribute("aria-invalid");
        feedback.textContent = "Start offset restored to the last valid value.";
      }
    });
    lengthSelect.addEventListener("change", () => {
      experiment.excerptLength = lengthSelect.value;
      saveExperiment();
      setupScreen();
    });
  }

  async function loadWaveform(sample) {
    const requestId = ++waveformRequest;
    const panel = document.getElementById("waveform");
    if (!panel || !sample.audio_url) return;
    try {
      const response = await fetch(sample.audio_url);
      if (!response.ok) throw new Error("Audio could not be loaded.");
      const bytes = await response.arrayBuffer();
      if (requestId !== waveformRequest) return;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Audio decoding is not supported in this browser.");
      const context = new AudioContextClass();
      let decoded;
      try {
        decoded = await context.decodeAudioData(bytes);
      } finally {
        await context.close();
      }
      if (requestId !== waveformRequest) return;
      const channel = decoded.getChannelData(0);
      const count = 96;
      const width = 640;
      const step = Math.max(1, Math.floor(channel.length / count));
      const bars = [];
      for (let index = 0; index < count; index += 1) {
        let peak = 0;
        const start = index * step;
        const end = Math.min(channel.length, start + step);
        for (let offset = start; offset < end; offset += 1) peak = Math.max(peak, Math.abs(channel[offset]));
        const height = Math.max(2, peak * 34);
        bars.push(`<rect x="${(index * width / count).toFixed(2)}" y="${((44 - height) / 2).toFixed(2)}" width="3.5" height="${height.toFixed(2)}" rx="1.75" fill="#b92f27"/>`);
      }
      const current = document.getElementById("waveform");
      if (current) {
        current.innerHTML = `<svg viewBox="0 0 ${width} 44" preserveAspectRatio="none" aria-hidden="true">${bars.join("")}</svg>`;
        current.setAttribute("aria-label", `Waveform derived from source audio, ${durationText(decoded.duration)} long`);
      }
    } catch {
      const current = document.getElementById("waveform");
      if (current && requestId === waveformRequest) {
        current.innerHTML = '<div class="wave-empty">Waveform unavailable. Source audio playback may still work.</div>';
        current.setAttribute("aria-label", "Waveform unavailable for this source audio");
      }
    }
  }

  window.addEventListener("hashchange", render);
  render();

  fetch("/api/demo-samples")
    .then(response => {
      if (!response.ok) throw new Error("Demo samples could not be loaded. Showing sample placeholders.");
      return response.json();
    })
    .then(data => {
      samples = validSamples(data).slice(0, 3);
      if (experiment.selectedId != null) {
        const found = samples.find(sample => String(sample.id) === String(experiment.selectedId));
        if (found) experiment.selectedId = found.id;
        else experiment.selectedId = null;
      }
      if (typeof stored.purpose !== "string" && experiment.selectedId != null) {
        const sample = getCurrentSample();
        if (sample) experiment.purpose = sample.agent_purpose || "";
      }
      const restoredSample = getCurrentSample();
      const restoredDuration = Number(restoredSample?.duration_seconds) || 0;
      if (restoredDuration > 0 && experiment.startOffset > restoredDuration) {
        experiment.startOffset = restoredDuration;
      }
      render();
    })
    .catch(error => {
      samples = [];
      samplesError = error.message || "Demo samples could not be loaded. Showing sample placeholders.";
      experiment.selectedId = null;
      render();
    });
})();
