// LABELLED TEST DATA: references and critical items below are synthetic.
const test=require("node:test"),assert=require("node:assert/strict");
const {metricInputs,performance,wordErrors,comparison}=require("../lib/performance");
test("accessibility uses the same exact 50/50 calculation before and after",()=>{
  const input=metricInputs({reference_transcript:"red blue green",critical_items:["red","green"]});
  const before=performance("red blue",input),after=performance("red blue green",input);
  assert.equal(before.keyItemsCaptured,1);assert.equal(before.keyItemsTotal,2);
  assert.equal(before.wordAccuracy,67);assert.equal(before.accessibilityScore,58);
  assert.equal(after.accessibilityScore,100);assert.equal(after.wordAccuracy,100);
  assert.equal(before.details.deletions,1);assert.equal(before.details.errors,1);
});
test("WER counts substitutions, insertions, deletions and floors accuracy at zero",()=>{
  assert.equal(wordErrors("red blue","red green").substitutions,1);
  assert.equal(wordErrors("red","red blue").insertions,1);
  assert.equal(wordErrors("red blue","red").deletions,1);
  assert.equal(performance("x y z",metricInputs({reference_transcript:"red",critical_items:["red"]})).wordAccuracy,0);
  assert.equal(wordErrors("Hello, WORLD!","hello world").errors,0);
});
test("missing reference or critical items never produces an invented overall score",()=>{
  const none=performance("real words",metricInputs({}));
  assert.equal(none.accessibilityScore,null);assert.equal(none.wordAccuracy,null);assert.equal(none.keyItemsTotal,null);
  assert.equal(performance("red",metricInputs({critical_items:["red"]})).accessibilityScore,null);
  assert.equal(performance("red",metricInputs({reference_transcript:"red"})).accessibilityScore,null);
});
test("critical items match complete phrases and reject simple contradictory negation",()=>{
  const input=metricInputs({critical_items:[{label:"Medicine",phrases:["aspirin"]},"cat"]});
  assert.equal(performance("not aspirin and a cattle field",input).keyItemsCaptured,0);
  assert.equal(performance("aspirin and a cat",input).keyItemsCaptured,2);
});
test("comparison refuses deltas for different audio or reference information",()=>{
  const input=metricInputs({reference_transcript:"red",critical_items:["red"]});
  const before={sampleId:"sample-01",useCase:{id:"sample-01"},requestedModel:"test",excerpt:{startOffset:0,length:15},audioHashes:{sourceSha256:"source",excerptPcmSha256:"pcm"},performance:performance("blue",input)};
  const after={...before,performance:performance("red",input)};
  assert.equal(comparison(before,after).deltas.accessibilityScore,100);
  assert.equal(comparison(before,{...after,audioHashes:{...after.audioHashes,sourceSha256:"changed"}}).deltas.accessibilityScore,null);
  assert.equal(comparison(before,{...after,performance:{...after.performance,referenceHash:"changed"}}).deltas.wordAccuracy,null);
});
