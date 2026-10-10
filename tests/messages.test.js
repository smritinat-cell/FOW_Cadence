const test = require("node:test");
const assert = require("node:assert/strict");
const { friendlyMessage, messages, logTechnical } = require("../lib/messages");
const { JobError } = require("../lib/ultravox");
const banned = /\b(?:provider|API|JSON|server|job IDs|session lock|rubric|snapshot|hashes|requested model|resolved model|validation flags|raw output|parsed|stored|prototype|demo|fixture|roadmap|coming next)\b/i;
test("all response errors use friendly copy, not codes, technical details, or HTTP wording", () => {
  for (const [code,message] of Object.entries(messages)) {
    assert.equal(banned.test(message),false,code);
    assert.equal(/\bGET\b/.test(message),false,code);
    assert.equal(friendlyMessage(code),message);
  }
  assert.equal(friendlyMessage("UNKNOWN"),"Something went wrong. Please try again.");
  assert.equal(friendlyMessage("constructor"),"Something went wrong. Please try again.");
  const original = console.warn;
  console.warn = () => {};
  try {
    const error = new JobError("INVALID_REQUEST","Expected a JSON request. HTTP error.",400);
    assert.equal(error.message,"Something went wrong. Please try again.");
    assert.equal(error.status,400);
    assert.equal(error.message.includes("JSON"),false);
  } finally { console.warn = original; }
});
test("technical logs remove known secrets and private WebSocket addresses", () => {
  const original = console.warn, oldKey = process.env.ULTRAVOX_API_KEY;
  const output = [];
  process.env.ULTRAVOX_API_KEY = "labelled-test-secret-not-a-real-key";
  console.warn = line => output.push(line);
  try {
    logTechnical("TEST","labelled-test-secret-not-a-real-key wss://private.invalid/join");
    assert.ok(!output.join("").includes("labelled-test-secret-not-a-real-key"));
    assert.ok(!output.join("").includes("wss://"));
  } finally {
    console.warn = original;
    if (oldKey === undefined) delete process.env.ULTRAVOX_API_KEY;
    else process.env.ULTRAVOX_API_KEY = oldKey;
  }
});
