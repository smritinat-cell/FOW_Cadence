const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { compare } = require('../artifacts/speech-prompt-lab/transcript-diff.js');
const { exactLineDiff } = require('../lib/prompt-updates.js');
const preset = require('../config/transcript-improvement.json');

const simulationCode = fs.readFileSync(require.resolve('../artifacts/speech-prompt-lab/simulation.js'), 'utf8');
const comparisonCode = fs.readFileSync(require.resolve('../artifacts/speech-prompt-lab/comparison.js'), 'utf8');
const baselinePrompt = 'Transcribe the audio. Output only the transcript.';

function harness(code, { route = '#/scorecard', runs = [], evaluation, proposal } = {}) {
  const content = { innerHTML: '' }, requests = [], copied = [], elements = new Map();
  function element(id, dataset = {}) {
    if (!elements.has(id)) elements.set(id, { dataset, value: '', textContent: '', handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
    return elements.get(id);
  }
  const sandbox = {
    URL, URLSearchParams, Map, Set, WeakMap, Date, Number, String, Intl,
    location: { hash: route, search: '', href: 'http://localhost/' },
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    document: {
      getElementById(id) { return content.innerHTML.includes(`id="${id}"`) ? element(id) : null; },
      querySelectorAll(selector) {
        if (!/^\[data-[\w-]+\]$/.test(selector)) return [];
        const attribute = selector.slice(1, -1), key = attribute.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return [...content.innerHTML.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map(match => element(`${attribute}-${match[1]}`, { [key]: match[1] }));
      }
    },
    async fetch(url, options = {}) {
      requests.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
      let value;
      if (url === '/api/runs') value = { runs };
      else if (url.endsWith('/proposal') && proposal) value = proposal;
      else if (url.endsWith('/state')) value = { state: { outOfDate: false } };
      else if (url === `/api/evaluations/${evaluation?.id}`) value = evaluation;
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, async json() { return value; } };
    }
  };
  sandbox.window = { TranscriptDiff: { compare }, setInterval() {} };
  vm.runInNewContext(code, sandbox);
  const ctx = {
    content, samples: [{ id: 'sample-01', title: 'Stuttering', duration: 30, audio_filename: 'current-selection.wav' }],
    experiment: { selectedId: 'sample-01', useCaseId: 'sample-01', model: 'real-model', startOffset: 0, excerptLength: 15, prompt: 'Keep the clinical role and safety instructions.' },
    saveExperiment() {}
  };
  return { content, requests, copied, elements, ctx, api: sandbox.window.CadenceSimulation || sandbox.window.CadenceComparison };
}
async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }

function run(overrides = {}) {
  return { id: 'before', kind: 'baseline', status: 'finished', sampleId: 'sample-01', requestedModel: 'real-model', startOffset: 0, excerpt: { length: 15 }, audioHashes: { excerpt: 'same-audio' }, rawOutput: 'I I need an appointment.', promptUsed: baselinePrompt, ...overrides };
}

test('enhanced findings group speech patterns, verify quote pairs and use readable confidence', () => {
  const app = harness(simulationCode), markup = app.api.scorecardMarkup;
  const finding = { id: 'finding-1', speechPattern: 'Pattern: Stuttering', title: 'Stuttering: Request lost', severity: 'high', confidence: 'high', quote: 'I I & <script>', referenceVerified: true, referenceQuote: 'I need an appointment.', prompt_coverage: 'none', missedItems: [{ id: 'appointment', label: 'Appointment request' }] };
  const html = markup.groupedFindings([finding]);
  assert.match(html, /<h3>Stuttering<\/h3>/);
  assert.match(html, /<h3>Request lost<\/h3>/);
  assert.match(html, /High confidence/);
  assert.doesNotMatch(html, /HIGH%|<script>/);
  assert.match(html, /What the caller said/);
  assert.match(html, /What the agent produced/);
  assert.match(html, /Your current prompt does not cover this speech pattern/);
  assert.match(html, /Appointment request/);
  const unverified = markup.enhancedFinding({ ...finding, referenceVerified: false, referenceQuote: 'DO NOT ATTRIBUTE THIS QUOTE' });
  assert.doesNotMatch(unverified, /DO NOT ATTRIBUTE|What the caller said/);
  assert.match(unverified, /matching reference quote wasn’t available/);
  assert.doesNotMatch(markup.finding(finding), /enhanced-finding|What the caller said/);
  assert.equal(app.requests.length, 0);
});

test('enhanced edits retain all speech groups and allow saved callers to hide Apply controls', () => {
  const app = harness(simulationCode), markup = app.api.scorecardMarkup;
  const edits = ['Stuttering', 'Slower speech', 'Fillers', 'Vocabulary', 'Uncertainty', 'Restarts'].map((speechPattern, i) => ({ id: `edit-${i}`, speechPattern, title: `${speechPattern}: Preserve intent`, new_text: 'Keep <meaning> & wait.' }));
  const html = markup.enhancedEdits({ id: 'review', verifiedFindings: [] }, edits, { showApplyButtons: false });
  for (const edit of edits) assert.ok(html.includes(`<h3>${edit.speechPattern}</h3>`));
  assert.doesNotMatch(html, /<h3>Other<\/h3>|data-proposal-edit|Keep <meaning>/);
  assert.match(html, /Keep &lt;meaning&gt; &amp; wait\./);
  assert.match(markup.enhancedEdits({ id: 'review' }, edits), /data-proposal-edit="edit-0"[^>]*>Apply<\/button>/);
  assert.doesNotMatch(markup.edits({ id: 'review' }, edits, { showApplyButtons: false }), /data-proposal-edit/);
  assert.equal(app.requests.length, 0);
});

test('speech pattern source stays bound to the same recording, excerpt, model and audio', () => {
  const app = harness(simulationCode), markup = app.api.scorecardMarkup;
  const baseline = run({ speechPatterns: [{ label: 'Stuttering', counts: { wordRepetitions: 2 }, evidence: 'I I need' }], understanding: { text: 'Appointment request understood.', missingItems: ['Preferred time'] } });
  const candidate = run({ id: 'after', kind: 'candidate', cleaned: true, rawOutput: 'I need an appointment.' });
  const html = markup.speechPatterns(candidate, { baseline });
  assert.match(html, /Word repetitions/);
  assert.match(html, /Patterns shown from the baseline recording/);
  assert.match(html, /Appointment request understood\./);
  assert.match(html, /Preferred time/);
  for (const mismatch of [{ sampleId: 'sample-02' }, { startOffset: 10 }, { excerpt: { length: 30 } }, { requestedModel: 'other-model' }, { audioHashes: { excerpt: 'different-audio' } }]) {
    const other = markup.speechPatterns(candidate, { baseline: { ...baseline, ...mismatch } });
    assert.doesNotMatch(other, /Patterns shown from the baseline recording|Word repetitions/);
  }
  assert.equal(candidate.rawOutput, 'I need an appointment.');
  assert.equal(app.requests.length, 0);
});

test('native Scorecard has one complete, ordered empty state and never fabricates missing metrics', async () => {
  const app = harness(simulationCode);
  await app.api.refreshRuns(app.ctx);
  const html = app.content.innerHTML;
  const sections = ['Accessibility score', 'Speech patterns in this recording', 'What went wrong', 'Recommended prompt edits', 'Current and proposed', 'Test these changes'];
  let previous = -1;
  for (const label of sections) {
    const at = html.indexOf(label);
    assert.ok(at > previous, `${label} appears in order`);
    previous = at;
  }
  assert.equal((html.match(/<h2>What went wrong<\/h2>/g) || []).length, 1);
  assert.equal((html.match(/<h2>Recommended prompt edits<\/h2>/g) || []).length, 1);
  assert.equal((html.match(/<h2>Current and proposed<\/h2>/g) || []).length, 1);
  const missing = app.api.scorecardMarkup.enhancedPerformance(run(), app.ctx.samples[0]);
  assert.equal((missing.match(/Add a reference transcript to score this recording/g) || []).length, 3);
  assert.doesNotMatch(missing, /Not enough information|<strong>46|<strong>84/);
  assert.match(app.api.scorecardMarkup.performance(run(), app.ctx.samples[0]), /Not enough information to score this yet/);
  assert.doesNotMatch(app.api.scorecardMarkup.enhancedPerformance(run({ performance: { accessibilityScore: 46, demo: true } }), app.ctx.samples[0]), /<strong>46/);
  assert.ok(app.requests.every(request => request.method === 'GET'));
});

test('native Scorecard hero uses the reviewed original run rather than a later improved result', async () => {
  const evaluation = { id: 'review', kind: 'evaluation', status: 'finished', sampleId: 'sample-01', baselineId: 'before', evaluatedRunId: 'before', requestedModel: 'real-model', startOffset: 0, excerptLength: 15, context: { systemPrompt: 'Keep the clinical role and safety instructions.' }, parsedResult: { findings: [], parameters: [] }, verifiedFindings: [], promptUpdates: [] };
  const app = harness(simulationCode, { runs: [run({ performance: { accessibilityScore: 46, keyItemsCaptured: 2, keyItemsTotal: 5, wordAccuracy: 52 } }), run({ id: 'after', kind: 'candidate', performance: { accessibilityScore: 84, keyItemsCaptured: 4, keyItemsTotal: 5, wordAccuracy: 88 }, createdAt: '2026-10-10T12:00:00Z' }), evaluation], evaluation });
  await app.api.refreshRuns(app.ctx);
  await settle();
  assert.match(app.content.innerHTML, /enhanced-performance-cards/);
  assert.match(app.content.innerHTML, /<strong>46<small>\/ 100<\/small>/);
  assert.doesNotMatch(app.content.innerHTML, /<strong>84<small>/);
});

test('native Apply all proposes the validated edit IDs and preserves the original role prompt', async () => {
  const evaluation = { id: 'review', kind: 'evaluation', status: 'finished', sampleId: 'sample-01', baselineId: 'before', requestedModel: 'real-model', startOffset: 0, excerptLength: 15, rubric_version: '1', context: { systemPrompt: 'Keep the clinical role and safety instructions.' }, parsedResult: { findings: [], parameters: [] }, verifiedFindings: [], promptUpdates: [{ id: 'validated-one', type: 'append', speechPattern: 'Stuttering', new_text: 'Wait for the speaker.' }, { id: 'validated-two', type: 'append', speechPattern: 'Uncertainty', new_text: 'Confirm uncertain details.' }] };
  const app = harness(simulationCode, { runs: [run(), evaluation], evaluation, proposal: { suggestedPrompt: `${evaluation.context.systemPrompt}\nWait for the speaker.`, diff: [], selectedEditIds: ['validated-one', 'validated-two'] } });
  await app.api.refreshRuns(app.ctx);
  await settle();
  await app.elements.get('proposal-all').handlers.click();
  await settle();
  const request = app.requests.find(request => request.url.endsWith('/proposal'));
  assert.deepEqual(request.body.selectedEditIds, ['validated-one', 'validated-two']);
  assert.equal(request.body.currentPrompt, evaluation.context.systemPrompt);
  assert.equal(request.body.promptPreset, undefined);
  assert.ok(!app.requests.some(request => request.url === '/api/evaluations' || (request.url === '/api/runs' && request.method === 'POST')));
  assert.match(app.content.innerHTML, /Run with your current prompt in Simulation first\./);
});

test('completed results lead with actual scores and preserve exact prompts, raw responses and historical filename', async () => {
  const app = harness(comparisonCode, { route: '#/comparison' });
  const beforeText = ' \r\nI I café — <script>alert(1)</script>\n', afterText = 'I café.\n', exactPrompt = 'Keep the role.\r\nWait for <meaning> & confirm.\n';
  const pair = { comparable: true, before: run({ rawOutput: beforeText, performance: { accessibilityScore: 46, keyItemsCaptured: 2, keyItemsTotal: 5, wordAccuracy: 52 } }), after: run({ id: 'after', kind: 'candidate', rawOutput: afterText, promptUsed: exactPrompt, recording: { fileName: 'historical-recording.wav' }, performance: { accessibilityScore: 84, keyItemsCaptured: 4, keyItemsTotal: 5, wordAccuracy: 88 } }), promptDiff: [{ type: 'removed', text: 'old <instruction>\n' }, { type: 'added', text: exactPrompt }], speechGuidance: [{ speechPattern: 'Stuttering', rationale: 'Preserve the complete request.' }], themes: [{ label: 'Vocabulary', beforeCount: 1, afterCount: 2, worsened: true }] };
  let rendered = 0;
  app.api.renderCompleted(app.ctx, pair, { onRendered() { rendered++; } });
  const html = app.content.innerHTML;
  assert.match(html, /<strong>46 → 84<\/strong><span>\+38 points/);
  assert.match(html, /<h2>historical-recording.wav<\/h2>/);
  assert.doesNotMatch(html, /current-selection.wav|<script>|old <instruction>/);
  assert.ok(html.indexOf('Accessibility score') < html.indexOf('What changed in the wording'));
  assert.ok(html.indexOf('What these changes address') < html.indexOf('Original response'));
  assert.ok(html.indexOf('Updated response') < html.indexOf('Apply these changes to your agent'));
  assert.match(html, /prompt-diff-removed/);
  assert.match(html, /prompt-diff-added/);
  assert.match(html, /Vocabulary[\s\S]*Worsened/);
  await app.elements.get('data-copy-transcript-before').handlers.click();
  assert.equal(app.copied[0], beforeText);
  app.elements.get('highlight-changes').handlers.change({ currentTarget: { checked: false } });
  assert.match(app.content.innerHTML, /compare-transcript no-highlights/);
  await app.elements.get('data-copy-transcript-after').handlers.click();
  assert.equal(app.copied[1], afterText);
  app.elements.get('apply-sandbox-prompt').handlers.click();
  assert.match(app.content.innerHTML, /Copy this prompt into your agent/);
  await app.elements.get('copy-sandbox-prompt').handlers.click();
  assert.equal(app.copied[2], exactPrompt);
  assert.ok(rendered >= 4);
  assert.equal(app.requests.length, 0);
});

test('completed results flag regression and do not promote illustrative demo metrics into live scores', () => {
  const app = harness(comparisonCode, { route: '#/comparison' });
  const actual = { comparable: true, before: run({ performance: { accessibilityScore: 84, wordAccuracy: 88 } }), after: run({ id: 'after', performance: { accessibilityScore: 46, wordAccuracy: 52 } }) };
  app.api.renderCompleted(app.ctx, actual);
  assert.match(app.content.innerHTML, /enhanced-performance worsened/);
  assert.match(app.content.innerHTML, /84 → 46/);
  assert.match(app.content.innerHTML, /-38 points/);
  assert.match(app.content.innerHTML, /Word accuracy change · Decreased/);
  const demoOnly = { comparable: true, before: run({ performance: { accessibilityScore: 46, demo: true }, demoPerformance: { accessibilityScore: 46, demo: true } }), after: run({ id: 'after', performance: { accessibilityScore: 84, demo: true } }) };
  app.api.renderCompleted(app.ctx, demoOnly);
  assert.match(app.content.innerHTML, /Add a reference transcript to score this recording/);
  assert.doesNotMatch(app.content.innerHTML, /46 → 84|\+38 points|<strong>46|<strong>84/);
  assert.equal(app.requests.length, 0);
});

test('Results instruction list includes every exact preset addition despite one observed speech pattern', () => {
  const app = harness(comparisonCode, { route: '#/comparison' });
  const instructions = preset.prompt.split(/\r?\n---\r?\n/)[0].trim().split(/\r?\n\r?\n/);
  const comparison = { before: run(), after: run({ id: 'after', promptUsed: preset.prompt }), promptDiff: exactLineDiff(baselinePrompt, preset.prompt), speechGuidance: [{ speechPattern: 'Stuttering', new_text: instructions[2], rationale: 'Repeated wording can be hard to follow.' }] };
  const html = app.api.comparisonMarkup.guidance(app.ctx, comparison);
  assert.equal((html.match(/class="comparison-instruction"/g) || []).length, 6);
  for (const text of instructions) assert.ok(html.includes(text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])));
  assert.match(html, /Speech content/);
  assert.match(html, /Stuttering/);
  assert.match(html, /Meaning and short responses/);
  assert.match(html, /Vocabulary and uncertainty/);
  assert.match(html, /Transcript format/);
  assert.doesNotMatch(html, /# Reference vocabulary|Repeated wording can be hard to follow/);
  assert.equal(comparison.after.promptUsed, preset.prompt);
  assert.equal(app.requests.length, 0);
});

test('native Results list exact added or changed instructions with validated pattern labels', () => {
  const app = harness(comparisonCode, { route: '#/comparison' });
  const before = 'You are a clinical agent.\nKeep the safety instructions.\nWait briefly.\n';
  const after = 'You are a clinical agent.\nKeep the safety instructions.\nWait for the speaker to finish.\nConfirm <uncertain> details.\n';
  const comparison = { before: run({ promptUsed: before }), after: run({ id: 'after', promptUsed: after }), promptDiff: exactLineDiff(before, after), promptEdits: [{ speechPattern: 'Slower speech', new_text: 'Wait for the speaker to finish.\n', rationale: 'An explanation is not the actual instruction.' }, { speechPattern: 'Uncertainty', newText: 'Confirm <uncertain> details.\n' }] };
  const html = app.api.comparisonMarkup.guidance(app.ctx, comparison);
  assert.equal((html.match(/class="comparison-instruction"/g) || []).length, 2);
  assert.match(html, /Slower speech/);
  assert.match(html, /Uncertainty/);
  assert.match(html, /Wait for the speaker to finish\./);
  assert.match(html, /Confirm &lt;uncertain&gt; details\./);
  assert.doesNotMatch(html, /You are a clinical agent|Keep the safety|An explanation is not/);
  assert.equal(app.requests.length, 0);
});
