const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const pair = require('../artifacts/speech-prompt-lab/comparison-results.json');
const { compare } = require('../artifacts/speech-prompt-lab/transcript-diff.js');
const code = fs.readFileSync(require.resolve('../artifacts/speech-prompt-lab/demo-flow.js'),'utf8');
const settle = async () => { for(let i=0;i<3;i++) await new Promise(resolve=>setImmediate(resolve)); };

test('the demo stages share saved text and Fix reveals the completed output without API calls', async()=>{
  const content={innerHTML:''}, requests=[], elements=new Map();
  const sandbox={URLSearchParams,location:{search:'?demo=1',hash:'#/simulation'},document:{
    getElementById(id){if(!elements.has(id))elements.set(id,{hidden:true,handlers:{},addEventListener(type,fn){this.handlers[type]=fn;}});return elements.get(id);},
    querySelector(){return {scrollIntoView(){}};}
  },async fetch(url){requests.push(url);assert.equal(url,'./comparison-results.json');return {ok:true,json:async()=>pair};}};
  sandbox.window={TranscriptDiff:{compare},CadenceComparison:{renderSaved(_,data){assert.equal(data,pair);content.innerHTML='Comparison';}}};
  vm.runInNewContext(code,sandbox);
  const demo=sandbox.window.CadenceDemoFlow,ctx={content};
  demo.render(ctx,'/simulation');await settle();
  assert.match(content.innerHTML,/Baseline response/);
  assert.match(content.innerHTML,/Nin Ten, Nin Ten/);
  sandbox.location.hash='#/scorecard';demo.render(ctx,'/scorecard');await settle();
  assert.doesNotMatch(content.innerHTML,/Completed demo result/);
  elements.get('demo-fix').handlers.click();
  assert.match(content.innerHTML,/Completed demo result/);
  assert.match(content.innerHTML,/Nintendo sixty-four/);
  assert.match(content.innerHTML,/Produce a readable English transcript of the audio/);
  assert.match(content.innerHTML,/<strong>59<\/strong>/);
  sandbox.location.hash='#/comparison';demo.render(ctx,'/comparison');await settle();
  assert.equal(content.innerHTML,'Comparison');
  assert.deepEqual(requests,['./comparison-results.json']);
});
