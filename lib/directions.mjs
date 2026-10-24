import { indicators, featureVector } from './indicators.mjs';
import { probability, updateModel, HORIZONS } from './research.mjs';
import { isETF } from './markets.mjs';
const iso=t=>new Date(t).toISOString();
export function advanceDirections(previous,quotes,now=Date.now()){
 if(!previous.intelligence?.directionByAsset)return previous;
 const s={...previous,intelligence:structuredClone(previous.intelligence)},r=s.intelligence;
 r.directionPending??=[];r.directionSlots??={};r.directionOutcomes??=[];r.directionFlat??={};
 const waiting=[],outcomes=[],fresh=[];
 for(const p of r.directionPending){
  if(Date.parse(p.targetAt)>now){waiting.push(p);continue;}
  const q=quotes[p.asset],t=Date.parse(q?.observedAt),target=Date.parse(p.targetAt);
  if(!Number.isFinite(q?.price)||now-t>120000||Math.abs(t-target)>5*60000||t<=Date.parse(p.priceAt)){
   if(now<=target+10*60000)waiting.push(p);else outcomes.push({...p,status:'missing-price'});continue;
  }
  const rawPct=(q.price/p.price-1)*100,actual=rawPct===0?'ESTÁVEL':rawPct>0?'SUBIU':'DESCEU';
  const result={...p,vector:undefined,status:'scored',evaluatedAt:iso(now),actualObservedAt:q.observedAt,actualPrice:q.price,rawPct,actual,correct:rawPct===0?null:(p.probability>=.5)===(rawPct>0)};
  if(rawPct===0)r.directionFlat[p.horizon]=(r.directionFlat[p.horizon]??0)+1;
  else{const model=r.directionByAsset[p.asset]?.[p.horizon];if(model)updateModel(model,p,rawPct);}
  outcomes.push(result);
 }
 for(const asset of Object.keys(s.config?.allocations??{}).filter(id=>!isETF(id))){
  const q=quotes[asset];if(!Number.isFinite(q?.price)||now-Date.parse(q.observedAt)>120000)continue;
  const observations=[...(s.portfolio[asset]?.observations??[]),{at:iso(now),price:q.price}],technical=indicators(observations);
  if(!technical.continuous)continue;
  const vector=featureVector(asset,technical,{available:false,count:0,score:0},null);
  for(const h of HORIZONS){const model=r.directionByAsset[asset]?.[h];if(!model||model.trained<30)continue;
   const slot=String(Math.floor(now/(h===1?15*60000:3600000))),key=asset+':'+h;if(r.directionSlots[key]===slot)continue;
   const p={id:`direction:${slot}:${asset}:${h}`,asset,horizon:h,knownAt:iso(now),priceAt:q.observedAt,targetAt:iso(now+h*3600000),price:q.price,probability:probability(model,vector),vector,modelVersion:model.historyHash,source:q.source??'coingecko'};
   fresh.push(p);r.directionSlots[key]=slot;
  }
 }
 if(!fresh.length&&!outcomes.length)return previous;
 r.directionPending=[...waiting,...fresh].slice(-500);r.directionOutcomes=[...r.directionOutcomes,...outcomes].slice(-150);
 r.directionMetrics=Object.fromEntries(HORIZONS.map(h=>{const banks=[...Object.values(r.directionByAsset).map(b=>b[h]).filter(Boolean),...(r.directionModels?.[h]?[r.directionModels[h]]:[])],scored=banks.reduce((v,b)=>v+b.scored,0),correct=banks.reduce((v,b)=>v+b.correct,0);return [h,{scored,correct,accuracy:scored?correct/scored:null,brier:scored?banks.reduce((v,b)=>v+b.brierSum,0)/scored:null,flatExcluded:r.directionFlat[h]??0}];}));
 const cycle={at:iso(now),newPredictions:fresh,outcomes,metrics:r.directionMetrics,modelSnapshots:r.directionByAsset,note:'Direção de preço, sem custos; tolerância de avaliação ±5min. Previsões sobrepostas não são observações independentes.'};
 s.researchDelta=previous.researchDelta?.asOf===iso(now)?{...previous.researchDelta,directionCycle:cycle}:{asOf:iso(now),kind:'direction-cycle',directionCycle:cycle};
 return s;
}
