import { probability, updateModel, HORIZONS } from './research.mjs';
import { isETF } from './markets.mjs';
import { PREDICTION_PROTOCOL as protocol, digest, directionInput, newEvaluation, registerIssue, registerOutcome, evaluationView, auditForecast, recordLegacyOutcome } from './prediction-protocol.mjs';
const iso=t=>new Date(t).toISOString();
export function advanceDirections(previous,quotes,now=Date.now()){
 if(!previous.intelligence?.directionByAsset)return previous;
 const s={...previous,intelligence:structuredClone(previous.intelligence)},r=s.intelligence;
 r.directionPending??=[];r.directionSlots??={};r.directionOutcomes??=[];r.directionFlat??={};
 r.directionEvaluation??=newEvaluation(r.directionMetrics,now);
 const evaluation=r.directionEvaluation,waiting=[],outcomes=[],fresh=[],inputs={},seen=new Set(r.directionOutcomes.map(p=>p.id));r.latestDirectionalForecasts??={};
 for(const p of r.directionPending){
  if(seen.has(p.id))continue;seen.add(p.id);
  if(p.protocolId===protocol.id){const integrity=auditForecast(p);if(!integrity.valid){const invalid={...p,vector:undefined,status:'invalid-forecast',evaluatedAt:iso(now),reason:integrity.errors.join(',')};outcomes.push(invalid);registerOutcome(evaluation,p,invalid);continue;}}
  const target=Date.parse(p.targetAt);if(target>now){waiting.push(p);continue;}
  const q=quotes[p.asset],t=Date.parse(q?.observedAt),sameSource=(q?.source??'coingecko')===(p.source??'coingecko');
  if(!Number.isFinite(q?.price)||q.price<=0||!Number.isFinite(t)||t>now||now-t>protocol.maxQuoteAgeMs||t<target||t>target+protocol.maxEvaluationDelayMs||t<=Date.parse(p.priceAt)||!sameSource){
   if(now<=target+protocol.expiryDelayMs)waiting.push(p);
   else{const missing={...p,vector:undefined,status:'missing-price',evaluatedAt:iso(now),reason:'Sem cotação posterior ao alvo, da mesma fonte e dentro da janela definida'};outcomes.push(missing);if(p.protocolId===protocol.id)registerOutcome(evaluation,p,missing);else recordLegacyOutcome(evaluation,p,missing,now);}
   continue;
  }
  const rawPct=(q.price/p.price-1)*100;if(!Number.isFinite(rawPct)){const missing={...p,vector:undefined,status:'missing-price',evaluatedAt:iso(now),reason:'Retorno não finito: rejeitado pelo protocolo'};outcomes.push(missing);if(p.protocolId===protocol.id)registerOutcome(evaluation,p,missing);else recordLegacyOutcome(evaluation,p,missing,now);continue;}
  const actual=rawPct===0?'ESTÁVEL':rawPct>0?'SUBIU':'DESCEU';
  const result={...p,vector:undefined,status:'scored',evaluatedAt:iso(now),actualObservedAt:q.observedAt,actualPrice:q.price,delaySeconds:(t-target)/1000,rawPct,actual,correct:rawPct===0?null:(p.probability>=.5)===(rawPct>0)};
  // The saved probability is scored before any update of coefficients.
  if(p.protocolId===protocol.id)registerOutcome(evaluation,p,result);else recordLegacyOutcome(evaluation,p,result,now);
  if(rawPct===0)r.directionFlat[p.horizon]=(r.directionFlat[p.horizon]??0)+1;
  else if(p.protocolId===protocol.id&&p.primary){const model=r.directionByAsset[p.asset]?.[p.horizon];if(model)updateModel(model,p,rawPct);}
  outcomes.push(result);
 }
 for(const asset of Object.keys(s.config?.allocations??{}).filter(id=>!isETF(id))){
  const q=quotes[asset],observed=Date.parse(q?.observedAt);
  if(!Number.isFinite(q?.price)||q.price<=0||!Number.isFinite(observed)||observed>now||now-observed>protocol.maxQuoteAgeMs)continue;
  const input=directionInput(asset,s.portfolio[asset]?.observations??[],q,now);if(!input.ready)continue;
  for(const h of HORIZONS){const model=r.directionByAsset[asset]?.[h];if(!model||!Number.isFinite(model.trained)||model.trained<30||model.weights?.length!==input.vector.length||!model.weights.every(Number.isFinite))continue;
   const slot=String(Math.floor(now/3600000)),key=protocol.id+':'+asset+':'+h;if(r.directionSlots[key]===slot)continue;
   const targetAt=iso(now+h*3600000),primaryKey=asset+':'+h,primary=!evaluation.openPrimary?.[primaryKey]&&now>=Date.parse(evaluation.lastPrimaryTarget[primaryKey]??'1970-01-01')&&observed>=Date.parse(evaluation.lastPrimaryObservedAt?.[primaryKey]??'1970-01-01');
   const modelSnapshot={weights:[...model.weights],trained:model.trained,historyHash:model.historyHash,algorithm:protocol.algorithm,learningRate:protocol.learningRate,l2:protocol.l2,weightClip:protocol.weightClip,logitClip:protocol.logitClip};
   const p={id:`${protocol.id}:${slot}:${asset}:${h}`,protocolId:protocol.id,asset,horizon:h,knownAt:iso(now),priceAt:q.observedAt,targetAt,price:q.price,probability:probability(model,input.vector),vector:input.vector,modelVersion:model.historyHash,modelHash:digest(modelSnapshot),modelSnapshot,inputHash:input.hash,featureVersion:protocol.featureVersion,primary,baselines:{alwaysUp:true,momentumUp:input.momentumUp,neutralProbability:.5},source:q.source??'coingecko'};
   if(primary)evaluation.lastPrimaryTarget[primaryKey]=targetAt;
   registerIssue(evaluation,p);fresh.push(p);inputs[input.hash]={asset,points:input.points,technical:input.technical,vector:input.vector};r.directionSlots[key]=slot;
   (r.latestDirectionalForecasts[asset]??={})[h]=p;
  }
 }
 if(!fresh.length&&!outcomes.length)return previous;
 r.directionPending=[...waiting,...fresh].slice(-500);r.directionOutcomes=[...r.directionOutcomes,...outcomes].slice(-150);evaluation.metrics=evaluationView(evaluation);evaluation.updatedAt=iso(now);
 r.directionMetrics=Object.fromEntries(HORIZONS.map(h=>{const banks=[...Object.values(r.directionByAsset).map(b=>b[h]).filter(Boolean),...(r.directionModels?.[h]?[r.directionModels[h]]:[])],scored=banks.reduce((v,b)=>v+b.scored,0),correct=banks.reduce((v,b)=>v+b.correct,0);return [h,{scored,correct,accuracy:scored?correct/scored:null,brier:scored?banks.reduce((v,b)=>v+b.brierSum,0)/scored:null,flatExcluded:r.directionFlat[h]??0}];}));
 const cycle={at:iso(now),protocol,newPredictions:fresh,inputSnapshots:inputs,outcomes,metrics:evaluation.metrics,modelSnapshots:r.directionByAsset,note:'Principal: intervalos sem sobreposição por ativo/horizonte; ativos continuam correlacionados. Preço de avaliação sempre posterior ao alvo. Acerto de direção não mede lucro.'};
 s.researchDelta=previous.researchDelta?.asOf===iso(now)?{...previous.researchDelta,directionCycle:cycle}:{asOf:iso(now),kind:'direction-cycle',directionCycle:cycle};return s;
}
