const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const modeCode = fs.readFileSync(require.resolve('../artifacts/speech-prompt-lab/mode-control.js'), 'utf8');
const liveCode = fs.readFileSync(require.resolve('../artifacts/speech-prompt-lab/live-flow.js'), 'utf8');
const appCode = fs.readFileSync(require.resolve('../artifacts/speech-prompt-lab/app.js'), 'utf8');
const preset = require('../config/transcript-improvement.json');
const settle = async () => { for (let i=0;i<4;i++) await new Promise(resolve => setImmediate(resolve)); };

function controls() {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id,{id,value:'',handlers:{},hidden:true,disabled:false,setAttribute(){},addEventListener(kind,handler){this.handlers[kind]=handler;},showModal(){this.open=true;},close(){this.open=false;}}); return elements.get(id); };
  return { elements, get };
}
test('saved is default; private mode opens after five deliberate activations without extra credentials', async () => {
  const {get} = controls(), stored = new Map(), requests = [];
  let now = 0, reloads = 0;
  const logo=get('logo'), panel=get('panel');
  const sandbox={Date:{now:()=>now},sessionStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)},location:{reload(){reloads++;}},document:{readyState:'complete',querySelector:()=>logo,getElementById:get,createElement:()=>panel,body:{appendChild(){}}},async fetch(url,options){requests.push({url,body:JSON.parse(options.body)});return {ok:true};},window:{}};
  vm.runInNewContext(modeCode,sandbox);
  assert.equal(sandbox.window.CadenceMode.mode,'saved');
  assert.equal(sandbox.window.CadenceMode.storageKey('experiment'),'speech-prompt-lab-experiment-v1');
  assert.equal(sandbox.window.CadenceMode.storageKey('progress'),'cadence-saved-progress-v1');
  for(let i=0;i<4;i++) logo.handlers.click();
  assert.equal(panel.open,undefined);
  now=3100;logo.handlers.click();
  assert.equal(panel.open,undefined);
  for(let i=0;i<4;i++) logo.handlers.keydown({key:'Enter',preventDefault(){}});
  assert.equal(panel.open,true);
  assert.equal(requests.length,0);
  assert.doesNotMatch(panel.innerHTML,/Access code|cadence-unlock|live\/session/);
  get('cadence-use-live').handlers.click();
  assert.equal(stored.get('cadence-tab-mode-v1'),'live');
  assert.equal(reloads,1);
  const liveSandbox={...sandbox,window:{}};vm.runInNewContext(modeCode,liveSandbox);
  assert.equal(liveSandbox.window.CadenceMode.live,true);
  assert.equal(liveSandbox.window.CadenceMode.storageKey('experiment'),'cadence-live-experiment-v1');
  assert.equal(liveSandbox.window.CadenceMode.storageKey('progress'),'cadence-live-progress-v1');
});

test('visible Demo / Live switch changes modes and preserves their separate storage',()=>{
  const {get}=controls(),stored=new Map();let reloads=0;
  const sandbox={Date,sessionStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)},location:{reload(){reloads++;}},document:{readyState:'complete',getElementById:get,querySelector:()=>null},window:{}};
  vm.runInNewContext(modeCode,sandbox);
  get('cadence-mode-toggle').handlers.click();
  assert.equal(stored.get('cadence-tab-mode-v1'),'live');assert.equal(reloads,1);
  const live={...sandbox,window:{}};vm.runInNewContext(modeCode,live);
  assert.equal(live.window.CadenceMode.mode,'live');
  assert.equal(live.window.CadenceMode.storageKey('experiment'),'cadence-live-experiment-v1');
  get('cadence-mode-toggle').handlers.click();
  assert.equal(stored.get('cadence-tab-mode-v1'),'saved');assert.equal(reloads,2);
  assert.match(fs.readFileSync(require.resolve('../artifacts/speech-prompt-lab/index.html'),'utf8'),/id="cadence-mode-toggle"[^>]*role="switch"[^>]*aria-label="Live evaluation"/);
});

function liveHarness(options = {}) {
  const {get} = controls(), requests=[], timers=[], comparisons=[], storage=new Map();
  if (options.progress) storage.set('cadence-live-progress-v1',JSON.stringify(options.progress));
  const current={id:'current-before',kind:'baseline',status:'finished',sampleId:'sample-01',requestedModel:'real-model',rawOutput:'Original actual response.',promptUsed:'Transcribe the audio. Output only the transcript.',recording:{fileName:'current.wav'},excerpt:{startOffset:0,length:15},performance:{accessibilityScore:options.unscored?null:40},speechGuidance:options.guidance,speechPatterns:options.patterns};
  const oldBefore={...current,id:'past-before',sampleId:'sample-03',recording:{fileName:'past.wav'},excerpt:{startOffset:0,length:133.7469375},rawOutput:'Past original.',performance:{accessibilityScore:62}};
  const oldAfter={...oldBefore,id:'past-after',kind:'candidate',rawOutput:'Past improved.',performance:{accessibilityScore:78}};
  const historical={id:'past',comparable:true,before:oldBefore,after:oldAfter};
  const prepared={id:'prepared',prepared:true,before:current,review:{id:'review',verifiedFindings:[],suggestedPrompt:preset.prompt,...options.review}};
  let active=null, complete=false;
  const resultNode={dataset:{},classList:{add(){}},unscoredRemoved:[]};
  const content={innerHTML:'',insertAdjacentHTML(_,html){this.innerHTML=html+this.innerHTML;},querySelector(selector){return selector==='.compare-live-results'?resultNode:selector.includes('.compare-result-score')?{remove(){resultNode.unscoredRemoved.push(selector);}}:null;}};
  let models=options.emptyModels?[]:[{id:'real-model'}];
  const status=()=>({authorized:true,configured:true,canRun:!active||complete,models,preferred:'real-model',promptPreset:preset,prepared:[{sampleId:'sample-01',ready:!options.preparation||complete,model:'real-model',pairId:'prepared'}],running:active&&!complete?active:null});
  const after=()=>({...current,id:'new-run',kind:'candidate',workflow:'recording-comparison',status:'finished',rawOutput:'New improved.',sandbox:{beforeRunId:current.id},performance:{accessibilityScore:options.unscored?null:options.afterScore??80}});
  const sandbox={URLSearchParams,sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},location:{hash:'#/simulation'},document:{getElementById:id=>content.innerHTML.includes(`id="${id}"`)?get(id):null},async fetch(url,requestOptions){const method=requestOptions?.method||'GET';const body=requestOptions?.body?JSON.parse(requestOptions.body):undefined;requests.push({url,method,body});let data;
    if(url==='/api/live/status')data=status();
    else if(url==='/api/live/previous-runs'){if(options.historyUnavailable)throw new Error('Previous runs service is unavailable');data={runs:options.emptyPreparedHistory?[]:[prepared],historicalRuns:[historical]};}
    else if(url==='./live-prepared-history.json')data={pairs:[historical]};
    else if(url==='/api/live/models'){models=[{id:'real-model'}];data={models,preferred:'real-model'};}
    else if(url==='/api/live/adopt')data={...prepared,pairId:'prepared',proposedPrompt:preset.prompt};
    else if(url==='/api/live/baseline'){complete=false;active={id:'current-before',kind:'baseline',status:'streaming',workflow:'recording-comparison'};data={job:active};}
    else if(url==='/api/jobs/current-before'){complete=true;data=current;}
    else if(url==='/api/runs'){complete=false;active={id:'new-run',kind:'candidate',status:'streaming',workflow:'recording-comparison',sandbox:{beforeRunId:current.id}};data=active;}
    else if(url==='/api/live/prepare'){active={id:'prep',kind:'preparation',status:'preparing',rawOutput:''};data={job:active};}
    else if(url==='/api/jobs/prep'){complete=true;data={...active,status:options.preparationFails?'failed':'finished',packId:'prepared',rawOutput:'',...(options.preparationFails?{error:{message:'Preparation service failed.'}}:{})};}
    else if(url==='/api/jobs/new-run/stop')data={...active,status:'stopping'};
    else if(url==='/api/jobs/new-run'){complete=true;data=after();}
    else if(url.startsWith('/api/comparisons?'))data={comparison:{comparable:true,before:current,after:after()}};
    else throw new Error(`Unexpected request ${url}`);
    return {ok:true,json:async()=>data};
  },window:{CadenceMode:{live:true,storageKey:kind=>`cadence-live-${kind}-v1`},setTimeout(fn){timers.push(fn);return timers.length;},CadenceSimulation:{scorecardMarkup:{performance:run=>`<section>Accessibility ${run.performance?.accessibilityScore}</section>`,finding:()=>'',edits:()=>'',promptDiff:()=>'<div>Exact proposed prompt</div>'}},CadenceComparison:{renderSaved(ctx,pair,filename){comparisons.push({pair,filename});ctx.content.innerHTML=`<h1>Results Summary</h1><p>${filename}</p>`;}}}};
  if (options.enhanced) Object.assign(sandbox.window.CadenceSimulation.scorecardMarkup,{
    groupedFindings:findings=>`<div>Grouped findings ${findings.map(item=>item.quote).join('|')}</div>`,
    speechPatterns:run=>`<section>Speech patterns in this recording ${run.speechPatterns?.patterns?.map(item=>item.label).join('|')||''}</section>`,
    enhancedEdits:(_,edits)=>`<section>Supported edits ${edits.map(item=>item.new_text).join('|')}</section>`,
    promptDiff:diff=>`<div>Exact proposed prompt ${JSON.stringify(diff)}</div>`
  });
  if (options.richComparison) sandbox.window.CadenceComparison.renderCompleted=(ctx,comparison,config)=>{
    comparisons.push({comparison,filename:comparison.before.recording.fileName});
    ctx.content.innerHTML='<h1>Results Summary</h1><div>Rich comparison and prompt changes</div>';
    config.onRendered();
  };
  vm.runInNewContext(liveCode,sandbox);
  const api=sandbox.window.CadenceLiveFlow,ctx={content,experiment:{selectedId:'sample-01',model:'real-model'},samples:[{id:'sample-01',audio_filename:'current.wav'}],saveExperiment(){}};
  return {api,ctx,sandbox,requests,timers,comparisons,get,content,preset,historical,resultNode};
}
test('live navigation reads only; adopting cached baseline starts no paid call, then explicit Test starts one', async()=>{
  const h=liveHarness();h.api.render(h.ctx,'/simulation');await settle();
  assert.ok(h.requests.every(item=>item.method==='GET'));
  assert.match(h.content.innerHTML,/Previous runs/);
  await h.get('live-load-baseline').handlers.click();
  assert.equal(h.requests.filter(item=>item.url==='/api/runs').length,0);
  h.sandbox.location.hash='#/scorecard';h.api.render(h.ctx,'/scorecard');
  assert.match(h.content.innerHTML,/Accessibility 40/);
  await h.get('live-test-changes').handlers.click();
  assert.equal(h.requests.filter(item=>item.url==='/api/runs').length,1);
  const payload=h.requests.find(item=>item.url==='/api/runs').body;
  assert.equal(payload.workflow,'recording-comparison');
  assert.equal(payload.beforeRunId,'current-before');
  assert.equal(payload.promptPreset,'readable-transcript-v1');
  assert.equal(payload.currentPrompt,'Transcribe the audio. Output only the transcript.');
  await h.timers.shift()();await settle();
  assert.equal(h.sandbox.location.hash,'#/comparison');
  assert.equal(h.comparisons.at(-1).pair.old.performance.accessibilityScore,40);
  assert.equal(h.comparisons.at(-1).pair.new.performance.accessibilityScore,80);
  assert.equal(h.comparisons.at(-1).pair.old.demoPerformance,undefined);
  assert.equal(h.resultNode.dataset.scoreChange,'positive');
});
test('Stop & use opens historical full pair after acknowledgment, holds new-run lock until terminal, and completion keeps it selected', async()=>{
  const h=liveHarness();h.api.render(h.ctx,'/simulation');await settle();
  await h.get('live-load-baseline').handlers.click();
  h.sandbox.location.hash='#/scorecard';h.api.render(h.ctx,'/scorecard');
  await h.get('live-test-changes').handlers.click();
  h.get('live-previous-run').handlers.change({currentTarget:{value:'past'}});
  assert.match(h.content.innerHTML,/Stop &amp; use|Stop & use/);
  await h.get('live-use-previous').handlers.click();
  assert.equal(h.api.isBusy(),true);
  assert.equal(h.sandbox.location.hash,'#/comparison');
  assert.equal(h.comparisons.at(-1).filename,'past.wav');
  assert.equal(h.comparisons.at(-1).pair.old.performance.accessibilityScore,62);
  assert.match(h.content.innerHTML,/0–133.7 sec/);
  assert.doesNotMatch(h.content.innerHTML,/133.7469375/);
  assert.equal(h.historical.before.excerpt.length,133.7469375);
  await h.timers.shift()();await settle();
  assert.equal(h.api.isBusy(),false);
  assert.equal(h.comparisons.at(-1).filename,'past.wav');
  assert.equal(h.comparisons.at(-1).pair.new.performance.accessibilityScore,78);
  assert.equal(h.requests.filter(item=>item.url==='/api/runs').length,1);
});
test('live model options are loaded explicitly and preparation completion is successful without a transcript', async()=>{
  const h=liveHarness({emptyModels:true,preparation:true});h.api.render(h.ctx,'/simulation');await settle();
  assert.equal(h.requests.some(item=>item.url==='/api/live/models'),false);
  assert.equal(h.requests.some(item=>item.method==='POST'),false);
  await h.get('live-load-models').handlers.click();
  assert.equal(h.requests.filter(item=>item.url==='/api/live/models').length,1);
  await h.get('live-prepare').handlers.click();
  assert.equal(h.api.isBusy(),true);
  await h.timers.shift()();await settle();
  assert.equal(h.api.isBusy(),false);
  assert.match(h.content.innerHTML,/Baseline prepared/);
  assert.doesNotMatch(h.content.innerHTML,/did not complete|role="alert"/);
  assert.equal(h.requests.some(item=>item.url.startsWith('/api/comparisons')),false);
});
test('changing clip or model invalidates an adopted Scorecard and stale Test handler starts no run', async()=>{
  const h=liveHarness();h.api.render(h.ctx,'/simulation');await settle();
  await h.get('live-load-baseline').handlers.click();
  h.sandbox.location.hash='#/scorecard';h.api.render(h.ctx,'/scorecard');
  const staleTest=h.get('live-test-changes').handlers.click;
  h.ctx.experiment.selectedId='sample-02';h.api.render(h.ctx,'/scorecard');
  assert.match(h.content.innerHTML,/Run a baseline for the selected recording and model/);
  assert.doesNotMatch(h.content.innerHTML,/id="live-test-changes"/);
  await staleTest();
  h.ctx.experiment.selectedId='sample-01';h.ctx.experiment.model='another-real-model';
  h.api.render(h.ctx,'/scorecard');await staleTest();
  assert.equal(h.requests.some(item=>item.url==='/api/runs'),false);
});
test('fresh live baseline and preset test make exactly two inference requests without a review or preparation', async()=>{
  const h=liveHarness({unscored:true});h.api.render(h.ctx,'/simulation');await settle();
  await h.get('live-run-baseline').handlers.click();
  assert.deepEqual(h.requests.find(item=>item.url==='/api/live/baseline').body,{sampleId:'sample-01',model:'real-model'});
  await h.timers.shift()();await settle();
  assert.equal(h.sandbox.location.hash,'#/scorecard');
  assert.match(h.content.innerHTML,/Original actual response/);
  assert.match(h.content.innerHTML,/Exact proposed prompt/);
  assert.doesNotMatch(h.content.innerHTML,/Accessibility null|Not enough information/);
  await h.get('live-test-changes').handlers.click();
  const candidate=h.requests.find(item=>item.url==='/api/runs').body;
  assert.equal(candidate.sandboxEvaluationId,undefined);
  assert.equal(candidate.beforeRunId,'current-before');
  assert.equal(candidate.promptPreset,'readable-transcript-v1');
  await h.timers.shift()();await settle();
  assert.equal(h.sandbox.location.hash,'#/comparison');
  assert.equal(h.comparisons.at(-1).pair.old.performance.accessibilityScore,null);
  assert.ok(h.resultNode.unscoredRemoved.includes('.compare-panel.old .compare-result-score'));
  assert.ok(h.resultNode.unscoredRemoved.includes('.compare-panel.new .compare-result-score'));
  assert.equal(h.requests.filter(item=>item.method==='POST').length,2);
  assert.equal(h.requests.some(item=>item.url.includes('/evaluation')||item.url==='/api/live/prepare'),false);
});
test('preparation failure remains visible after status and previous-run refresh', async()=>{
  const h=liveHarness({preparation:true,preparationFails:true});h.api.render(h.ctx,'/simulation');await settle();
  await h.get('live-prepare').handlers.click();await h.timers.shift()();await settle();
  assert.match(h.content.innerHTML,/Preparation service failed/);
  assert.equal(h.api.isBusy(),false);
});
test('unscored live baseline keeps speech evidence and exact preset guidance without an evaluator call', async()=>{
  const instruction=preset.prompt.split('\r\n\r\n').find(value=>value.startsWith('Remove hesitation fillers'));
  const h=liveHarness({unscored:true,enhanced:true,patterns:{patterns:[{label:'Word repetitions'}]},guidance:{findings:[{id:'observed-1',quote:'Original actual response.',verified:true,speechPattern:'Word repetitions'}],edits:[{id:'edit-1',new_text:instruction}]}});
  h.api.render(h.ctx,'/simulation');await settle();
  await h.get('live-run-baseline').handlers.click();await h.timers.shift()();await settle();
  assert.match(h.content.innerHTML,/Add a reference transcript to score this recording/);
  assert.match(h.content.innerHTML,/Speech patterns in this recording Word repetitions/);
  assert.match(h.content.innerHTML,/Grouped findings Original actual response/);
  assert.ok(h.content.innerHTML.includes(instruction));
  assert.doesNotMatch(h.content.innerHTML,/Accessibility null/);
  assert.equal(h.requests.some(item=>item.url.includes('/evaluation')),false);
});
test('prepared review cannot change the exact prompt preview used by the live preset test', async()=>{
  const h=liveHarness({enhanced:true,review:{suggestedPrompt:'A different evaluator suggestion',diff:[{type:'added',text:'A different evaluator suggestion'}],promptUpdates:[{new_text:'A different evaluator suggestion'}]}});
  h.api.render(h.ctx,'/simulation');await settle();await h.get('live-load-baseline').handlers.click();
  h.sandbox.location.hash='#/scorecard';h.api.render(h.ctx,'/scorecard');
  assert.ok(h.content.innerHTML.includes(JSON.stringify(preset.prompt)));
  assert.doesNotMatch(h.content.innerHTML,/A different evaluator suggestion/);
  await h.get('live-test-changes').handlers.click();
  assert.equal(h.requests.find(item=>item.url==='/api/runs').body.promptPreset,preset.id);
});
test('rich live summary receives raw completed runs and real deltas and retains previous-run controls', async()=>{
  const h=liveHarness({richComparison:true,afterScore:20});h.api.render(h.ctx,'/simulation');await settle();
  await h.get('live-load-baseline').handlers.click();h.sandbox.location.hash='#/scorecard';h.api.render(h.ctx,'/scorecard');
  await h.get('live-test-changes').handlers.click();await h.timers.shift()();await settle();
  const {comparison}=h.comparisons.at(-1);
  assert.equal(comparison.before.rawOutput,'Original actual response.');
  assert.equal(comparison.after.rawOutput,'New improved.');
  assert.equal(comparison.deltas.accessibilityScore,-20);
  assert.equal(comparison.deltas.wordAccuracy,null);
  assert.match(h.content.innerHTML,/Previous runs/);
  assert.equal(h.resultNode.dataset.scoreChange,'negative');
  assert.equal(h.requests.filter(item=>item.method==='POST').length,2);
});
test('revisiting live restores its own completed baseline through a read request', async()=>{
  const h=liveHarness({emptyPreparedHistory:true,progress:{baselineId:'current-before'}});
  h.sandbox.location.hash='#/scorecard';h.api.render(h.ctx,'/scorecard');await settle();
  assert.match(h.content.innerHTML,/Accessibility 40/);
  assert.equal(h.requests.filter(item=>item.url==='/api/jobs/current-before').length,1);
  assert.ok(h.requests.every(item=>item.method==='GET'));
});
test('previous actual runs remain available when the live history service cannot respond',async()=>{
  const h=liveHarness({historyUnavailable:true});h.api.render(h.ctx,'/simulation');await settle();
  assert.ok(h.requests.some(item=>item.url==='./live-prepared-history.json'));
  assert.match(h.content.innerHTML,/past.wav/);
  h.get('live-previous-run').handlers.change({currentTarget:{value:'past'}});
  await h.get('live-use-previous').handlers.click();
  assert.equal(h.comparisons.at(-1).pair.old.text,'Past original.');
  assert.equal(h.comparisons.at(-1).pair.new.text,'Past improved.');
  assert.ok(h.requests.every(item=>item.method==='GET'));
});
test('live results mark negative and unchanged actual scores without coloring them as an improvement', async()=>{
  for(const [afterScore,direction] of [[20,'negative'],[40,'neutral']]) {
    const h=liveHarness({afterScore});h.api.render(h.ctx,'/simulation');await settle();
    await h.get('live-load-baseline').handlers.click();
    h.sandbox.location.hash='#/scorecard';h.api.render(h.ctx,'/scorecard');
    await h.get('live-test-changes').handlers.click();await h.timers.shift()();await settle();
    assert.equal(h.resultNode.dataset.scoreChange,direction);
    assert.equal(h.comparisons.at(-1).pair.new.performance.accessibilityScore,afterScore);
  }
});
test('live setup uses server transcription metadata instead of clinical sample defaults', async()=>{
  const {get}=controls(), requests=[];
  const content=get('app-content');
  const legacy={id:'sample-01',title:'Stuttering',agent_name:'Clinical intake agent',agent_purpose:'Collect symptoms and medication',system_prompt:'Clinical prompt',reference_material:'Medication list',use_case_label:'Clinical intake',audio_url:'/audio.wav',audio_filename:'current.wav',duration_seconds:120};
  const clip={sampleId:'sample-01',title:'Stuttering and repetitions',filename:'current.wav',audioSrc:'/audio.wav',context:{agentName:'Cadence recording transcription',purpose:'Preserve substantive speech.',speechProfileTags:['Stuttering']},useCase:{label:'Accessible recording transcription',summary:'Compare the same recording before and after the prompt improvement.'}};
  const status={clips:[clip,{...clip,sampleId:'sample-02',title:'Slower speech'},{...clip,sampleId:'sample-03',title:'Longer pauses'}]};
  const sandbox={localStorage:{getItem:()=>JSON.stringify({selectedId:'sample-01',agentName:'Clinical intake agent',purpose:'Collect symptoms',reference:'Medication list'}),setItem(){}},location:{hash:'#/setup'},document:{getElementById:get,querySelectorAll:()=>[],querySelector:()=>null},fetch:async url=>{requests.push(url);if(url==='/api/demo-samples')return {ok:true,json:async()=>[legacy]};if(url==='/api/live/status')return {ok:true,json:async()=>status};throw new Error('Preview unavailable');},window:{CadenceMode:{live:true,storageKey:()=> 'cadence-live-experiment-v1'},setTimeout(){},clearTimeout(){},addEventListener(){}}};
  vm.runInNewContext(appCode,sandbox);await settle();
  const options=content.innerHTML.match(/<select id="use-case-select"[\s\S]*?<\/select>/)?.[0];
  assert.match(options,/>Stuttering and repetitions<\/option>/);
  assert.match(options,/>Slower speech<\/option>/);
  assert.match(options,/>Longer pauses<\/option>/);
  assert.doesNotMatch(options,/>Accessible recording transcription<\/option>/);
  assert.match(content.innerHTML,/Cadence recording transcription/);
  assert.doesNotMatch(content.innerHTML,/Clinical intake|Collect symptoms|Medication list|Clinical prompt/);
  assert.match(content.innerHTML,/id="start-offset" disabled/);
  assert.match(content.innerHTML,/id="prompt-input" readonly/);
  assert.ok(requests.every(url=>!url.includes('/api/runs')&&!url.includes('/api/live/models')));
});
