const crypto = require("node:crypto");
const VERSION = "accessibility-1";
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function tokens(text) {
  return [...String(text || "").matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map(match=>({word:match[0].normalize("NFKC").toLowerCase().replaceAll("’","'"),start:match.index,end:match.index+match[0].length}));
}
function metricInputs(sample) {
  const referenceTranscript = typeof sample.reference_transcript === "string" ? sample.reference_transcript : "";
  const criticalItems = Array.isArray(sample.critical_items) ? structuredClone(sample.critical_items) : [];
  const reference = sample.reference;
  const referenceMetadata = reference && typeof reference === "object" ? {
    kind: reference.kind, policyVersion: reference.policyVersion, verified: reference.verified === true,
    sourceAudioSha256: reference.sourceAudioSha256,
    excerpt: reference.excerpt ? { startOffset: reference.excerpt.startOffset, length: reference.excerpt.length } : null,
    verifiedBy: reference.verifiedBy, verifiedAt: reference.verifiedAt,
    sourceUrl: reference.sourceUrl, sourceReferenceSha256: reference.sourceReferenceSha256,
  } : null;
  return {version:VERSION,referenceTranscript,criticalItems,referenceHash:hash(referenceTranscript),criticalItemsHash:hash(criticalItems),
    ...(referenceMetadata ? { referenceMetadata, referencePolicyHash: hash({ kind: referenceMetadata.kind,
      policyVersion: referenceMetadata.policyVersion, sourceAudioSha256: referenceMetadata.sourceAudioSha256,
      excerpt: referenceMetadata.excerpt }) } : {})};
}
function wordErrors(reference, actual) {
  const r=tokens(reference), a=tokens(actual);
  if(!r.length || r.length*a.length>20000000)return null;
  let previous=Array.from({length:a.length+1},(_,j)=>({cost:j,substitutions:0,deletions:0,insertions:j,first:j?0:-1}));
  for(let i=1;i<=r.length;i++){
    const current=[{cost:i,substitutions:0,deletions:i,insertions:0,first:0}];
    for(let j=1;j<=a.length;j++){
      const mismatch=Number(r[i-1].word!==a[j-1].word);
      const diagonal=previous[j-1].cost+mismatch, deletion=previous[j].cost+1, insertion=current[j-1].cost+1;
      let value;
      if(diagonal<=deletion&&diagonal<=insertion){value={...previous[j-1],cost:diagonal};value.substitutions+=mismatch;if(mismatch&&value.first<0)value.first=j-1;}
      else if(deletion<=insertion){value={...previous[j],cost:deletion,deletions:previous[j].deletions+1};if(value.first<0)value.first=Math.max(0,j-1);}
      else{value={...current[j-1],cost:insertion,insertions:current[j-1].insertions+1};if(value.first<0)value.first=j-1;}
      current.push(value);
    }
    previous=current;
  }
  const last=previous[a.length], index=last.first;
  const quote=index>=0&&a.length?String(actual).slice(a[Math.max(0,index-2)].start,a[Math.min(a.length-1,index+4)].end):"";
  return {referenceWords:r.length,actualWords:a.length,errors:last.cost,substitutions:last.substitutions,deletions:last.deletions,insertions:last.insertions,accuracy:Math.max(0,100*(1-last.cost/r.length)),failureQuote:quote};
}
function itemDefinition(item,index){
  if(typeof item==="string"&&item.trim())return {id:`item-${index+1}`,label:item,phrases:[item]};
  if(!item||typeof item!=="object")return null;
  const expected=item.phrases||item.variants||item.expected_text||item.expected||item.value||item.text;
  const phrases=(Array.isArray(expected)?expected:[expected]).filter(value=>typeof value==="string"&&value.trim());
  return phrases.length?{id:String(item.id||`item-${index+1}`),label:String(item.label||item.name||phrases[0]),phrases}:null;
}
function performance(transcript,inputs){
  const words=tokens(transcript).map(token=>token.word), text=` ${words.join(" ")} `;
  const definitions=inputs.criticalItems.map(itemDefinition);
  const items=definitions.length&&definitions.every(Boolean)?definitions.map(item=>({...item,captured:item.phrases.some(phrase=>{
    const pattern=tokens(phrase).map(token=>token.word).join(" ");if(!pattern)return false;
    let position=text.indexOf(` ${pattern} `);
    while(position>=0){
      const preceding=text.slice(0,position).trim().split(/\s+/).slice(-3).join(" ");
      if(/^(?:no|not|never|without)\b/.test(pattern)||!/\b(?:no|not|never|without)\b/.test(preceding))return true;
      position=text.indexOf(` ${pattern} `,position+1);
    }
    return false;
  })})):null;
  const captured=items?items.filter(item=>item.captured).length:null;
  const keyPercent=items?100*captured/items.length:null;
  const error=wordErrors(inputs.referenceTranscript,transcript);
  const accuracy=error?error.accuracy:null;
  return {
    version:VERSION,accessibilityScore:keyPercent!==null&&accuracy!==null?Math.round((keyPercent+accuracy)/2):null,
    keyItemsCaptured:captured,keyItemsTotal:items?.length??null,keyItemsPercent:keyPercent===null?null:Math.round(keyPercent),
    wordAccuracy:accuracy===null?null:Math.round(accuracy),items,
    outcome:items?(captured===items.length?"All key items captured":"Some key items missed"):null,
    failureQuote:error?.failureQuote||"",details:error?{...error,accuracy:undefined}:null,
    referenceHash:inputs.referenceHash,criticalItemsHash:inputs.criticalItemsHash,
    ...(inputs.referenceMetadata ? { referenceMetadata: structuredClone(inputs.referenceMetadata), referencePolicyHash: inputs.referencePolicyHash } : {}),
    unavailableReason:"Not enough information to score this yet",
  };
}
function sameAudio(a,b){
  if(!a||!b||!a.audioHashes?.sourceSha256||!a.audioHashes?.excerptPcmSha256)return false;
  return a.sampleId===b.sampleId&&a.useCase?.id===b.useCase?.id&&a.requestedModel===b.requestedModel
    &&a.excerpt?.startOffset===b.excerpt?.startOffset&&a.excerpt?.length===b.excerpt?.length
    &&a.audioHashes.sourceSha256===b.audioHashes?.sourceSha256&&a.audioHashes.excerptPcmSha256===b.audioHashes?.excerptPcmSha256;
}
function themeChanges(before,after){
  if(!before?.parsedResult||!after?.parsedResult||before.rubric_version!==after.rubric_version||before.useCase?.id!==after.useCase?.id)return {themes:[],issuesFixed:null};
  const themes=(before.rubric?.themes||[]).map(theme=>{
    const old=(before.parsedResult.findings||[]).filter(f=>f.verified&&f.theme===theme.id);
    const next=(after.parsedResult.findings||[]).filter(f=>f.verified&&f.theme===theme.id);
    const assessed=(after.parsedResult.parameters||[]).some(p=>p.theme===theme.id&&p.observed);
    const points=review=>(review.computedScores?.penalties||[]).filter(p=>p.theme===theme.id).reduce((sum,p)=>sum+(p.penaltyHundredths||0),0);
    return {id:theme.id,label:theme.label,beforeCount:old.length,afterCount:assessed?next.length:null,
      status:!assessed?"Not enough information yet":!next.length?(old.length?"Fixed":"No issues found"):next.length<old.length||points(after)<points(before)?"Improved":"Still failing",
      worsened:assessed&&(points(after)>points(before)||next.length>old.length)};
  });
  return {themes,issuesFixed:themes.some(t=>t.afterCount!==null)?themes.reduce((sum,t)=>sum+(t.afterCount===null?0:Math.max(0,t.beforeCount-t.afterCount)),0):null};
}
function comparison(before,after,beforeReview,afterReview){
  const comparable=sameAudio(before,after)&&before.performance?.version===after.performance?.version
    &&before.performance?.referenceHash===after.performance?.referenceHash&&before.performance?.criticalItemsHash===after.performance?.criticalItemsHash
    &&before.performance?.referencePolicyHash===after.performance?.referencePolicyHash;
  const changes=themeChanges(beforeReview,afterReview);
  const delta=field=>comparable&&typeof before.performance?.[field]==="number"&&typeof after.performance?.[field]==="number"?after.performance[field]-before.performance[field]:null;
  return {comparable,before,after,...changes,deltas:{accessibilityScore:delta("accessibilityScore"),keyItemsCaptured:delta("keyItemsCaptured"),wordAccuracy:delta("wordAccuracy")}};
}
module.exports={VERSION,tokens,metricInputs,wordErrors,performance,sameAudio,themeChanges,comparison};
