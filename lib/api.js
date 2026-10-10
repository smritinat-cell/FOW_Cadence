const crypto = require("node:crypto");
const { Jobs, redact } = require("./jobs");
const { getModels, preferredModel, JobError } = require("./ultravox");
const { applyEdits } = require("./evaluation");
const { getDemoComparison,transcriptDiff } = require("./comparison");
const { comparison } = require("./performance");
const { buildPromptProposal,exactLineDiff } = require("./prompt-updates");
const { evaluationState } = require("./evaluation-state");
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

function sessionOwner(req, res) {
  if (req.cadenceOwner) return req.cadenceOwner;
  const cookie = String(req.headers.cookie || "").match(/(?:^|;\s*)cadence_session=([a-f0-9]{64})(?:;|$)/);
  const session = cookie ? cookie[1] : crypto.randomBytes(32).toString("hex");
  const secure = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
  if (!cookie) res.setHeader("Set-Cookie", `cadence_session=${session}; HttpOnly; ${secure ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax"}; Path=/; Max-Age=2592000`);
  req.cadenceOwner = crypto.createHash("sha256").update(session).digest("hex");
  return req.cadenceOwner;
}

async function readBody(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw new JobError("INVALID_REQUEST", "Expected a JSON request.", 400);
  let bytes = 0, text = "";
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 150000) throw new JobError("INVALID_REQUEST", "Request exceeds the permitted size.", 413);
    text += chunk;
  }
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new JobError("INVALID_REQUEST", "Invalid JSON request.", 400); }
}

function createApi(resolveSample, sendJson, options = {}) {
  const jobs = options.jobs || new Jobs(resolveSample);
  async function handle(req, res, url) {
    try {
      const owner = sessionOwner(req, res);
      if (url.pathname === "/api/demo-comparison" && req.method === "GET") {
        sendJson(res, 200, getDemoComparison());
        return;
      }
      if (req.method === "POST" && req.headers.origin) {
        const hosts = [req.headers.host, String(req.headers["x-forwarded-host"] || "").split(",")[0].trim()];
        if (!hosts.includes(new URL(req.headers.origin).host)) throw new JobError("INVALID_ORIGIN", "Cross-origin run requests are not allowed.", 403);
      }
      if (url.pathname === "/api/models" && req.method === "GET") {
        const models = await getModels();
        sendJson(res, 200, { models, preferred: preferredModel(models) });
        return;
      }
      if (url.pathname === "/api/runs" && req.method === "GET") {
        sendJson(res, 200, { runs: jobs.list(owner), storageWarning: jobs.storageWarning || null });
        return;
      }
      if (["/api/runs", "/api/evaluations"].includes(url.pathname) && req.method === "POST") {
        const body = await readBody(req);
        if(url.pathname==="/api/runs"&&body.mode&&!["baseline","candidate"].includes(body.mode))throw new JobError("INVALID_REQUEST","Unsupported audio run mode.",400);
        sendJson(res, 202, jobs.start(url.pathname === "/api/runs" ? body.mode||"baseline" : "evaluation", body, owner));
        return;
      }
      if(url.pathname==="/api/comparisons"&&req.method==="GET"){
        const beforeId=url.searchParams.get("beforeId"),afterId=url.searchParams.get("afterId");
        if(!new RegExp(`^${UUID}$`).test(beforeId||"")||!new RegExp(`^${UUID}$`).test(afterId||""))throw new JobError("NOT_FOUND","Invalid comparison IDs.",404);
        const before=jobs.owned(beforeId,owner),after=jobs.owned(afterId,owner);
        if(before.kind!=="candidate"||after.kind!=="candidate"||after.sandbox?.beforeRunId!==before.id)throw new JobError("NOT_FOUND","No matching tested changes.",404);
        const review=jobs.owned(after.sandbox.sourceEvaluationId,owner);
        const afterReview=after.sandbox.afterEvaluationId?jobs.owned(after.sandbox.afterEvaluationId,owner):null;
        const data=comparison(before,after,review,afterReview);
        sendJson(res,200,redact({...data,before:jobs.public(before),after:jobs.public(after),ready:after.status==="finished",transcriptDiff:transcriptDiff(before.rawOutput,after.rawOutput),promptDiff:exactLineDiff(before.promptUsed,after.promptUsed)}));return;
      }
      const evaluationRoute = url.pathname.match(new RegExp(`^/api/evaluations/(${UUID})(/(?:state|suggested-prompt|proposal))?$`));
      if (evaluationRoute) {
        const record = jobs.owned(evaluationRoute[1], owner);
        if (record.kind !== "evaluation") throw new JobError("NOT_FOUND", "Evaluation not found.", 404);
        if (!evaluationRoute[2] && req.method === "GET") sendJson(res, 200, jobs.public(record));
        else if (evaluationRoute[2] === "/state" && req.method === "POST") {
          const body = await readBody(req);
          const baseline = jobs.records.get(record.baselineId);
          sendJson(res, 200, await evaluationState(record, baseline?.ownerHash === owner ? baseline : null, body, resolveSample));
        } else if(evaluationRoute[2]==="/proposal"&&req.method==="POST"){
          const body=await readBody(req),baseline=jobs.owned(record.baselineId,owner);
          if(record.status!=="finished"||!record.parsedResult)throw new JobError("NO_SUGGESTED_PROMPT","No completed review.",409);
          if(body.currentPrompt!==undefined&&body.currentPrompt!==record.context.systemPrompt)throw new JobError("SNAPSHOT_REQUIRED","Prompt changed.",409);
          const ids=Array.isArray(body.selectedEditIds)?body.selectedEditIds:null;
          const edits=(record.parsedResult.promptEdits||[]).filter(edit=>!ids||ids.includes(edit.id));
          if(body.promptPreset!=null&&body.promptPreset!=="readable-transcript-v1")throw new JobError("INVALID_REQUEST","Unknown prompt improvement.",400);
          sendJson(res,200,redact(buildPromptProposal(record.context.systemPrompt,edits,record,baseline.rawOutput,record.referenceMaterial,body.promptPreset)));
        } else if (evaluationRoute[2] === "/suggested-prompt" && req.method === "GET") {
          if (record.status !== "finished" || typeof record.suggestedPrompt !== "string" || record.promptUpdateSetRejected) throw new JobError("NO_SUGGESTED_PROMPT", "No validated suggested prompt is available for this evaluation.", 409);
          const prompt = jobs.public(record).suggestedPrompt;
          res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            ...(url.searchParams.get("download") === "1" ? { "Content-Disposition": `attachment; filename="suggested-prompt-${record.id}.txt"` } : {}),
          });
          res.end(prompt);
        } else throw new JobError("METHOD_NOT_ALLOWED", "Method not allowed.", 405);
        return;
      }
      const route = url.pathname.match(new RegExp(`^/api/jobs/(${UUID})(/stop)?$`));
      if (route) {
        if (req.method === "GET" && !route[2]) sendJson(res, 200, jobs.public(jobs.owned(route[1], owner)));
        else if (req.method === "POST" && route[2]) { await readBody(req); sendJson(res, 200, jobs.stop(route[1], owner)); }
        else throw new JobError("METHOD_NOT_ALLOWED", "Method not allowed.", 405);
        return;
      }
      const applyRoute = url.pathname.match(new RegExp(`^/api/evaluations/(${UUID})/apply$`));
      if (applyRoute && req.method === "POST") {
        const record = jobs.owned(applyRoute[1], owner);
        if (record.rubric_version) throw new JobError("SNAPSHOT_REQUIRED", "This suggestion belongs to the evaluated prompt snapshot. Re-evaluate an edited prompt or explicitly use the saved suggestion.", 409);
        const body = await readBody(req);
        if (!record.parsedResult || typeof body.currentPrompt !== "string" || body.currentPrompt.length > 100000) throw new JobError("INVALID_CONTEXT", "A parsed evaluation and current prompt are required.", 400);
        sendJson(res, 200, redact(applyEdits(body.currentPrompt, record.parsedResult.promptEdits)));
        return;
      }
      throw new JobError("NOT_FOUND", "API endpoint not found.", 404);
    } catch (error) {
      const safe = error instanceof JobError ? error : new JobError("SERVER_ERROR", "The request could not be completed.", 500);
      sendJson(res, safe.status, redact({ error: { code: safe.code, message: safe.message } }));
    }
  }
  return { handle, jobs, initialize: sessionOwner };
}

module.exports = { createApi };
