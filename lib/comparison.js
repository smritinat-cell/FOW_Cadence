const { diffWordsWithSpace } = require("diff");
const fixture = require("../fixtures/comparison-demo.json");
const { BASELINE_PROMPT } = require("./ultravox");
const wordCount = text => (text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;

function transcriptDiff(before,after) {
  const segments = diffWordsWithSpace(before, after).map(part => ({
    type: part.added ? "added" : part.removed ? "removed" : "context",
    text: part.value,
  }));
  return {
    before, after, segments,
    counts: {
      removedWords: segments.filter(segment => segment.type === "removed").reduce((total, segment) => total + wordCount(segment.text), 0),
      addedWords: segments.filter(segment => segment.type === "added").reduce((total, segment) => total + wordCount(segment.text), 0),
    },
  };
}
function getDemoComparison(){
  return {mode:"demo",baselinePrompt:BASELINE_PROMPT,...transcriptDiff(fixture.beforeLines.join("\n"),fixture.afterLines.join("\n"))};
}

module.exports = { getDemoComparison,transcriptDiff };
