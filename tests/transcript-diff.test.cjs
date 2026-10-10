const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('../artifacts/speech-prompt-lab/transcript-diff.js');

function check(oldText, newText) {
  const result = compare(oldText, newText);
  assert.equal(result.old.map(part => part.text).join(''), oldText);
  assert.equal(result.new.map(part => part.text).join(''), newText);
  return result;
}

test('identical text and spacing-only changes preserve both responses without word highlights', () => {
  for (const [a, b] of [['same\ntext.', 'same\ntext.'], ['same  text', 'same\ntext'], ['', ''], [' \n', '\t']]) {
    const result = check(a, b);
    assert.equal(result.changedTokens, 0);
    assert.equal(result.removedWords + result.addedWords, 0);
  }
});

test('replacement highlights both the removed and added word', () => {
  const result = check('some new squash shoes', 'some new Squishy shoes');
  assert.equal(result.removedWords, 1);
  assert.equal(result.addedWords, 1);
  assert.equal(result.old.filter(part => part.changed).map(part => part.text).join(''), 'squash');
  assert.equal(result.new.filter(part => part.changed).map(part => part.text).join(''), 'Squishy');
});

test('missing opening and stutter repetitions appear as deletions', () => {
  const result = check('Christmas I want games\nAnd some some new books', 'And some new books');
  assert.equal(result.removedWords, 5);
  assert.equal(result.addedWords, 0);
  assert.match(result.old.filter(part => part.changed).map(part => part.text).join(''), /Christmas I want games/);
});

test('punctuation changes are highlighted separately from word counts', () => {
  const result = check('No\nYes', 'No.\nYes.');
  assert.equal(result.changedTokens, 2);
  assert.equal(result.removedWords + result.addedWords, 0);
});

test('empty sides, Unicode, apostrophes and HTML-like text round-trip exactly', () => {
  for (const [a, b] of [['', 'New words.'], ['Gone words.', ''], ["DofE's café — ysgol", "DofE's café: ysgol!"], ['<script>hello</script>', '<img src=x>hello']]) check(a, b);
});

test('alignment is minimal for repeated words and reordered phrases', () => {
  // An independent full-matrix oracle checks short, adversarial word sequences.
  function minimum(a, b) {
    const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1] === b[j - 1] ? rows[i - 1][j - 1] + 1 : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
    return a.length + b.length - 2 * rows[a.length][b.length];
  }
  const sequences = ['', 'a', 'b', 'a a', 'a b', 'b a', 'a b a', 'b a b', 'a a b a', 'b b a b'];
  for (const a of sequences) for (const b of sequences) {
    const result = check(a, b);
    assert.equal(result.changedTokens, minimum(a ? a.split(' ') : [], b ? b.split(' ') : []), `${a} → ${b}`);
  }
});

test('long transcript with an insertion keeps surrounding words unchanged', () => {
  const text = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
  const result = check(text, text.replace('word1500', 'added word1500'));
  assert.equal(result.addedWords, 1);
  assert.equal(result.removedWords, 0);
});
