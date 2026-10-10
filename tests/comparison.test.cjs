const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { compare } = require('../artifacts/speech-prompt-lab/transcript-diff.js');
const pair = require('../artifacts/speech-prompt-lab/comparison-results.json');
const code = fs.readFileSync(require.resolve('../artifacts/speech-prompt-lab/comparison.js'), 'utf8');

function harness({ before = pair.old.text, after = pair.new.text, failed = false, sample = 'sample-01', filename = pair.old.source.name, historyError = false, noSandbox = false } = {}) {
  const content = { innerHTML: '' };
  const baseline = { id: 'baseline', sampleId: sample, kind: 'baseline', status: 'finished' };
  const candidate = { id: 'candidate', sampleId: sample, kind: 'candidate', status: failed ? 'failed' : 'finished', recording: { fileName: 'M_0061_14y8m_1_1791609637693.wav' }, ...(noSandbox ? {} : { sandbox: { beforeRunId: baseline.id, stage: failed ? 'failed' : 'complete' } }) };
  const requests = [], copied = [], elements = new Map();
  function element(id, dataset = {}) {
    if (!elements.has(id)) elements.set(id, { dataset, textContent: '', handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
    return elements.get(id);
  }
  const sandbox = {
    URLSearchParams, Map, Set, WeakMap, Date, Number, String,
    location: { hash: '#/comparison', search: '' },
    navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    document: {
      getElementById(id) { return content.innerHTML.includes(`id="${id}"`) ? element(id) : null; },
      querySelectorAll(selector) {
        const attribute = selector.slice(1, -1);
        const key = attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return [...content.innerHTML.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map(match => element(`${attribute}-${match[1]}`, { [key]: match[1] }));
      }
    },
    async fetch(url, options) {
      requests.push({ url, method: options?.method || 'GET' });
      if (url === './comparison-results.json') return { ok: true, async json() { return pair; } };
      return { ok: !failed, async json() { return { ready: true, comparable: true, before: { rawOutput: before, promptUsed: 'Baseline prompt', status: 'finished' }, after: { rawOutput: after, promptUsed: 'Revised prompt', status: 'finished' }, transcriptDiff: { before, after, counts: { removedWords: 999, addedWords: 999 }, segments: [] } }; } };
    }
  };
  sandbox.window = { TranscriptDiff: { compare }, CadenceSimulation: { getRuns: () => [baseline, candidate], getRunsState: () => ({ loading: false, error: historyError ? 'Unavailable' : '' }), onRunsChange: () => () => {} } };
  vm.runInNewContext(code, sandbox);
  const ctx = { content, samples: [{ id: sample, audio_filename: filename }], experiment: { selectedId: sample, prompt: 'Current draft' } };
  sandbox.window.CadenceComparison.render(ctx);
  return { content, requests, copied, elements };
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); }

test('live comparison uses the shipped alignment and Step 1 filename in the new flow', async () => {
  const app = harness();
  await settle();
  assert.match(app.content.innerHTML, /<strong>59<\/strong><span>Words removed/);
  assert.match(app.content.innerHTML, /<strong>23<\/strong><span>Words added/);
  assert.match(app.content.innerHTML, /<h2>M_0061_14y8m_1.wav<\/h2>/);
  assert.doesNotMatch(app.content.innerHTML, /1791609637693|SAVED RESPONSES|Load old result|Load new result|Same audio and model|Original response text is preserved/);
  assert.ok(app.requests.every(request => request.method === 'GET'));
  assert.equal(app.requests.filter(request => request.url.startsWith('/api/comparisons')).length, 1);
  assert.ok(!app.requests.some(request => request.url.endsWith('comparison-results.json')));
  await app.elements.get('data-copy-transcript-before').handlers.click();
  assert.equal(app.copied[0], pair.old.text);
});

test('responses are escaped and copying retains whitespace, repetitions and Unicode', async () => {
  const before = " \r\nI I café — <script>alert('hello')</script>\n";
  const after = 'I café.\n';
  const app = harness({ before, after });
  await settle();
  assert.doesNotMatch(app.content.innerHTML, /<script>/);
  assert.match(app.content.innerHTML, /&lt;/);
  await app.elements.get('data-copy-transcript-before').handlers.click();
  assert.equal(app.copied[0], before);
  app.elements.get('highlight-changes').handlers.change({ currentTarget: { checked: false } });
  assert.match(app.content.innerHTML, /compare-transcript no-highlights/);
  await app.elements.get('data-copy-transcript-after').handlers.click();
  assert.equal(app.copied[1], after);
});

test('a failed sandbox uses clearly labelled earlier results for the same recording', async () => {
  const app = harness({ failed: true });
  await settle();
  assert.match(app.content.innerHTML, /Showing earlier results for this recording/);
  assert.match(app.content.innerHTML, /Saved result/);
  assert.match(app.content.innerHTML, /<strong>59<\/strong>/);
  assert.doesNotMatch(app.content.innerHTML, /id="apply-sandbox-prompt"|Accessibility score/);
  assert.ok(app.requests.every(request => request.method === 'GET'));
  await app.elements.get('data-copy-transcript-after').handlers.click();
  assert.equal(app.copied[0], pair.new.text);
});

test('failed Simulation runs also offer the saved pair without requiring a sandbox', async () => {
  const app = harness({ failed: true, noSandbox: true });
  await settle();
  assert.match(app.content.innerHTML, /Showing earlier results for this recording/);
  assert.match(app.content.innerHTML, /<strong>23<\/strong>/);
});

test('the saved pair is never attributed to a different Step 1 recording', async () => {
  const app = harness({ failed: true, noSandbox: true, sample: 'sample-02', filename: 'M_1114_09y10m.1.wav' });
  await settle();
  assert.doesNotMatch(app.content.innerHTML, /Showing earlier results|M_0061_14y8m_1.wav|<strong>59<\/strong>/);
});

test('run history errors can display the saved comparison for the selected recording', async () => {
  const app = harness({ noSandbox: true, historyError: true });
  await settle();
  assert.match(app.content.innerHTML, /Showing earlier results for this recording/);
});
