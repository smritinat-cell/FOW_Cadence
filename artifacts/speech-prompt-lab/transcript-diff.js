/* Align words and punctuation while retaining each response's exact characters. */
(function (root) {
  'use strict';

  function tokenize(text) {
    return Array.from(text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu), match => ({
      value: match[0], start: match.index, end: match.index + match[0].length,
      word: /[\p{L}\p{N}]/u.test(match[0])
    }));
  }

  // Hirschberg alignment uses linear memory, including for long recordings.
  function lengths(a, aStart, aEnd, b, bStart, bEnd, reverse) {
    const width = bEnd - bStart, row = new Uint32Array(width + 1);
    for (let i = 0; i < aEnd - aStart; i++) {
      const value = a[reverse ? aEnd - 1 - i : aStart + i].value;
      let diagonal = 0;
      for (let j = 1; j <= width; j++) {
        const previous = row[j];
        row[j] = value === b[reverse ? bEnd - j : bStart + j - 1].value
          ? diagonal + 1 : Math.max(row[j], row[j - 1]);
        diagonal = previous;
      }
    }
    return row;
  }

  function align(a, aStart, aEnd, b, bStart, bEnd, pairs) {
    while (aStart < aEnd && bStart < bEnd && a[aStart].value === b[bStart].value) {
      pairs.push([aStart++, bStart++]);
    }
    let suffix = 0;
    while (aStart < aEnd - suffix && bStart < bEnd - suffix && a[aEnd - 1 - suffix].value === b[bEnd - 1 - suffix].value) suffix++;
    const endA = aEnd - suffix, endB = bEnd - suffix;
    if (aStart < endA && bStart < endB) {
      if (endA - aStart === 1) {
        for (let j = bStart; j < endB; j++) {
          if (a[aStart].value === b[j].value) { pairs.push([aStart, j]); break; }
        }
      } else {
        const middle = Math.floor((aStart + endA) / 2);
        let left = lengths(a, aStart, middle, b, bStart, endB, false);
        let right = lengths(a, middle, endA, b, bStart, endB, true);
        let split = 0, best = -1;
        for (let j = 0; j <= endB - bStart; j++) {
          const score = left[j] + right[endB - bStart - j];
          if (score > best) { best = score; split = j; }
        }
        left = null; right = null;
        align(a, aStart, middle, b, bStart, bStart + split, pairs);
        align(a, middle, endA, b, bStart + split, endB, pairs);
      }
    }
    for (let i = 0; i < suffix; i++) pairs.push([endA + i, endB + i]);
  }

  function segments(text, tokens, matched) {
    const result = [];
    function append(value, changed) {
      if (!value) return;
      const previous = result[result.length - 1];
      if (previous && previous.changed === changed) previous.text += value;
      else result.push({ text: value, changed });
    }
    let end = 0;
    tokens.forEach((token, i) => {
      // Whitespace is retained but does not count as a word change.
      const changed = !matched.has(i);
      append(text.slice(end, token.start), changed && i > 0 && !matched.has(i - 1));
      append(token.value, changed);
      end = token.end;
    });
    append(text.slice(end), false);
    return result;
  }

  function compare(oldText, newText) {
    const a = tokenize(oldText), b = tokenize(newText), pairs = [];
    align(a, 0, a.length, b, 0, b.length, pairs);
    const oldMatched = new Set(pairs.map(pair => pair[0]));
    const newMatched = new Set(pairs.map(pair => pair[1]));
    return {
      old: segments(oldText, a, oldMatched), new: segments(newText, b, newMatched),
      removedWords: a.filter((token, i) => token.word && !oldMatched.has(i)).length,
      addedWords: b.filter((token, i) => token.word && !newMatched.has(i)).length,
      changedTokens: a.length + b.length - pairs.length * 2
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { compare };
  else root.TranscriptDiff = { compare };
})(typeof window !== 'undefined' ? window : globalThis);
