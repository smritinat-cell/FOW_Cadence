const { JobError } = require("./ultravox");

function pilotKey(env = process.env) {
  return env.CADENCE_LIVE_ULTRAVOX_API_KEY || env.ULTRAVOX_API_KEY || "";
}

function createLiveProvider({ key = () => pilotKey(), request = fetch } = {}) {
  let cached;
  function requireKey() { if (!key()) throw new JobError("MISSING_KEY", "The isolated live pilot key is missing.", 503); }
  async function providerRequest(route, { method = "GET", body, signal } = {}) {
    requireKey();
    let response;
    try {
      response = await request(`https://api.ultravox.ai/api${route}`, {
        method, headers: { "X-API-Key": key(), "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12000)]), redirect: "error"
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new JobError(error.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_FAILURE", "Live provider connection failed.", 502);
    }
    if (!response.ok) {
      const code = [401,403].includes(response.status) ? "INVALID_KEY" : [402,429].includes(response.status) ? "USAGE_LIMIT" : response.status === 404 ? "MODEL_UNAVAILABLE" : "PROVIDER_REJECTED";
      throw new JobError(code, "Live provider rejected the request.", response.status === 429 || response.status === 402 ? 429 : 502);
    }
    try { const text = await response.text(); if (text.length > 2000000) throw new Error(); return JSON.parse(text); }
    catch { throw new JobError("NETWORK_FAILURE", "Live provider response could not be read.", 502); }
  }
  async function getModels(signal, force = false) {
    requireKey();
    if (!force && cached && cached.key === key() && Date.now() - cached.at < 300000) return cached.models;
    const models = [];
    let route = "/models?pageSize=100";
    for (let page = 0; route && page < 10; page++) {
      const data = await providerRequest(route, { signal });
      if (!Array.isArray(data.results)) throw new JobError("NETWORK_FAILURE", "Live model list could not be read.", 502);
      for (const model of data.results) if (typeof model.name === "string" && !models.some(item => item.id === model.name)) models.push({ id: model.name });
      route = null;
      if (data.next) {
        const next = new URL(data.next);
        if (next.origin !== "https://api.ultravox.ai" || next.pathname !== "/api/models") throw new JobError("NETWORK_FAILURE", "Live model page is invalid.", 502);
        route = next.pathname.slice(4) + next.search;
      }
    }
    if (!models.length) throw new JobError("MODEL_UNAVAILABLE", "No live model is available.", 503);
    cached = { key: key(), at: Date.now(), models };
    return models;
  }
  return { requireKey, providerRequest, getModels, hasKey: () => Boolean(key()) };
}

module.exports = { pilotKey, createLiveProvider };
