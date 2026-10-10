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
  let samplesLoading = true;
  let route = "/setup";
  let activeAgentTab = "connect";
  let waveformRequest = 0;
  let saveTimer = null;
  let samplesLoaded = false;
  const editedBeforeSamplesLoad = new Set();
  let unsubscribeEvaluationLock = null;
  const originalSetupDisabled = new WeakMap();
  const originalAudioControls = new WeakMap();

  function applySetupEvaluationLock(lock = {}) {
    const locked = Boolean(typeof lock === "boolean" ? lock : lock.locked);
    const controls = document.querySelectorAll("#use-case-select, #agent-name-input, #purpose-input, #speech-tags-input, #agent-id, #prompt-input, #reference-input, #start-offset, #excerpt-length, #connect-button, .sample-select, .sample-play");
    controls.forEach(control => {
      if (!originalSetupDisabled.has(control)) originalSetupDisabled.set(control, control.disabled);
      control.disabled = locked || originalSetupDisabled.get(control);
    });
    const audio = document.getElementById("sample-audio");
    if (audio) {
      if (!originalAudioControls.has(audio)) originalAudioControls.set(audio, audio.controls);
      audio.controls = locked ? false : originalAudioControls.get(audio);
    }
    const note = document.getElementById("evaluation-lock-note");
    if (!note) return;
    note.hidden = !locked;
    note.textContent = "Editing is paused while an evaluation is running.";
  }

  function subscribeSetupEvaluationLock() {
    if (unsubscribeEvaluationLock) unsubscribeEvaluationLock();
    if (window.CadenceSimulation?.onEvaluationLockChange) {
      unsubscribeEvaluationLock = window.CadenceSimulation.onEvaluationLockChange(applySetupEvaluationLock);
    } else {
      unsubscribeEvaluationLock = null;
      applySetupEvaluationLock(false);
    }
  }

  function readStored() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  const stored = readStored();
  const experiment = {
    selectedId: stored.selectedId ?? null,
    useCaseId: stored.useCaseId ?? stored.selectedId ?? null,
    model: typeof stored.model === "string" ? stored.model : "",
    agentName: typeof stored.agentName === "string" ? stored.agentName : "",
    speechProfileTags: Array.isArray(stored.speechProfileTags)
      ? stored.speechProfileTags.filter(tag => typeof tag === "string")
      : [],
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
    const warning = document.getElementById("save-error");
    if (indicator) indicator.innerHTML = '<span class="save-dot"></span>Saving…';
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(experiment));
        if (warning) warning.hidden = true;
        const current = document.getElementById("save-state");
        if (current) current.innerHTML = '<span class="save-dot"></span>Saved on this device';
        } catch {
        const current = document.getElementById("save-state");
          if (current) current.textContent = "We couldn’t save your changes. Please try again.";
        if (warning) warning.hidden = false;
      }
    }, 180);
  }

  function durationText(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "Duration not available";
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

  function sampleDefaults(sample) {
    const providedTags = Array.isArray(sample?.speech_profile_tags)
      ? sample.speech_profile_tags.filter(tag => typeof tag === "string").map(tag => tag.trim()).filter(Boolean)
      : [];
    const profileTags = providedTags.length
      ? providedTags
      : String(sample?.speech_profile || "").split(" · ").map(tag => tag.trim()).filter(Boolean);
    return {
      agentName: String(sample?.agent_name || sample?.title || ""),
      purpose: typeof sample?.agent_purpose === "string" ? sample.agent_purpose : "",
      speechProfileTags: profileTags,
      prompt: typeof sample?.system_prompt === "string" ? sample.system_prompt : "",
      reference: typeof sample?.reference_material === "string" ? sample.reference_material : ""
    };
  }

  function autoFieldsDiffer(defaults) {
    const tagsDiffer = experiment.speechProfileTags.length !== defaults.speechProfileTags.length ||
      experiment.speechProfileTags.some((tag, index) => tag !== defaults.speechProfileTags[index]);
    return experiment.agentName !== defaults.agentName ||
      experiment.purpose !== defaults.purpose ||
      tagsDiffer ||
      experiment.prompt !== defaults.prompt ||
      experiment.reference !== defaults.reference;
  }

  function applySampleDefaults(sample) {
    const defaults = sampleDefaults(sample);
    experiment.agentName = defaults.agentName;
    experiment.purpose = defaults.purpose;
    experiment.speechProfileTags = defaults.speechProfileTags.slice();
    experiment.prompt = defaults.prompt;
    experiment.reference = defaults.reference;
  }

  function sampleCards() {
    const cards = samples.slice(0, 3).map((sample, index) => {
      const profileTags = Array.isArray(sample.speech_profile_tags)
        ? sample.speech_profile_tags.filter(tag => typeof tag === "string" && tag.trim()).map(tag => tag.trim())
        : [];
      const fallbackTags = String(sample.speech_profile || "Speech profile not provided")
        .split(" · ")
        .filter(Boolean);
      return {
        sample,
        id: String(sample.id ?? `sample-${index}`),
        agentName: sample.agent_name || sample.title || "Recording unavailable",
        title: sample.title || "Recording unavailable",
        profileTags: profileTags.length ? profileTags : fallbackTags,
        duration: durationText(sample.duration_seconds)
      };
    });
    while (cards.length < 3) {
      cards.push({ sample: null, id: `placeholder-${cards.length + 1}`, agentName: "Recording unavailable", title: "Recording unavailable", profileTags: [], duration: "" });
    }
    return cards;
  }

  function audioPanel(sample) {
    if (!sample) return "";
    const audioUrl = typeof sample.audio_url === "string" ? sample.audio_url.trim() : "";
    if (!audioUrl) {
      return `<div class="selected-audio" aria-live="polite">
        <div class="audio-title"><strong class="section-title">Recording preview</strong><span class="audio-tag">NOT AVAILABLE</span></div>
        <div class="waveform"><div class="wave-empty">Preview isn’t available for this recording.</div></div>
      </div>`;
    }
    return `<div class="selected-audio" id="selected-audio">
      <div class="audio-title"><strong class="section-title">Recording preview</strong><span class="audio-tag">RECORDING</span></div>
      <div class="waveform" id="waveform" role="img" aria-label="Recording preview">
        <div class="wave-empty">Preparing recording preview…</div>
      </div>
      <audio id="sample-audio" controls preload="metadata" src="${escapeHtml(audioUrl)}">
        Audio playback isn’t available in this browser.
      </audio>
      <div class="field-help">Preview the selected recording.</div>
    </div>`;
  }

  function setupScreen() {
    const sample = getCurrentSample();
    const cards = sampleCards();
    const cardMarkup = cards.map(card => {
      const selected = String(experiment.selectedId) === card.id;
      const placeholder = !card.sample;
      const playDisabled = placeholder || !card.sample.audio_url;
      const profileTags = card.profileTags.map(tag => `<span class="profile-tag">${escapeHtml(tag)}</span>`).join("");
      return `<div class="sample-card${selected ? " selected" : ""}">
        <button type="button" class="sample-select" data-sample-id="${escapeHtml(card.id)}" aria-pressed="${selected}"${placeholder ? " disabled" : ""}>
          <span class="sample-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none"><path d="M3.5 8v4M7 5.5v9M10.5 3.5v13M14 6.5v7M17 8.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </span>
          <span class="sample-copy">
            <span class="sample-title">${escapeHtml(card.agentName)}</span>
            ${placeholder ? "" : `<span class="sample-profile">${escapeHtml(card.title)}</span>`}
            ${profileTags.length ? `<span class="profile-tags" aria-label="Speech profile tags">${profileTags}</span>` : ""}
          </span>
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
      : "Excerpt length will adjust to fit the recording.";
    const useCaseSummary = sample?.use_case_summary || "Choose a use case to personalize the agent context.";
    const useCaseOptions = samples.slice(0, 3).map(item =>
      `<option value="${escapeHtml(item.id)}"${String(item.id) === String(experiment.useCaseId) ? " selected" : ""}>${escapeHtml(item.use_case_label || item.title || item.agent_name || "Use case")}</option>`
    ).join("");

    content.innerHTML = `<div class="page-heading">
      <div><div class="eyebrow">Evaluation workspace / 01</div><h1>Set up an eval</h1>
      <p class="page-intro">Start with the agent’s purpose, then choose a recording to evaluate.</p></div>
      <div class="step-count">STEP 01 / 04</div>
    </div>
    <section class="panel setup-context-panel" aria-labelledby="step-one-title">
      <div class="panel-header"><div><h2 class="section-title" id="step-one-title">Step 1 · Agent and context</h2><p class="section-subtitle">Choose a use case to set a starting point. Every field remains editable.</p></div><span class="tiny-label">AGENT SETUP</span></div>
      <div class="usecase-select-row">
        <div class="field"><label for="use-case-select">What do you want your agent to do?</label><select id="use-case-select" aria-describedby="use-case-summary">
          <option value=""${sample ? "" : " selected"}>Select a use case…</option>${useCaseOptions}
        </select><p class="usecase-summary" id="use-case-summary" aria-live="polite">${escapeHtml(useCaseSummary)}</p></div>
      </div>
      <p class="evaluation-lock-note" id="evaluation-lock-note" role="status" aria-live="polite" hidden></p>
      <p class="load-state error" id="save-error" role="alert" hidden>We couldn’t save your changes. Please try again. <button type="button" class="button secondary small" id="retry-save">Try again</button></p>
      <div class="context-fields">
        <div class="field"><label for="agent-name-input">Agent name</label><input type="text" id="agent-name-input" value="${escapeHtml(experiment.agentName)}" placeholder="Name this agent"></div>
        <div class="field"><label for="purpose-input">What is this agent for?</label><textarea class="purpose-input" id="purpose-input" placeholder="Describe the agent’s purpose…">${escapeHtml(experiment.purpose)}</textarea></div>
        <div class="field"><label for="speech-tags-input">Speech profile tags <span class="field-help">One tag per line</span></label><textarea class="tag-input" id="speech-tags-input" placeholder="For example: adolescent speech&#10;fast pace">${escapeHtml(experiment.speechProfileTags.join("\n"))}</textarea></div>
      </div>
      <section class="agent-method" aria-labelledby="agent-tabs-title">
        <div class="panel-header"><div><h3 class="section-title" id="agent-tabs-title">Agent setup</h3><p class="section-subtitle">Choose how the agent context is provided.</p></div></div>
        <div class="tab-list" role="tablist" aria-label="Agent setup method">
          <button class="tab-button" id="tab-connect" role="tab" aria-selected="${activeAgentTab === "connect"}" tabindex="${activeAgentTab === "connect" ? 0 : -1}" aria-controls="panel-connect" type="button">Agent connection</button>
          <button class="tab-button" id="tab-prompt" role="tab" aria-selected="${activeAgentTab === "prompt"}" tabindex="${activeAgentTab === "prompt" ? 0 : -1}" aria-controls="panel-prompt" type="button">Paste system prompt</button>
        </div>
        <div class="tab-panel" id="panel-connect" role="tabpanel" aria-labelledby="tab-connect"${activeAgentTab === "connect" ? "" : " hidden"}>
          <div class="connect-row"><div class="field"><label for="agent-id">Agent ID</label><input id="agent-id" type="text" value="${escapeHtml(experiment.agentId)}" placeholder="Enter an agent ID"></div><button class="button secondary" id="connect-button" type="button" disabled>Agent connection isn’t available yet.</button></div>
          <p class="inline-feedback" id="connect-feedback" aria-live="polite"></p>
        </div>
        <div class="tab-panel" id="panel-prompt" role="tabpanel" aria-labelledby="tab-prompt"${activeAgentTab === "prompt" ? "" : " hidden"}>
          <div class="field"><label for="prompt-input">System prompt</label><textarea id="prompt-input" placeholder="Paste the agent's system prompt…">${escapeHtml(experiment.prompt)}</textarea></div>
        </div>
      </section>
    </section>
    <div class="layout-grid">
      <div class="stack">
          <section class="panel" aria-labelledby="samples-title">
          <div class="panel-header"><div><h2 class="section-title" id="samples-title">Step 2 · Choose a recording</h2><p class="section-subtitle">Selected automatically for this use case. You can choose a different recording.</p></div><span class="tiny-label">RECORDINGS</span></div>
          ${samplesLoading ? '<p class="load-state" role="status" aria-busy="true">Loading recordings…</p>' : ""}
          ${samplesError ? `<p class="load-state error" role="alert">${escapeHtml(samplesError)} <button type="button" class="button secondary small" id="retry-samples">Try again</button></p>` : ""}
          ${!samplesLoading && !samplesError && samples.length === 0 ? '<p class="load-state" role="status">No recordings are available.</p>' : ""}
          ${!samplesLoading && !samplesError && samples.length > 0 && samples.length < 3 ? `<p class="load-state" role="status">Showing ${samples.length} recordings.</p>` : ""}
          <div class="sample-list" role="group" aria-label="Recording choices">${cardMarkup}</div>
          ${audioPanel(sample)}
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
        <section class="panel ref-panel" aria-labelledby="reference-title">
          <div class="panel-header"><div><h2 class="section-title" id="reference-title">Reference material</h2><p class="section-subtitle">Optional context to inform the evaluation, such as policies, terminology or product details.</p></div><span class="tiny-label">OPTIONAL</span></div>
          <div class="field"><label for="reference-input">Paste reference material</label><textarea id="reference-input" placeholder="Paste policies, terminology, or other relevant context…">${escapeHtml(experiment.reference)}</textarea></div>
        </section>
      </div>
    </div>`;
    bindSetup();
    subscribeSetupEvaluationLock();
    if (sample && sample.audio_url) loadWaveform(sample);
  }

  async function loadSamples() {
    samplesLoading = true;
    samplesError = "";
    if (location.hash === "#/setup") setupScreen();
    try {
      const response = await fetch("/api/demo-samples");
      if (!response.ok) throw new Error();
      const data = await response.json();
      samples = validSamples(data).slice(0, 3);
      const hasStoredField = name => Object.prototype.hasOwnProperty.call(stored, name);
      const requestedId = stored.useCaseId ?? stored.selectedId;
      const restoredSample = samples.find(sample => String(sample.id) === String(requestedId)) ||
        samples.find(sample => String(sample.id) === String(stored.selectedId)) || null;
      if (restoredSample) {
        experiment.selectedId = restoredSample.id;
        experiment.useCaseId = restoredSample.id;
        const defaults = sampleDefaults(restoredSample);
        if (!hasStoredField("agentName") && !editedBeforeSamplesLoad.has("agentName")) experiment.agentName = defaults.agentName;
        if (!hasStoredField("purpose") && !editedBeforeSamplesLoad.has("purpose")) experiment.purpose = defaults.purpose;
        if (!hasStoredField("speechProfileTags") && !editedBeforeSamplesLoad.has("speechProfileTags")) experiment.speechProfileTags = defaults.speechProfileTags.slice();
        if (!hasStoredField("prompt") && !editedBeforeSamplesLoad.has("prompt")) experiment.prompt = defaults.prompt;
        if (!hasStoredField("reference") && !editedBeforeSamplesLoad.has("reference")) experiment.reference = defaults.reference;
      } else {
        experiment.selectedId = null;
        experiment.useCaseId = null;
      }
      samplesLoaded = true;
      const selectedSample = getCurrentSample();
      const restoredDuration = Number(selectedSample?.duration_seconds) || 0;
      if (restoredDuration > 0 && experiment.startOffset > restoredDuration) {
        experiment.startOffset = restoredDuration;
      }
    } catch {
      samples = [];
      samplesLoaded = true;
      samplesError = "Sample recordings couldn’t be loaded. Try refreshing the page.";
      experiment.selectedId = null;
    } finally {
      samplesLoading = false;
      render();
    }
  }

  function unavailableScreen(path) {
    const page = routes.find(item => item.path === path);
    if (path === "/comparison") {
      content.innerHTML = `<section class="compare-empty"><p>Compare transcripts before and after a prompt change. Run a baseline and a revised prompt to see the differences here.</p><a class="button" href="#/simulation">Go to Simulation</a></section>`;
      return;
    }
    const copy = {
      "/simulation": {
        title: "Start with a transcript",
        intro: "Run a baseline transcript to get started.",
        action: "Go to Simulation"
      },
      "/scorecard": {
        title: "Your review will appear here",
        intro: "Click Evaluate your voice agent to see what to improve in your prompt.",
        action: "Go to Simulation"
      },
      "/comparison": { title: "Before & after", intro: "", action: "Go to Simulation" }
    }[path];
    content.innerHTML = `<div class="page-heading">
      <div><div class="eyebrow">Evaluation workspace / ${page.index}</div><h1>${escapeHtml(page.title)}</h1>
      <p class="page-intro">${escapeHtml(copy.intro)}</p></div><div class="step-count">STEP ${page.index} / 04</div>
    </div>
    <section class="screen-placeholder" aria-labelledby="unavailable-title">
      <h2 id="unavailable-title">${escapeHtml(copy.title)}</h2>
      <p>${escapeHtml(copy.intro)}</p>
      <div class="placeholder-actions">
        <a class="button" href="#/simulation">${escapeHtml(copy.action)}</a>
        <a class="button secondary" href="#/setup">Set up your agent</a>
      </div>
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
    if (route !== "/setup" && unsubscribeEvaluationLock) {
      unsubscribeEvaluationLock();
      unsubscribeEvaluationLock = null;
    }
    if (route === "/setup") {
      if (window.CadenceSimulation) {
        window.CadenceSimulation.init({ content, experiment, samples, escapeHtml, saveExperiment }, { loadModels: false });
      }
      setupScreen();
    } else if (route === "/simulation" || route === "/scorecard") {
      if (window.CadenceSimulation) {
        const simulationContext = {
          content, experiment, samples, escapeHtml, saveExperiment,
          onUseSuggestedPrompt(promptText) {
            experiment.prompt = promptText;
            activeAgentTab = "prompt";
            saveExperiment();
            location.hash = "#/setup";
            setupScreen();
            const promptInput = document.getElementById("prompt-input");
            if (promptInput) promptInput.focus();
          }
        };
        window.CadenceSimulation.init(simulationContext, { loadModels: route === "/simulation" });
        window.CadenceSimulation.render(simulationContext);
      } else unavailableScreen(route);
    } else if (route === "/comparison" && window.CadenceComparison) {
      const comparisonContext = { content, experiment, samples, escapeHtml, saveExperiment };
      window.CadenceSimulation?.init(comparisonContext, { loadModels: false });
      window.CadenceComparison.render(comparisonContext);
    } else unavailableScreen(route);
  }

  function bindSetup() {
    document.getElementById("retry-samples")?.addEventListener("click", loadSamples);
    document.getElementById("retry-save")?.addEventListener("click", saveExperiment);
    function selectSample(id) {
      const selected = samples.find(sample => String(sample.id) === id);
      if (!selected) return false;
      const currentSample = getCurrentSample();
      if (currentSample && String(currentSample.id) === String(selected.id)) return true;
      const hasEdits = autoFieldsDiffer(sampleDefaults(currentSample));
      if (hasEdits) {
        const nextName = selected.use_case_label || selected.agent_name || selected.title || "this use case";
        if (!window.confirm(`Replace your current agent details with ${nextName}?`)) {
          return false;
        }
      }
      experiment.selectedId = selected.id;
      experiment.useCaseId = selected.id;
      applySampleDefaults(selected);
      activeAgentTab = "prompt";
      const recordingLength = Number(selected?.duration_seconds) || 0;
      if (recordingLength > 0 && experiment.startOffset > recordingLength) {
        experiment.startOffset = recordingLength;
      }
      saveExperiment();
      setupScreen();
      return true;
    }

    const useCaseSelect = document.getElementById("use-case-select");
    useCaseSelect.addEventListener("change", () => {
      const id = useCaseSelect.value;
      if (!id) {
        useCaseSelect.value = experiment.useCaseId == null ? "" : String(experiment.useCaseId);
        return;
      }
      if (!selectSample(id)) useCaseSelect.value = experiment.useCaseId == null ? "" : String(experiment.useCaseId);
    });

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
        if (String(experiment.selectedId) !== id && !selectSample(id)) return;
        const player = document.getElementById("sample-audio");
        if (player) {
          player.play().catch(() => {
            const feedback = document.querySelector(".selected-audio .field-help");
            if (feedback) feedback.textContent = "Playback didn’t start. Try the recording controls.";
          });
        }
      });
    });

    const agentName = document.getElementById("agent-name-input");
    const tags = document.getElementById("speech-tags-input");
    const purpose = document.getElementById("purpose-input");
    const prompt = document.getElementById("prompt-input");
    const reference = document.getElementById("reference-input");
    const agentId = document.getElementById("agent-id");
    agentName.addEventListener("input", () => {
      experiment.agentName = agentName.value;
      if (!samplesLoaded) editedBeforeSamplesLoad.add("agentName");
      saveExperiment();
    });
    purpose.addEventListener("input", () => {
      experiment.purpose = purpose.value;
      if (!samplesLoaded) editedBeforeSamplesLoad.add("purpose");
      saveExperiment();
    });
    tags.addEventListener("input", () => {
      experiment.speechProfileTags = tags.value.split(/\r?\n/).map(tag => tag.trim()).filter(Boolean);
      if (!samplesLoaded) editedBeforeSamplesLoad.add("speechProfileTags");
      saveExperiment();
    });
    prompt.addEventListener("input", () => {
      experiment.prompt = prompt.value;
      if (!samplesLoaded) editedBeforeSamplesLoad.add("prompt");
      saveExperiment();
    });
    reference.addEventListener("input", () => {
      experiment.reference = reference.value;
      if (!samplesLoaded) editedBeforeSamplesLoad.add("reference");
      saveExperiment();
    });
    agentId.addEventListener("input", () => { experiment.agentId = agentId.value; saveExperiment(); });
    document.getElementById("reset-sample-defaults")?.addEventListener("click", () => {
      const selected = getCurrentSample();
      if (!selected || !autoFieldsDiffer(sampleDefaults(selected))) return;
      if (!window.confirm("Restore the selected use case’s starting details?")) return;
      applySampleDefaults(selected);
      activeAgentTab = "prompt";
      saveExperiment();
      setupScreen();
    });

    document.querySelectorAll(".tab-button").forEach(tab => tab.addEventListener("click", () => {
      activeAgentTab = tab.id.replace("tab-", "");
      document.querySelectorAll(".tab-button").forEach(other => {
        const selected = other === tab;
        other.setAttribute("aria-selected", String(selected));
        other.tabIndex = selected ? 0 : -1;
      });
      document.querySelectorAll(".tab-panel").forEach(panel => { panel.hidden = panel.id !== tab.getAttribute("aria-controls"); });
    }));
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
        feedback.textContent = `Start offset shortened to fit the recording (${durationText(duration)}).`;
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
        current.setAttribute("aria-label", `Recording preview, ${durationText(decoded.duration)} long`);
      }
    } catch {
      const current = document.getElementById("waveform");
      if (current && requestId === waveformRequest) {
        current.innerHTML = '<div class="wave-empty">Recording preview isn’t available.</div>';
        current.setAttribute("aria-label", "Recording preview unavailable");
      }
    }
  }

  window.addEventListener("hashchange", render);
  render();
  loadSamples();
})();
