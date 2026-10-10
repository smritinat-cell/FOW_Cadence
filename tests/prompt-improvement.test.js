const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createApi } = require('../lib/api');
const preset = require('../config/transcript-improvement.json');
const saved = require('../artifacts/speech-prompt-lab/comparison-results.json');

async function proposal(body) {
  const token = 'a'.repeat(64);
  const owner = crypto.createHash('sha256').update(token).digest('hex');
  const reviewId = '11111111-1111-4111-8111-111111111111';
  const baselineId = '22222222-2222-4222-8222-222222222222';
  const currentPrompt = saved.old.prompt;
  const records = new Map([
    [reviewId, { kind: 'evaluation', status: 'finished', baselineId, context: { systemPrompt: currentPrompt }, parsedResult: { promptEdits: [] } }],
    [baselineId, { rawOutput: saved.old.text }]
  ]);
  const jobs = { owned(id, requestedOwner) { assert.equal(requestedOwner, owner); return records.get(id); } };
  let result;
  const api = createApi(() => null, (_, status, data) => { result = { status, data }; }, { jobs });
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', cookie: `cadence_session=${token}` };
  const url = new URL(`http://test.invalid/api/evaluations/${reviewId}/proposal`);
  await api.handle(req, { setHeader() {} }, url);
  return result;
}

test('Fix proposal API returns the exact shipped improvement and its reconstructable diff', async () => {
  const { status, data } = await proposal({ currentPrompt: saved.old.prompt, promptPreset: preset.id });
  assert.equal(status, 200);
  assert.equal(data.suggestedPrompt, saved.new.prompt);
  assert.equal(data.promptPreset, preset.id);
  assert.equal(data.diff.filter(part => part.type !== 'added').map(part => part.text).join(''), saved.old.prompt);
  assert.equal(data.diff.filter(part => part.type !== 'removed').map(part => part.text).join(''), saved.new.prompt);
});

test('Fix rejects a changed prompt snapshot and unsupported presets', async () => {
  assert.equal((await proposal({ currentPrompt: 'Changed', promptPreset: preset.id })).status, 409);
  assert.equal((await proposal({ currentPrompt: saved.old.prompt, promptPreset: 'unknown' })).status, 400);
});
