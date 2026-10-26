import { executionInput,EXECUTION_PROTOCOL } from './execution-study.mjs';
import { marketContext } from './market-context.mjs';
import { candidateProbability,goalEvidence,STUDY_PROTOCOL } from './scenario-study.mjs';
import { PREDICTION_PROTOCOL,digest,directionInput,newScore,scoreOutcome,scoreView } from './prediction-protocol.mjs';
import { netRoundTrip } from './forecast-economics.mjs';
const iso=t=>new Date(t).toISOString();
export function advanceStudyDirections(previous,quotes,studies=[],now=Date.now(),options={}){
 if(!previous.intelligence)return previous;
 const state={...previous,intelligence:structuredClone(previous.intelligence)},r=state.intelligence;
 const namespace=options.namespace??'scenarioLive';r[namespace]??={pending:[],slots:{},metrics:{},lastTargets:{},startedAt:iso(now)};
 const live=r[namespace],waiting=[],outcomes=[],fresh=[],inputs={},seen=new Set();let metadataChanged=false;
 if(options.short&&studies.length){const next=new Date(Math.min(...studies.map(s=>Date.parse(s.recordedAt??iso(now))))+6*3600000).toISOString();metadataChanged=live.modelRefreshAt!==next;live.modelRefreshAt=next;}
 for(const [key,record] of Object.entries(live.metrics))if(namespace==='scenarioLive'&&!record.protocol){record.protocol='scenario-comparison-v1';const next=record.protocol+':'+key;live.metrics[next]=record;delete live.metrics[key];if(live.slots[key]!==undefined){live.slots[next]=live.slots[key];delete live.slots[key];}if(live.lastTargets[key]){live.lastTargets[next]=live.lastTargets[key];delete live.lastTargets[key];}}
 const cohortKey=p=>(p.protocolId??'scenario-comparison-v1')+':'+p.asset+':'+p.horizon;
 function score(p,result){
  const key=cohortKey(p),record=live.metrics[key]??={protocol:p.protocolId??'scenario-comparison-v1',stats:newScore(),asset:p.asset,horizon:p.horizon,horizonUnit:p.horizonUnit??'hours',buyIssued:0,buyResolved:0,buyKnown:0,sumNetPct:0,sumStressNetPct:0};
  if(p.probability>=.5)record.buyResolved++;
  scoreOutcome(record.stats,{probability:p.probability,baselines:p.baselines},result);
  if(p.reference){scoreOutcome(record.pairedStats??=newScore(),{probability:p.probability,baselines:p.baselines},result);scoreOutcome(record.referenceStats??=newScore(),{probability:p.reference.probability,baselines:p.baselines},result);}
  if(p.probability>=.5&&result.status==='scored'){record.buyKnown++;record.sumNetPct+=netRoundTrip(result.rawPct,p.asset);record.sumStressNetPct+=netRoundTrip(result.rawPct,p.asset,2);}
 }
 for(const p of live.pending){
  if(seen.has(p.id))continue;seen.add(p.id);
  const {recordHash,...packet}=p;if(digest(packet)!==recordHash){const invalid={status:'invalid-forecast',evaluatedAt:iso(now)};score(p,invalid);outcomes.push({...p,...invalid});continue;}
  const target=Date.parse(p.targetAt);if(now<target){waiting.push(p);continue;}
  const q=quotes[p.asset],at=Date.parse(q?.observedAt),valid=Number.isFinite(q?.price)&&q.price>0&&Number.isFinite(at)&&at<=now&&now-at<=PREDICTION_PROTOCOL.maxQuoteAgeMs&&at>=target&&at<=target+(p.maxEvaluationDelayMs??PREDICTION_PROTOCOL.maxEvaluationDelayMs)&&(q.source??'coingecko')===p.source;
  if(!valid){if(now<=target+(p.expiryDelayMs??PREDICTION_PROTOCOL.expiryDelayMs)){waiting.push(p);continue;}const result={status:'missing-price',evaluatedAt:iso(now)};score(p,result);outcomes.push({...p,...result});continue;}
  const rawPct=(q.price/p.price-1)*100,result={status:'scored',rawPct,actualPrice:q.price,actualObservedAt:q.observedAt,evaluatedAt:iso(now)};score(p,result);outcomes.push({...p,...result});
 }
 const open=new Set(waiting.map(cohortKey));
 for(const study of studies){const asset=study.asset,q=quotes[asset];if(!Object.hasOwn(state.config?.allocations??{},asset)||!q)continue;
  const at=Date.parse(q.observedAt);if(!Number.isFinite(q.price)||q.price<=0||!Number.isFinite(at)||at>now||now-at>120000)continue;
  const input=options.short?executionInput(asset,state.fast?.observations?.[asset]??[],q,now):directionInput(asset,state.portfolio[asset]?.observations??[],q,now);if(!input.ready)continue;
  const context=input.context??marketContext(input.points,input.technical,now);
  for(const [h,stored] of Object.entries(study.models??{})){
   const protocolId=study.protocol??options.protocolId??STUDY_PROTOCOL.id,horizon=Number(h),key=protocolId+':'+asset+':'+h,slot=Math.floor(now/(options.publicationMs??3600000)),{hash,datasetHash,selectedBefore,...model}=stored;
   if(!(options.horizons??[1,6,24]).includes(horizon)||model.trained<(options.minTrainingCases??30)||digest(model)!==hash||Date.parse(selectedBefore)>now||Date.parse(model.lastTrainingLabelAt)>now||open.has(key)||live.slots[key]===slot||at<Date.parse(live.lastTargets[key]??'1970-01-01'))continue;
   const probability=candidateProbability(model,{vector:input.vector,contextVector:context.vector,momentumUp:input.momentumUp,scenario:scenarioFor(input.technical)});if(!Number.isFinite(probability)||probability<0||probability>1)continue;
   const p={id:`scenario:${study.id}:${slot}:${asset}:${h}`,protocolId,asset,horizon,knownAt:iso(now),priceAt:q.observedAt,price:q.price,targetAt:iso(now+horizon*(options.unitMs??3600000)),probability,modelId:model.id,modelHash:hash,studyId:study.id,datasetHash,inputHash:input.hash,contextHash:digest({version:context.version,vector:context.vector}),baselines:{momentumUp:input.momentumUp},source:q.source??'coingecko'};
   if(options.short){p.horizonUnit='minutes';p.maxEvaluationDelayMs=EXECUTION_PROTOCOL.maxEvaluationDelayMs;p.expiryDelayMs=EXECUTION_PROTOCOL.expiryDelayMs;}
   const reference=r.latestDirectionalForecasts?.[asset]?.[options.short?horizon/60:h];
   if(reference?.knownAt===p.knownAt&&reference.targetAt===p.targetAt&&reference.priceAt===p.priceAt&&reference.price===p.price&&Number.isFinite(reference.probability))p.reference={id:reference.id,probability:reference.probability,modelHash:reference.modelHash};
   p.recordHash=digest(p);fresh.push(p);inputs[input.hash]={asset,points:input.points,vector:input.vector,contextVersion:context.version,contextVector:context.vector};if(protocolId===(options.protocolId??STUDY_PROTOCOL.id))(live.protocolAssets??={})[asset]=protocolId;live.slots[key]=slot;live.lastTargets[key]=p.targetAt;
   const record=live.metrics[key]??={protocol:protocolId,stats:newScore(),asset,horizon,horizonUnit:options.short?'minutes':'hours',buyIssued:0,buyResolved:0,buyKnown:0,sumNetPct:0,sumStressNetPct:0};record.stats.issued++;record.buyIssued+=Number(probability>=.5);if(p.reference){(record.pairedStats??=newScore()).issued++;(record.referenceStats??=newScore()).issued++;}
  }
 }
 if(!fresh.length&&!outcomes.length&&!metadataChanged)return previous;
 live.pending=[...waiting,...fresh];live.lastPublicationSlot=Math.floor(now/(options.publicationMs??3600000));live.updatedAt=iso(now);
 live.summary=Object.values(live.metrics).map(m=>{const metrics=scoreView(m.stats),economics={buyCases:m.buyKnown,buyCoverage:m.buyResolved?m.buyKnown/m.buyResolved:null,meanNetPct:m.buyKnown?m.sumNetPct/m.buyKnown:null,meanStressNetPct:m.buyKnown?m.sumStressNetPct/m.buyKnown:null};return {protocol:m.protocol,asset:m.asset,horizon:m.horizon,horizonUnit:m.horizonUnit??'hours',metrics,economics,paired:{challenger:scoreView(m.pairedStats??newScore()),reference:scoreView(m.referenceStats??newScore())},goal:goalEvidence(metrics,economics,{prospective:true})};});
 state.researchDelta={...(previous.researchDelta??{}),asOf:iso(now),[options.deltaKey??(options.short?'executionCycle':'scenarioCycle')]:{newPredictions:fresh,inputSnapshots:inputs,outcomes,note:'Campeões escolhidos na validação histórica; modelos imutáveis referenciados por studyId/modelHash. Todos os casos emitidos são contabilizados; não altera o índice direcional anterior.'}};
 return state;
}
function scenarioFor(t){return `${t.trendBps>20?'up':t.trendBps< -20?'down':'flat'}|${t.volatilityPct>.7?'high':t.volatilityPct>.2?'medium':'low'}|${t.rsi14<30?'oversold':t.rsi14>70?'overbought':'neutral'}`;}

export function advanceExecutionDirections(previous,quotes,models,now=Date.now()){
 return advanceStudyDirections(previous,quotes,models,now,{namespace:'executionLive',short:true,protocolId:EXECUTION_PROTOCOL.id,horizons:EXECUTION_PROTOCOL.horizons,unitMs:60000,publicationMs:EXECUTION_PROTOCOL.publicationMs,minTrainingCases:EXECUTION_PROTOCOL.minTrainingCases});
}
