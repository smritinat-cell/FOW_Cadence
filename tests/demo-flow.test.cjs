const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const pair = require('../artifacts/speech-prompt-lab/comparison-results.json');
const { compare } = require('../artifacts/speech-prompt-lab/transcript-diff.js');
const code = fs.readFileSync(require.resolve('../artifacts/speech-prompt-lab/demo-flow.js'),'utf8');
const settle = async () => { for(let i=0;i<3;i++) await new Promise(resolve=>setImmediate(resolve)); };

test('the demo stages share saved text and Fix reveals the completed output without API calls', async()=>{
  const content={innerHTML:''}, requests=[], elements=new Map(), timers=[];
  const sandbox={URLSearchParams,location:{search:'?demo=1',hash:'#/simulation'},document:{
    getElementById(id){if(!elements.has(id))elements.set(id,{hidden:true,handlers:{},scrollIntoView(){},addEventListener(type,fn){this.handlers[type]=fn;}});return elements.get(id);},
    querySelector(){return {scrollIntoView(){}};}
  },async fetch(url){requests.push(url);assert.equal(url,'./comparison-results.json');return {ok:true,json:async()=>pair};}};
  sandbox.window={setTimeout(fn){timers.push(fn);},TranscriptDiff:{compare},CadenceComparison:{renderSaved(_,data,filename){assert.equal(data,pair);assert.equal(filename,'F_0101_10y4m_1.wav');content.innerHTML='Comparison';}}};
  vm.runInNewContext(code,sandbox);
  let saves=0;
  const demo=sandbox.window.CadenceDemoFlow,ctx={content,experiment:{selectedId:'sample-02'},samples:[{id:'sample-02',audio_filename:'F_0101_10y4m_1.wav'}],saveExperiment(){saves++;}};
  demo.render(ctx,'/simulation');await settle();
  assert.match(content.innerHTML,/Baseline response/);
  assert.match(content.innerHTML,/Nin Ten, Nin Ten/);
  assert.match(content.innerHTML,/F_0101_10y4m_1.wav/);
  assert.equal((content.innerHTML.match(/>Speech model [1-4]<\/option>/g)||[]).length,4);
  const editedPrompt='Keep the meaning.\n</textarea><script>example</script> & preserve lines.';
  assert.match(content.innerHTML,/<label[^>]+for="demo-system-prompt">System prompt used<\/label>/);
  elements.get('demo-system-prompt').handlers.input({currentTarget:{value:editedPrompt}});
  assert.equal(ctx.experiment.prompt,editedPrompt);
  assert.equal(saves,1);
  elements.get('model-select').handlers.change({currentTarget:{value:'demo-model-3'}});
  assert.equal(ctx.experiment.model,'demo-model-3');
  elements.get('demo-run-candidate').handlers.click();
  assert.match(content.innerHTML,/Running…/);
  timers.shift()();
  assert.match(content.innerHTML,/Your prompt response/);
  assert.match(content.innerHTML,/value="demo-model-3" selected/);
  assert.match(content.innerHTML,/Keep the meaning\.\n&lt;\/textarea&gt;&lt;script&gt;example&lt;\/script&gt; &amp; preserve lines\./);
  assert.equal(pair.old.prompt,'Transcribe the audio. Output only the transcript.');
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
