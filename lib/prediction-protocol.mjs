import { createHash } from 'node:crypto';
import { indicators, featureVector, FEATURE_NAMES } from './indicators.mjs';
export const PREDICTION_PROTOCOL=Object.freeze({id:'direction-audit-v2',featureVersion:'hourly-observation-vector-v2',horizons:[1,6,24],publicationMinutes:60,evaluation:'first fresh quote observed at or after target',maxQuoteAgeMs:120000,maxEvaluationDelayMs:300000,expiryDelayMs:600000,headline:'non-overlapping intervals per asset/horizon, chosen before outcome',tiePolicy:'excluded from binary probability scores; counted as incorrect in headline accuracy',algorithm:'online-logistic-v1',onlineTraining:'only evaluated primary forecasts; legacy and overlapping diagnostics do not update coefficients',learningRate:.03,l2:.001,weightClip:5,logitClip:20});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
export const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function directionInput(id,observations,quote,knownAt){
 const hourly=new Map();
 for(const p of [...observations,{at:new Date(knownAt).toISOString(),observedAt:quote.observedAt,price:quote.price}]){
  const at=Date.parse(p.at),observed=Date.parse(p.observedAt??p.at);
  if(!Number.isFinite(at)||!Number.isFinite(observed)||at>knownAt||observed>knownAt||!Number.isFinite(p.price)||p.price<=0)continue;
  const slot=Math.floor(at/3600000),old=hourly.get(slot);if(!old||at>=Date.parse(old.at))hourly.set(slot,{at:p.at,observedAt:p.observedAt??p.at,price:p.price});
 }
 const points=[...hourly.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-72),technical=indicators(points);
 const vector=featureVector(id,technical,{available:false,count:0,score:0},null);
 return {points,technical,vector,ready:technical.continuous&&vector.every(Number.isFinite),hash:digest({featureVersion:PREDICTION_PROTOCOL.featureVersion,points,vector}),momentumUp:points.length>1?points.at(-1).price>=points.at(-2).price:true};
}
export const newScore=()=>({issued:0,valid:0,directional:0,correct:0,flat:0,missing:0,tp:0,tn:0,fp:0,fn:0,upFlat:0,downFlat:0,brierSum:0,logLossSum:0,alwaysUpCorrect:0,momentumCorrect:0,calibration:Array.from({length:10},()=>({n:0,pSum:0,up:0}))});
export function scoreOutcome(stats,p,result){
 if(result.status!=='scored'){stats.missing++;return;}
 stats.valid++;const up=result.rawPct>0,flat=result.rawPct===0,predicted=p.probability>=.5;
 if(flat){stats.flat++;stats[predicted?'upFlat':'downFlat']++;return;}
 stats.directional++;const correct=predicted===up;stats.correct+=Number(correct);stats[predicted?(up?'tp':'fp'):(up?'fn':'tn')]++;
 stats.alwaysUpCorrect+=Number(up);stats.momentumCorrect+=Number((p.baselines?.momentumUp??true)===up);
 const probability=Math.max(1e-9,Math.min(1-1e-9,p.probability));stats.brierSum+=(probability-Number(up))**2;stats.logLossSum-=up?Math.log(probability):Math.log(1-probability);
 const bin=stats.calibration[Math.min(9,Math.floor(probability*10))];bin.n++;bin.pSum+=probability;bin.up+=Number(up);
}
export function scoreView(stats){
 const brier=stats.directional?stats.brierSum/stats.directional:null,upN=stats.tp+stats.fn,downN=stats.tn+stats.fp;
 return {...stats,pending:Math.max(0,stats.issued-stats.valid-stats.missing),accuracy:stats.valid?stats.correct/stats.valid:null,binaryAccuracy:stats.directional?stats.correct/stats.directional:null,balancedAccuracy:upN&&downN?(stats.tp/upN+stats.tn/downN)/2:null,brier,brierSkill:brier==null?null:1-brier/.25,logLoss:stats.directional?stats.logLossSum/stats.directional:null,coverage:stats.valid+stats.missing?stats.valid/(stats.valid+stats.missing):null,alwaysUpAccuracy:stats.valid?stats.alwaysUpCorrect/stats.valid:null,alwaysDownAccuracy:stats.valid?downN/stats.valid:null,momentumAccuracy:stats.valid?stats.momentumCorrect/stats.valid:null,calibration:stats.calibration.map(b=>({...b,meanProbability:b.n?b.pSum/b.n:null,observedUpRate:b.n?b.up/b.n:null}))};
}
export function newEvaluation(previousMetrics,now){return {protocol:PREDICTION_PROTOCOL,startedAt:new Date(now).toISOString(),legacy:{asOf:new Date(now).toISOString(),initialMetrics:structuredClone(previousMetrics??{}),metrics:structuredClone(previousMetrics??{}),warning:'Medição anterior permitia preços anteriores ao horizonte e previsões sobrepostas; não comparar diretamente com o novo protocolo'},horizons:{},lastPrimaryTarget:{},openPrimary:{},lastPrimaryObservedAt:{}};}
export function horizonScore(e,h){return e.horizons[h]??=( {all:newScore(),primary:newScore(),assets:{}} );}
export function registerIssue(e,p){const h=horizonScore(e,p.horizon);h.all.issued++;if(p.primary){(e.openPrimary??={})[p.asset+':'+p.horizon]=p.id;h.primary.issued++;(h.assets[p.asset]??=newScore()).issued++;}}
export function registerOutcome(e,p,result){if(p.primary){const key=p.asset+':'+p.horizon;if(e.openPrimary?.[key]===p.id)delete e.openPrimary[key];(e.lastPrimaryObservedAt??={})[key]=result.actualObservedAt??result.evaluatedAt??p.targetAt;}const h=horizonScore(e,p.horizon);scoreOutcome(h.all,p,result);if(p.primary){scoreOutcome(h.primary,p,result);scoreOutcome(h.assets[p.asset]??=newScore(),p,result);}}
export function evaluationView(e){return Object.fromEntries(Object.entries(e.horizons).map(([h,s])=>[h,{all:scoreView(s.all),primary:scoreView(s.primary),assets:Object.fromEntries(Object.entries(s.assets).map(([id,v])=>[id,scoreView(v)]))}]));}

export function auditForecast(p){
 const errors=[],known=Date.parse(p.knownAt),priceAt=Date.parse(p.priceAt),target=Date.parse(p.targetAt);
 if(p.protocolId!==PREDICTION_PROTOCOL.id)errors.push('protocol');
 if(!Number.isFinite(known)||!Number.isFinite(priceAt)||!Number.isFinite(target)||known-priceAt<0||known-priceAt>PREDICTION_PROTOCOL.maxQuoteAgeMs||target-known!==p.horizon*3600000||!PREDICTION_PROTOCOL.horizons.includes(p.horizon))errors.push('time');
 if(!Number.isFinite(p.price)||p.price<=0||!Number.isFinite(p.probability)||p.probability<0||p.probability>1)errors.push('values');
 const weights=p.modelSnapshot?.weights,vector=p.vector;
 if(!Array.isArray(weights)||!Array.isArray(vector)||weights.length!==FEATURE_NAMES.length||vector.length!==weights.length||!weights.every(Number.isFinite)||!vector.every(Number.isFinite))errors.push('features');
 else{const z=weights.reduce((v,w,i)=>v+w*vector[i],0),probability=1/(1+Math.exp(-Math.max(-20,Math.min(20,z))));if(Math.abs(probability-p.probability)>1e-12)errors.push('probability-replay');}
 if(!p.modelSnapshot||digest(p.modelSnapshot)!==p.modelHash)errors.push('model-hash');
 return {id:p.id,valid:errors.length===0,errors};
}

export function recordLegacyOutcome(e,p,result,now){
 const m=e.legacy.metrics[p.horizon]??={scored:0,correct:0,accuracy:null,brier:null,flatExcluded:0};e.legacy.updatedAt=new Date(now).toISOString();
 if(result.status!=='scored'){m.missed=(m.missed??0)+1;return;}
 if(result.rawPct===0){m.flatExcluded=(m.flatExcluded??0)+1;return;}
 const y=Number(result.rawPct>0),n=m.scored??0,brierSum=(m.brier??0)*n+(p.probability-y)**2;m.scored=n+1;m.correct=(m.correct??0)+Number((p.probability>=.5)===(y===1));m.accuracy=m.correct/m.scored;m.brier=brierSum/m.scored;
}
