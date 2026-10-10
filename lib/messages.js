const messages = {
  PAIR_MISMATCH: "This baseline no longer matches your setup. Run a new baseline.",
  BEFORE_REQUIRED: "Run with your current prompt in Simulation first.",
  SANDBOX_FAILED: "We couldn't test these changes. Please try again.",
  MISSING_KEY: "The speech service isn't available right now. Please contact your workspace admin.",
  INVALID_KEY: "The speech service isn't available right now. Please contact your workspace admin.",
  USAGE_LIMIT: "The speech service is busy or at its limit. Please try again later.",
  MODEL_UNAVAILABLE: "This speech model isn't available. Choose another model and try again.",
  DECODE_FAILURE: "We couldn't read this recording. Choose another recording and try again.",
  SAMPLE_UNAVAILABLE: "We couldn't read this recording. Choose another recording and try again.",
  NETWORK_FAILURE: "Connection problem. We'll keep trying.",
  TIMEOUT: "This took too long. Please try again.",
  EMPTY_RESPONSE: "No transcript came back. Please try again.",
  CANCELLED: "Stopped.",
  RUN_ACTIVE: "A run is already in progress. Wait for it to finish or stop it.",
  BASELINE_REQUIRED: "Run a baseline transcript before evaluating.",
  INVALID_CONTEXT: "Check your agent details and try again.",
  INVALID_EXCERPT: "Choose a start time and excerpt length that fit the recording.",
  RUBRIC_UNAVAILABLE: "Choose a use case before evaluating.",
  STORAGE_FAILURE: "We couldn't save your results. Please try again.",
  SERVER_RESTARTED: "This run was interrupted. Please try again.",
  NO_SUGGESTED_PROMPT: "Run an evaluation to get prompt suggestions.",
  SNAPSHOT_REQUIRED: "Your prompt has changed. Evaluate it again before using these suggestions.",
  NOT_FOUND: "We couldn't find this result. Please try again.",
};
const unknown = "Something went wrong. Please try again.";
function friendlyMessage(code) { return Object.hasOwn(messages, code) ? messages[code] : unknown; }
function logTechnical(code, detail) {
  if (code === "CANCELLED") return;
  let safe = String(detail || "");
  for (const key of ["ULTRAVOX_API_KEY", "SESSION_SECRET"]) {
    const value = process.env[key];
    if (value) safe = safe.replaceAll(value, "[redacted]");
  }
  safe = safe.replace(/wss?:\/\/[^\s"'<>]+/gi, "[private address removed]");
  console.warn(JSON.stringify({ event: "speech_service_error", code, detail: safe }));
}
module.exports = { messages, friendlyMessage, logTechnical };
