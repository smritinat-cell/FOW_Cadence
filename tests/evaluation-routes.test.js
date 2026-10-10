// LABELLED TEST DATA ONLY: routes read synthetic in-memory records, with no provider calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Jobs } = require("../lib/jobs");
const { createApi } = require("../lib/api");

test("saved evaluation and exact TXT export are owner-scoped and validate IDs/filenames without provider calls", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "labelled-evaluation-route-test-"));
  let providerCalls = 0;
  const jobs = new Jobs(() => null, { directory, services: { providerRequest: async () => { providerCalls++; throw new Error("No provider calls permitted in this test."); } } });
  const token = "a".repeat(64);
  const ownerHash = crypto.createHash("sha256").update(token).digest("hex");
  const id = "11111111-1111-4111-8111-111111111111";
  const suggestedPrompt = "You are a test agent.\r\n  Keep every character. $&\n";
  jobs.records.set(id, { id, ownerHash, kind: "evaluation", status: "finished", createdAt: new Date().toISOString(), suggestedPrompt, rubric_version: "1.0.0", computedScores: { overall: 100 } });
  const api = createApi(() => null, (res,status,body) => {
    res.writeHead(status, {"Content-Type":"application/json"});
    res.end(JSON.stringify(body));
  }, { jobs });
  const server = http.createServer((req,res) => api.handle(req,res,new URL(req.url,"http://tests.invalid")));
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `cadence_session=${token}` };
  try {
    const read = await fetch(`${origin}/api/evaluations/${id}`,{headers});
    assert.equal(read.status,200);
    const saved = await read.json();
    assert.equal(saved.ownerHash,undefined);
    assert.equal(saved.computedScores.overall,100);
    const plain = await fetch(`${origin}/api/evaluations/${id}/suggested-prompt`,{headers});
    assert.equal(await plain.text(),suggestedPrompt);
    const download = await fetch(`${origin}/api/evaluations/${id}/suggested-prompt?download=1&filename=../../private.txt`,{headers});
    assert.equal(await download.text(),suggestedPrompt);
    assert.equal(download.headers.get("content-disposition"),`attachment; filename="suggested-prompt-${id}.txt"`);
    assert.equal((await fetch(`${origin}/api/evaluations/${id}`,{headers:{cookie:`cadence_session=${"b".repeat(64)}`}})).status,404);
    assert.equal((await fetch(`${origin}/api/evaluations/${id}/suggested-prompt`,{headers:{cookie:`cadence_session=${"b".repeat(64)}`}})).status,404);
    assert.equal((await fetch(`${origin}/api/evaluations/not-a-uuid/suggested-prompt`,{headers})).status,404);
    assert.equal((await fetch(`${origin}/api/evaluations/${id}%2F..%2Fprivate/suggested-prompt`,{headers})).status,404);
    assert.equal(providerCalls,0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
