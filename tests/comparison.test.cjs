const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeResult, parseImport, compareResults, comparisonContext } = require('../artifacts/speech-prompt-lab/comparison.js');

test('TXT import preserves disfluencies, Unicode, whitespace and HTML-like text exactly', () => {
  const text = " \nI I café — <script>alert('hello')</script>\r\n";
  const result = parseImport(text, 'transcript.TXT');
  assert.equal(result.text, text);
  assert.equal(result.complete, undefined);
  assert.match(comparisonContext(result, result), /metadata unavailable/);
});

test('JSON imports preserve original responses and whitelist exported metadata', () => {
  const raw = {
    text: 'No.\nYes.  ', prompt: 'Exact\r\nprompt', complete: false,
    api_key: 'private', joinUrl: 'wss://private', events: [{ privateUrl: 'wss://private' }],
    request: { private_key: 'private' },
    engine: { model: 'ultravox-v0.6', temperature: 0, api_key: 'private' },
    audio: { sha256: 'audio-hash', start_seconds: 0, duration_seconds: 133.75 }
  };
  const result = parseImport(JSON.stringify(raw), 'result.json');
  assert.equal(result.text, raw.text);
  assert.equal(result.prompt, raw.prompt);
  assert.equal(result.complete, false);
  assert.equal(result.engine.temperature, 0);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('invalid or unsupported imports are rejected before they replace results', () => {
  for (const raw of [null, [], 'text', {}, { text: null }]) assert.throws(() => normalizeResult(raw));
  assert.throws(() => parseImport('{', 'result.json'), /valid result/);
  assert.throws(() => parseImport('hello', 'result.html'), /JSON.*TXT/);
  assert.throws(() => normalizeResult({ text: 'a'.repeat(100001) }), /100,000/);
  assert.equal(parseImport('\uFEFF{"text":""}', 'result.json').text, '');
});

test('matching runs, missing metadata and mismatches have distinct provenance notes', () => {
  const a = normalizeResult({ text: 'a', audio: { sha256: 'same' }, engine: { model: 'm', temperature: 0 } });
  const b = normalizeResult({ text: 'b', audio: { sha256: 'same' }, engine: { model: 'm', temperature: 0 } });
  assert.match(comparisonContext(a, b), /Same audio and model/);
  b.audio.sha256 = 'different';
  assert.match(comparisonContext(a, b), /Different audio or models/);
  b.audio.sha256 = 'same'; b.engine.temperature = 1;
  assert.match(comparisonContext(a, b), /Different model settings/);
  assert.match(comparisonContext(a, { text: 'b' }), /metadata unavailable/);
});

test('very large alignments are skipped while retaining the raw transcripts', () => {
  const a = normalizeResult({ text: 'old '.repeat(5000) });
  const b = normalizeResult({ text: 'new '.repeat(5000) });
  assert.equal(compareResults(a, b), null);
  assert.equal(a.text, 'old '.repeat(5000));
});

test('the shipped saved comparison computes 59 removed and 23 added words', () => {
  const file = path.join(__dirname, '../artifacts/speech-prompt-lab/comparison-results.json');
  const pair = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = compareResults(normalizeResult(pair.old), normalizeResult(pair.new));
  assert.equal(result.removedWords, 59);
  assert.equal(result.addedWords, 23);
  assert.equal(result.old.map(part => part.text).join(''), pair.old.text);
  assert.equal(result.new.map(part => part.text).join(''), pair.new.text);
  assert.match(comparisonContext(pair.old, pair.new), /Same audio and model/);
});
