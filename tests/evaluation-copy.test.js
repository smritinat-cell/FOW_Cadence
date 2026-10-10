const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../artifacts/speech-prompt-lab/simulation.js"), "utf8");
const setup = fs.readFileSync(path.join(__dirname, "../artifacts/speech-prompt-lab/app.js"), "utf8");

test("evaluation actions, retry actions and instructions use the requested wording", () => {
  assert.match(source, /id="review-results">Evaluate your voice agent<\/button>/);
  for (const id of ["retry-evaluation", "score-retry", "retry-review-post"]) {
    const buttons = [...source.matchAll(new RegExp(`id="${id}"[\\s\\S]*?</button>`, "g"))];
    assert.ok(buttons.length, `Missing ${id}`);
    for (const [button] of buttons) assert.ok(button.includes(">Evaluate your voice agent · retry</button>"), id);
  }
  assert.doesNotMatch(source + setup, /Evaluate transcript|Evaluate partial transcript|Evaluate prompt|Review partial transcript|Review results|evaluate your prompt/);
  assert.ok(setup.includes("Click Evaluate your voice agent to see what to improve in your prompt."));
  assert.ok(source.includes("Run a baseline transcript in Simulation, then click Evaluate your voice agent here."));
});

test("renamed controls retain their existing click handlers and eligibility guards", () => {
  assert.ok(source.includes('if (!baseline || !sample || hasActiveWork() || !model) return;'));
  assert.ok(source.includes('document.getElementById("review-results")?.addEventListener("click"'));
  assert.ok(source.includes('document.getElementById("score-retry")?.addEventListener("click", () => startEvaluation(ctx, evaluation?.baselineId, evaluation));'));
  assert.ok(source.includes('document.getElementById("retry-review-post")?.addEventListener("click"'));
  assert.ok(source.includes('hasActiveWork() || !eligibleBaseline(retryBaseline) ? "disabled" : ""'));
});
