// LABELLED TEST DATA: in-memory browser responses only; all mutations are intercepted.
// No real speech calls, saved results, reference data, or API credentials are used.
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const baselineId = "11111111-1111-4111-8111-111111111111";
const evaluationId = "22222222-2222-4222-8222-222222222222";
const sample = JSON.parse(fs.readFileSync("demo-pack/sample-01.json", "utf8"));
const report = { mode: "LABELLED TEST DATA; browser responses only; no live calls", checks: [], evaluationClicks: 0, unexpectedMutations: 0, browserErrors: [] };
let records = [], failNext = false, loadCount = 0;
const baseline = status => ({
  id: baselineId, kind: "baseline", status, sampleId: sample.id,
  createdAt: new Date().toISOString(), elapsedMs: 1200,
  requestedModel: "ultravox-v0.6", resolvedModel: "ultravox-v0.6",
  context: { agentName: sample.agent_name, purpose: sample.agent_purpose, speechProfileTags: sample.speech_profile_tags, systemPrompt: sample.system_prompt },
  useCase: { id: sample.id, label: sample.use_case_label },
  excerpt: { startOffset: 0, excerptLength: 15, length: 15 },
  promptUsed: "Transcribe the audio. Output only the transcript.",
  rawOutput: "um... my throat feels scratchy.", outputPartial: status === "partial",
  progress: { percent: 100, audioSecondsTotal: 15, audioSecondsSent: 15 },
  testData: true
});

(async () => {
  const browser = await chromium.launch({ executablePath: execFileSync("sh", ["-c", "command -v chromium"]).toString().trim(), headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", error => report.browserErrors.push(error.message));
    await page.addInitScript(({ sample }) => {
      localStorage.setItem("speech-prompt-lab-experiment-v1", JSON.stringify({
        selectedId: sample.id, useCaseId: sample.id, model: "ultravox-v0.6",
        agentName: sample.agent_name, purpose: sample.agent_purpose,
        speechProfileTags: sample.speech_profile_tags, prompt: sample.system_prompt,
        reference: "", startOffset: 0, excerptLength: "15"
      }));
    }, { sample });
    await page.route("**/api/**", async route => {
      const request = route.request(), url = new URL(request.url());
      const send = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (/\/state$/.test(url.pathname)) return send({ outOfDate: false, promptChanged: false, contextChanged: false, reasons: [] });
      if (request.method() === "POST" && url.pathname === "/api/evaluations") {
        report.evaluationClicks++;
        if (failNext) { failNext = false; return send({ error: { code: "NETWORK_FAILURE", message: "Connection problem." } }, 503); }
        const input = request.postDataJSON();
        const record = {
          id: evaluationId, kind: "evaluation", status: "finished", sampleId: sample.id,
          baselineId, requestedModel: input.model, context: input.context, useCase: input.useCase,
          createdAt: new Date().toISOString(), elapsedMs: 500,
          rawOutput: "LABELLED TEST DATA: unparseable evaluator response",
          parseError: "Could not parse evaluator output", parsedResult: null, testData: true
        };
        records = [records[0], record];
        return send(record, 202);
      }
      if (request.method() !== "GET") { report.unexpectedMutations++; return send({ error: { code: "INVALID_REQUEST" } }, 400); }
      if (url.pathname === "/api/runs") return send({ runs: records });
      if (url.pathname === "/api/models") return send({ models: [{ id: "ultravox-v0.6" }], preferred: "ultravox-v0.6" });
      if (/\/api\/(?:jobs|evaluations)\/[^/]+$/.test(url.pathname)) return send(records.find(r => r.id === url.pathname.split("/").pop()) || {});
      if (url.pathname === "/api/demo-samples" || /\/audio$/.test(url.pathname)) return route.continue();
      return send({});
    });
    async function load(status) {
      records = status ? [baseline(status)] : [];
      await page.goto(`${origin}/?copyCheck=${++loadCount}#/scorecard`);
      await page.waitForTimeout(500);
    }
    async function fits(selector) {
      const controls = page.locator(selector);
      for (let index = 0; index < await controls.count(); index++) {
        const control = controls.nth(index);
        if (!await control.isVisible()) continue;
        const box = await control.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1, "Label exceeds viewport");
        assert.ok(await control.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "Label is clipped");
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Page overflows");
    }
    await load(null);
    assert.equal(await page.locator("#review-results").count(), 0);
    assert.equal(report.evaluationClicks, 0);
    report.checks.push("No baseline: evaluation action remains unavailable; no automatic calls.");
    await load("finished");
    assert.equal(await page.locator("#review-results").first().innerText(), "Evaluate your voice agent");
    await fits("#review-results");
    await page.setViewportSize({ width: 390, height: 844 });
    await fits("#review-results");
    assert.equal(report.evaluationClicks, 0);
    await page.locator("#review-results").first().click();
    await page.waitForSelector("#score-retry");
    assert.equal(await page.locator("#score-retry").innerText(), "Evaluate your voice agent · retry");
    await fits("#score-retry");
    assert.equal(report.evaluationClicks, 1);
    await page.waitForTimeout(1300);
    assert.equal(report.evaluationClicks, 1);
    report.checks.push("Normal and malformed-response retry labels fit desktop/mobile; idle polling creates no evaluation.");
    await page.locator("#score-retry").click();
    await page.waitForTimeout(400);
    assert.equal(report.evaluationClicks, 2);
    await load("partial");
    assert.equal(await page.locator("#review-results").count(), 0);
    report.checks.push("An unselected partial baseline retains its existing no-action eligibility.");
    await load("finished");
    failNext = true;
    await page.locator("#review-results").first().click();
    await page.waitForSelector("#retry-review-post");
    assert.equal(await page.locator("#retry-review-post").innerText(), "Evaluate your voice agent · retry");
    await fits("#retry-review-post");
    const before = report.evaluationClicks;
    await page.waitForTimeout(1300);
    assert.equal(report.evaluationClicks, before);
    await page.locator("#retry-review-post").click();
    await page.waitForTimeout(400);
    assert.equal(report.evaluationClicks, before + 1);
    report.checks.push("Failed-start retry uses the requested label and runs only after an explicit click.");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await fits("#score-retry");
    assert.equal(report.unexpectedMutations, 0);
    assert.deepEqual(report.browserErrors, []);
    fs.mkdirSync("generated-artifacts", { recursive: true });
    fs.writeFileSync("generated-artifacts/evaluation-copy-verification.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
