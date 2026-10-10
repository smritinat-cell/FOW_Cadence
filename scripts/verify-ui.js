// Controlled browser tests only. All mutation/model/job APIs are intercepted;
// these fixtures never reach the app server, disk results, or Ultravox.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { parseEvaluation, evaluatorInput, EVALUATOR_PROMPT } = require("../lib/evaluation");
const { callSettings } = require("../lib/ultravox");
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const report = { mode: "controlled UI responses; no live calls", checks: [], postCreates: 0, serverMutationRequests: 0, browserErrors: 0 };
const records = [];
const started = new Map();
const transcript = "um... my throat feels scratchy.";
let failNextEvaluation = true, browser, page;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = new Set(["finished", "cancelled", "partial", "failed"]);

function advance(record) {
  if (terminal.has(record.status)) return record;
  const elapsed = Date.now() - started.get(record.id);
  record.elapsedMs = elapsed;
  record.status = elapsed < 300 ? "connecting" : elapsed < 700 ? (record.kind === "baseline" ? "streaming" : "sending") : elapsed < 1300 ? "waiting" : "finished";
  if (record.kind === "baseline") {
    record.progress.audioSecondsSent = Math.min(15, elapsed / 1300 * 15);
    record.progress.percent = Math.min(100, Math.round(elapsed / 1300 * 100));
  }
  if (record.status === "finished") {
    record.endedAt = new Date().toISOString();
    if (record.kind === "baseline") { record.rawOutput = transcript; record.userInputTranscript = "um my throat feels scratchy"; }
    else {
      record.rawOutput = record.testInvalid ? "this is not evaluator JSON" : JSON.stringify({
        summary: "Controlled test review of uncertainty.",
        issues: [
          { id: "low", severity: "low", category: "fillers", title: "Hesitation", quote: "um...", why: "Avoid interpreting hesitation as refusal." },
          { id: "high", severity: "high", category: "symptom", title: "Body-part wording", quote: "throat", why: "Ask for clarification when a symptom term is unclear." },
          { id: "medium", severity: "medium", category: "uncertain word", title: "Invented quote test", quote: "not actually in transcript", why: "This test finding must be flagged, not silently corrected." },
        ],
        prompt_edits: [
          { id: "append", issue_ids: ["high", "low"], rationale: "Record uncertainty rather than guessing.", type: "append", new_text: "Ask the patient to repeat an unclear body-part term and mark uncertainty." },
          { id: "missing", issue_ids: ["medium"], rationale: "Test an unmatched anchor.", type: "replace", anchor: "This anchor is absent.", new_text: "Do not apply this test edit." },
        ],
      });
      Object.assign(record, parseEvaluation(record.rawOutput, transcript, record.context.systemPrompt));
    }
  }
  return record;
}

async function waitForFinished(id) {
  for (let count = 0; count < 30; count++) {
    const job = await page.evaluate(async id => (await (await fetch(`/api/jobs/${id}`)).json()), id);
    if (terminal.has(job.status)) return job;
    await wait(100);
  }
  throw new Error("Controlled job did not finish.");
}

(async () => {
  fs.mkdirSync("generated-artifacts", { recursive: true });
  browser = await chromium.launch({ executablePath: execFileSync("sh", ["-c", "command -v chromium"]).toString().trim(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  page.on("pageerror", () => report.browserErrors++);
  await page.route("**/api/**", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const send = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if ((path.startsWith("/api/demo-samples") || path === "/api/demo-comparison") && ["GET", "HEAD"].includes(method)) return route.continue();
    if (path === "/api/models") return send({ models: [{ id: "ultravox-v0.7" }], preferred: "ultravox-v0.7" });
    if (path === "/api/runs" && method === "GET") return send({ runs: records.map(advance).slice().reverse() });
    const jobRoute = path.match(/^\/api\/jobs\/([^/]+)(\/stop)?$/);
    if (jobRoute) {
      const record = records.find(record => record.id === jobRoute[1]);
      if (!record) return send({ error: { message: "Test job not found" } }, 404);
      if (method === "POST" && jobRoute[2]) {
        advance(record);
        record.status = "cancelled";
        record.outputPartial = true;
        record.rawOutput = "partial raw, um...";
        record.error = { code: "CANCELLED", message: "Stopped by user. Captured text is partial." };
      }
      return send(advance(record));
    }
    if (method === "POST" && ["/api/runs", "/api/evaluations"].includes(path)) {
      if (records.some(record => !terminal.has(advance(record).status))) return send({ error: { code: "RUN_ACTIVE", message: "A controlled job is active." } }, 409);
      const input = req.postDataJSON();
      assert.equal(input.reference, undefined);
      assert.equal(input.context?.reference, undefined);
      const kind = path === "/api/runs" ? "baseline" : "evaluation";
      const baseline = records.find(record => record.id === input.baselineId);
      const record = {
        id: `00000000-0000-0000-0000-${String(records.length + 1).padStart(12, "0")}`,
        kind, sampleId: input.sampleId || baseline.sampleId, baselineId: input.baselineId,
        createdAt: new Date().toISOString(), status: "preparing", elapsedMs: 0,
        progress: { audioSecondsSent: 0, audioSecondsTotal: kind === "baseline" ? 15 : 0, percent: 0 },
        requestedModel: input.model, resolvedModel: input.model,
        rawOutput: "", userInputTranscript: "", error: null, diagnostics: [], timings: {},
        context: input.context,
      };
      if (kind === "evaluation") {
        record.evaluatorInput = evaluatorInput(record.context, baseline.rawOutput);
        record.settings = callSettings(kind, input.model, 0, EVALUATOR_PROMPT, record.evaluatorInput);
        record.testInvalid = failNextEvaluation;
        failNextEvaluation = false;
      } else record.settings = callSettings(kind, input.model, 15);
      records.push(record);
      started.set(record.id, Date.now());
      report.postCreates++;
      return send(record, 202);
    }
    // Never fall through an unexpected API mutation to the real server.
    return send({ error: { message: "Blocked by controlled test interception." } }, 400);
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.locator('[data-sample-id="sample-01"]').click();
  const originalPrompt = await page.locator("#prompt-input").inputValue();
  await page.locator('a[href="#/simulation"]').click();
  await page.waitForFunction(() => !document.querySelector("#run-baseline").disabled);
  assert.equal(records.length, 0);
  await page.locator("#run-baseline").click();
  await wait(100);
  assert.equal(await page.locator("#run-baseline").isDisabled(), true);
  assert.equal(await page.locator("#run-evaluation").isDisabled(), true);
  const baseline = await waitForFinished(records[0].id);
  await wait(1300);
  assert.ok((await page.locator("#app-content").innerText()).includes(transcript));
  assert.ok((await page.locator("#app-content").innerText()).includes("User-input transcript"));
  report.checks.push("Real job-driven lifecycle UI, raw/separate transcripts and active-button lock with controlled responses");
  await page.locator("#run-evaluation").click();
  const invalid = await waitForFinished(records[1].id);
  assert.equal(invalid.context.systemPrompt, originalPrompt);
  await wait(1300);
  await page.locator('a[href="#/scorecard"]').click();
  assert.ok((await page.locator("#app-content").innerText()).includes("Could not parse evaluator output"));
  assert.ok((await page.locator("#app-content").innerText()).includes("this is not evaluator JSON"));
  await page.reload({ waitUntil: "networkidle" });
  await wait(1500);
  assert.equal(report.postCreates, 2);
  await page.locator("#score-retry").click();
  const evaluation = await waitForFinished(records[2].id);
  await wait(1300);
  assert.ok((await page.locator("#app-content").innerText()).includes("Generated by Ultravox. This is a model review, not a measured accuracy score."));
  assert.deepEqual(await page.locator(".severity").allTextContents(), ["high", "medium", "low"]);
  assert.ok((await page.locator("#app-content").innerText()).includes("Quote not found in transcript"));
  assert.ok((await page.locator("#app-content").innerText()).includes("Could not be applied"));
  assert.equal(await page.getByText("Unavailable", { exact: true }).count(), 3);
  assert.ok(await page.locator(".diff-line.added").count() > 0);
  report.checks.push("Parse failure/raw response, explicit retry after direct Scorecard reload, severity order, quote flags, unapplied anchors and line diff");
  await page.screenshot({ path: "generated-artifacts/ui-test-scorecard.jpg", type: "jpeg", quality: 75, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: "generated-artifacts/ui-test-scorecard-mobile.jpg", type: "jpeg", quality: 75 });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.locator("#copy-suggested").click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), evaluation.suggestedPrompt);
  await page.locator('a[href="#/setup"]').click();
  await page.locator("#tab-prompt").click();
  await page.locator("#prompt-input").fill(`${originalPrompt}\nEdited draft.`);
  await page.locator('a[href="#/scorecard"]').click();
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#apply-suggested").click();
  assert.ok(page.url().endsWith("#/scorecard"));
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#apply-suggested").click();
  assert.equal(await page.locator("#prompt-input").inputValue(), evaluation.suggestedPrompt);
  await wait(250);
  assert.equal(report.postCreates, 3);
  report.checks.push("Exact clipboard text; declined/accepted draft overwrite; application creates no new job; mobile no horizontal overflow");
  await page.locator('a[href="#/simulation"]').click();
  await page.locator("#run-baseline").click();
  await wait(500);
  await page.locator(`[data-stop-id="${records[3].id}"]`).first().click();
  await wait(1200);
  assert.ok((await page.locator("#app-content").innerText()).includes("Partial raw provider output"));
  assert.equal(await page.locator("#run-evaluation").isDisabled(), false);
  await page.reload({ waitUntil: "networkidle" });
  await wait(1500);
  assert.equal(report.postCreates, 4);
  await page.locator('a[href="#/comparison"]').click();
  assert.ok((await page.locator("#app-content").innerText()).includes("coming next"));
  assert.equal(report.postCreates, 4);
  assert.equal(report.browserErrors, 0);
  report.checks.push("Stop/partial labels; earlier finished baseline remains evaluable; reload/restore/comparison create no calls");
  report.success = true;
})().catch(error => { report.success = false; report.failure = error.message; process.exitCode = 1; }).finally(async () => {
  fs.mkdirSync("generated-artifacts", { recursive: true });
  fs.writeFileSync("generated-artifacts/ui-verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser?.close();
});
