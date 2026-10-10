/* Explicit, paid Preview verification. Never run as part of npm test/start. */
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const assert = require("node:assert/strict");

if (!process.argv.includes("--paid")) {
  console.log("Skipped. Explicitly pass --paid to authorize run/evaluate button clicks.");
  process.exit(0);
}
const terminal = new Set(["finished", "partial", "failed", "cancelled"]);
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const report = { checks: [], paidButtonClicks: 0, browserWebSockets: 0, browserErrors: 0 };
let browser, context, page;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function jobs() {
  return page.evaluate(async () => (await (await fetch("/api/runs")).json()).runs);
}
async function waitJob(id, timeout = 100000, desired) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const job = await page.evaluate(async id => (await (await fetch(`/api/jobs/${id}`)).json()), id);
    if (desired ? job.status === desired : terminal.has(job.status)) return job;
    await wait(500);
  }
  throw new Error("Preview job did not reach the expected lifecycle state within the test bound.");
}
async function clickCreate(buttonId, endpoint) {
  const responsePromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === endpoint);
  await page.locator(buttonId).click();
  report.paidButtonClicks++;
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status(), 202, body.error?.message || "Job was not accepted");
  return body;
}
function summary(job) {
  return {
    status: job.status, error: job.error, elapsedMs: job.elapsedMs,
    requestedModel: job.requestedModel, resolvedModel: job.resolvedModel,
    outputCharacters: job.rawOutput.length,
    userTranscriptCharacters: job.userInputTranscript.length,
    audioSeconds: job.progress.audioSecondsTotal,
    parseError: job.parseError || null,
    issues: job.parsedResult?.issues.length ?? null,
    promptEdits: job.parsedResult?.promptEdits.length ?? null,
    validationFlags: job.validationFlags?.length ?? null,
    unappliedEdits: job.unappliedEdits?.length ?? null,
    seededTextFallbackUsed: job.diagnostics.some(item => item.event === "seed_did_not_trigger_answer_user_text_sent"),
  };
}

(async () => {
  fs.mkdirSync("generated-artifacts", { recursive: true });
  browser = await chromium.launch({
    executablePath: execFileSync("sh", ["-c", "command -v chromium"]).toString().trim(),
    headless: true, args: ["--no-sandbox"],
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  page.on("websocket", () => report.browserWebSockets++);
  page.on("pageerror", () => report.browserErrors++);
  await page.goto(origin, { waitUntil: "networkidle" });
  const samples = await page.evaluate(async () => (await (await fetch("/api/demo-samples")).json()));
  for (const sample of samples) {
    await page.locator(`[data-sample-id="${sample.id}"]`).click();
    assert.equal(await page.locator("#prompt-input").inputValue(), sample.system_prompt);
    assert.ok((await page.locator("#app-content").innerText()).includes(sample.agent_name));
  }
  await page.locator('[data-sample-id="sample-01"]').click();
  const originalPrompt = samples[0].system_prompt;
  const edited = `${originalPrompt}\nKeep this edited draft.`;
  await page.locator("#prompt-input").fill(edited);
  await page.locator('[data-sample-id="sample-01"]').click();
  assert.equal(await page.locator("#prompt-input").inputValue(), edited);
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator('[data-sample-id="sample-02"]').click();
  assert.equal(await page.locator("#prompt-input").inputValue(), edited);
  page.once("dialog", dialog => dialog.accept());
  await page.locator('[data-sample-id="sample-02"]').click();
  await page.locator('[data-sample-id="sample-01"]').click();
  assert.equal(await page.locator("#prompt-input").inputValue(), originalPrompt);
  report.checks.push("All three sample presets; same-sample draft preservation; different-sample confirmation");
  await page.locator('a[href="#/simulation"]').click();
  await page.waitForFunction(() => document.querySelector("#run-baseline") && !document.querySelector("#run-baseline").disabled, { timeout: 20000 });
  assert.equal((await jobs()).length, 0);
  assert.equal(report.paidButtonClicks, 0);
  report.checks.push("Selection/navigation/restore create no jobs");

  const baselineStart = await clickCreate("#run-baseline", "/api/runs");
  assert.equal(await page.locator("#run-baseline").isDisabled(), true);
  assert.equal(await page.locator("#run-evaluation").isDisabled(), true);
  const baseline = await waitJob(baselineStart.id);
  report.baseline = summary(baseline);
  assert.equal(baseline.status, "finished", baseline.error?.message || "Baseline was not finished");
  assert.equal(baseline.settings.systemPrompt, "Transcribe the audio. Output only the transcript.");
  assert.equal(baseline.progress.audioSecondsTotal, 15);
  assert.equal(baseline.excerpt.startOffset, 0);
  assert.equal(baseline.audioFormat.sampleRate, 16000);
  assert.equal(baseline.audioFormat.channels, 1);
  assert.equal(baseline.audioFormat.bitsPerSample, 16);
  assert.ok(baseline.rawOutput.length > 0);
  assert.ok(!JSON.stringify(baseline).includes("wss://"));
  assert.ok(!JSON.stringify(baseline).includes("joinUrl"));
  report.checks.push("Real 0s/15s baseline completed; fixed prompt; separate user transcript; audio format/hashes; controls locked");
  await wait(1500);
  await page.screenshot({ path: "generated-artifacts/preview-simulation.jpg", type: "jpeg", quality: 75, fullPage: true });
  await page.waitForFunction(() => !document.querySelector("#run-evaluation").disabled);

  const evalStart = await clickCreate("#run-evaluation", "/api/evaluations");
  const evaluation = await waitJob(evalStart.id);
  report.evaluation = summary(evaluation);
  assert.equal(evaluation.status, "finished", evaluation.error?.message || "Evaluation was not finished");
  assert.equal(evaluation.context.systemPrompt, originalPrompt);
  assert.equal(evaluation.context.agentName, samples[0].agent_name);
  assert.ok(evaluation.evaluatorInput.endsWith(baseline.rawOutput));
  assert.equal(evaluation.parsedResult !== null, true, evaluation.parseError || "No parsed evaluation");
  assert.ok(!JSON.stringify(evaluation).includes("wss://"));
  assert.ok(!JSON.stringify(evaluation).includes("joinUrl"));
  report.checks.push("Real text-only evaluator completed with exact draft/input and parsed JSON");
  await wait(1500);
  await page.locator('a[href="#/scorecard"]').click();
  assert.ok((await page.locator("#app-content").innerText()).includes("Generated by Ultravox. This is a model review, not a measured accuracy score."));
  assert.equal(await page.getByText("Unavailable", { exact: true }).count(), 3);
  await page.screenshot({ path: "generated-artifacts/preview-scorecard.jpg", type: "jpeg", quality: 75, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Mobile layout overflows horizontally");
  await page.screenshot({ path: "generated-artifacts/preview-scorecard-mobile.jpg", type: "jpeg", quality: 75 });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.locator("#copy-suggested").click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), evaluation.suggestedPrompt);
  await page.locator('a[href="#/setup"]').click();
  await page.locator("#tab-prompt").click();
  await page.locator("#prompt-input").fill(edited);
  await page.locator('a[href="#/scorecard"]').click();
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#apply-suggested").click();
  assert.equal(page.url().endsWith("#/scorecard"), true);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#apply-suggested").click();
  assert.equal(await page.locator("#prompt-input").inputValue(), evaluation.suggestedPrompt);
  await wait(250);
  assert.equal((await jobs()).length, 2);
  report.checks.push("Scorecard real findings/diff/unavailable labels; mobile no overflow; exact copy and confirmed prompt application; no auto-run");
  await page.locator('a[href="#/comparison"]').click();
  assert.ok((await page.locator("#app-content").innerText()).includes("coming next"));
  await page.locator('a[href="#/simulation"]').click();
  await page.reload({ waitUntil: "networkidle" });
  await wait(1800);
  assert.equal((await jobs()).length, 2);
  report.checks.push("Reload/history/prompt application/comparison start no additional jobs");

  const cancelStart = await clickCreate("#run-baseline", "/api/runs");
  await waitJob(cancelStart.id, 25000, "streaming");
  await page.locator(`[data-stop-id="${cancelStart.id}"]`).first().click();
  const cancelled = await waitJob(cancelStart.id, 10000);
  report.cancelled = summary(cancelled);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error.code, "CANCELLED");
  report.checks.push("Real active server WebSocket/audio run stopped by UI");

  const isolated = await browser.newContext();
  const isolatedPage = await isolated.newPage();
  await isolatedPage.goto(origin);
  const privateHistory = await isolatedPage.evaluate(async () => (await (await fetch("/api/runs")).json()).runs);
  assert.equal(privateHistory.length, 0);
  await isolated.close();
  assert.equal(report.browserWebSockets, 0);
  assert.equal(report.browserErrors, 0);
  report.checks.push("Fresh browser cannot read prior session jobs; zero browser provider WebSockets/errors");
  report.success = true;
})().catch(error => {
  report.success = false;
  report.failure = error.message;
  process.exitCode = 1;
}).finally(async () => {
  if (page && browser) {
    try {
      const active = (await jobs()).filter(job => !terminal.has(job.status));
      if (active.length) {
        await page.locator('a[href="#/simulation"]').click();
        await page.locator(`[data-stop-id="${active[0].id}"]`).first().click();
      }
    } catch {}
  }
  fs.mkdirSync("generated-artifacts", { recursive: true });
  fs.writeFileSync("generated-artifacts/preview-verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser?.close();
});
