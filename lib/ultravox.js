const BASELINE_PROMPT = "Transcribe the audio. Output only the transcript.";
const API = "https://api.ultravox.ai/api";
const { friendlyMessage, logTechnical } = require("./messages");

class JobError extends Error {
  constructor(code, message, status = 422) {
    super(friendlyMessage(code));
    this.code = code;
    this.status = status;
    // Original details stay in sanitized service logs, not response messages.
    logTechnical(code, message);
  }
}

// Never pass provider error bodies, headers, socket URLs or exception strings to clients/logs.
function requireKey() {
  if (!process.env.ULTRAVOX_API_KEY) {
    throw new JobError("MISSING_KEY", "ULTRAVOX_API_KEY is missing. Add it in Replit Secrets.");
  }
}

async function providerRequest(route, { method = "GET", body, signal } = {}) {
  requireKey();
  let response;
  try {
    response = await fetch(`${API}${route}`, {
      method,
      headers: { "X-API-Key": process.env.ULTRAVOX_API_KEY, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]),
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.name === "TimeoutError") throw new JobError("TIMEOUT", "Ultravox's API request timed out after 12 seconds.", 504);
    throw new JobError("NETWORK_FAILURE", "Could not reach Ultravox within 12 seconds. Check the connection and retry manually.", 502);
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new JobError("INVALID_KEY", "Ultravox rejected the API key or its permissions. Check ULTRAVOX_API_KEY in Secrets.");
    if ([402, 429].includes(response.status)) throw new JobError("USAGE_LIMIT", "Ultravox usage, balance, concurrency or rate limit reached. Check your Ultravox account before trying again.", 429);
    if (response.status === 404) throw new JobError("MODEL_UNAVAILABLE", "The requested Ultravox model or endpoint is unavailable.");
    if (response.status >= 500) throw new JobError("NETWORK_FAILURE", "Ultravox is temporarily unavailable. No automatic retry was attempted.", 502);
    if ([400, 422].includes(response.status)) {
      // Classify only; never return or persist the provider's error text.
      const detail = (await response.text()).slice(0, 10000);
      if (/model/i.test(detail)) throw new JobError("MODEL_UNAVAILABLE", "Ultravox rejected the requested model. Select another available model.");
      if (/api.?key|unauthori[sz]ed/i.test(detail)) throw new JobError("INVALID_KEY", "Ultravox rejected the API key. Check ULTRAVOX_API_KEY in Secrets.");
    }
    throw new JobError("PROVIDER_REJECTED", "Ultravox rejected the call configuration. No automatic retry was attempted.", 422);
  }
  try {
    const text = await response.text();
    if (text.length > 2000000) throw new Error();
    return JSON.parse(text);
  } catch {
    throw new JobError("NETWORK_FAILURE", "Ultravox returned an unreadable response.", 502);
  }
}

let modelCache;
async function getModels(signal, force = false) {
  requireKey();
  if (!force && modelCache && Date.now() - modelCache.time < 300000) return modelCache.models;
  const models = [];
  let route = "/models?pageSize=100";
  for (let page = 0; route && page < 10; page++) {
    const data = await providerRequest(route, { signal });
    if (!Array.isArray(data.results)) throw new JobError("NETWORK_FAILURE", "Ultravox's model list could not be read.", 502);
    for (const model of data.results) {
      if (typeof model.name === "string" && !models.some(item => item.id === model.name)) models.push({ id: model.name });
    }
    route = null;
    if (data.next) {
      const next = new URL(data.next);
      if (next.origin !== "https://api.ultravox.ai" || next.pathname !== "/api/models") {
        throw new JobError("NETWORK_FAILURE", "Ultravox returned an invalid model-list page.", 502);
      }
      route = next.pathname.slice(4) + next.search;
    }
  }
  if (!models.length) throw new JobError("MODEL_UNAVAILABLE", "Ultravox reports no available models for this account.");
  modelCache = { time: Date.now(), models };
  return models;
}

function preferredModel(models) {
  return models.some(model => model.id === "ultravox-v0.6") ? "ultravox-v0.6" : models[0]?.id;
}

function callSettings(kind, model, seconds = 15, evaluatorPrompt, input) {
  const audio = kind === "baseline" || kind === "candidate";
  const settings = {
    systemPrompt: kind === "baseline" ? BASELINE_PROMPT : evaluatorPrompt,
    temperature: 0,
    model,
    initialOutputMedium: "MESSAGE_MEDIUM_TEXT",
    firstSpeakerSettings: audio ? { user: {} } : { agent: {} },
    recordingEnabled: false,
    inactivityMessages: [],
    selectedTools: [],
    joinTimeout: "10s",
    maxDuration: audio ? `${Math.ceil(seconds + 35)}s` : "65s",
    medium: { serverWebSocket: {
      inputSampleRate: 16000,
      outputSampleRate: 16000,
      clientBufferSizeMs: 60,
      dataMessages: { transcript: true, state: true, debug: false },
    } },
  };
  // Omitting vadSettings deliberately uses the provider's default VAD.
  if (kind === "evaluation") settings.initialMessages = [{ role: "MESSAGE_ROLE_USER", medium: "MESSAGE_MEDIUM_TEXT", text: input }];
  return settings;
}

class TranscriptAssembler {
  constructor() { this.parts = new Map(); }
  accept(message) {
    if (message.type !== "transcript" || !["agent", "user"].includes(message.role) || !Number.isInteger(message.ordinal)) return false;
    const key = `${message.role}:${message.ordinal}`;
    const part = this.parts.get(key) || { role: message.role, ordinal: message.ordinal, text: "", final: false };
    if (typeof message.text === "string") part.text = message.text;
    else if (typeof message.delta === "string") part.text += message.delta;
    if (typeof message.final === "boolean") part.final = message.final;
    this.parts.set(key, part);
    return true;
  }
  entries(role) {
    return [...this.parts.values()].filter(part => !role || part.role === role).sort((a, b) => a.ordinal - b.ordinal);
  }
  text(role) { return this.entries(role).map(part => part.text).join("\n"); }
  final() {
    const parts = this.entries("agent");
    return parts.length > 0 && parts.every(part => part.final) && this.text("agent").trim().length > 0;
  }
}

module.exports = { BASELINE_PROMPT, JobError, requireKey, providerRequest, getModels, preferredModel, callSettings, TranscriptAssembler };
