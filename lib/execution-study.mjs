import { runScenarioStudy,STUDY_PROTOCOL } from './scenario-study.mjs';
import { marketContext,EXECUTION_CONTEXT_VERSION } from './market-context.mjs';
import { indicators,featureVector } from './indicators.mjs';
import { digest } from './prediction-protocol.mjs';
export const EXECUTION_PROTOCOL=Object.freeze({...STUDY_PROTOCOL,id:'execution-horizons-v1',horizonUnit:'minutes',horizons:[6,20,60],contextFeatureVersion:EXECUTION_CONTEXT_VERSION,publicationMs:120000,maxGapMs:300000,maxEvaluationDelayMs:120000,expiryDelayMs:360000,minTrainingCases:20,training:'non-overlapping observation windows'});
export function normalizeExecutionPoints(raw){
 const byObserved=new Map();
 for(const p of raw){const at=Date.parse(p.at),observed=Date.parse(p.observedAt??p.at);if(!Number.isFinite(at)||!Number.isFinite(observed)||observed>at||at-observed>120000||!Number.isFinite(p.price)||p.price<=0)continue;
  const point={at:new Date(at).toISOString(),observedAt:new Date(observed).toISOString(),price:p.price,source:p.source??'coingecko'},prior=byObserved.get(point.observedAt);if(!prior||at<Date.parse(prior.at))byObserved.set(point.observedAt,point);
 }
 const byKnown=new Map();for(const p of [...byObserved.values()].sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt)))byKnown.set(p.at,p);
 let latest=-Infinity;return [...byKnown.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).filter(p=>{const observed=Date.parse(p.observedAt);if(observed<=latest)return false;latest=observed;return true;});
}
export function executionInput(id,observations,quote,knownAt){
 const points=normalizeExecutionPoints([...observations,{at:new Date(knownAt).toISOString(),observedAt:quote.observedAt,price:quote.price,source:quote.source??'coingecko'}]).filter(p=>Date.parse(p.at)<=knownAt&&Date.parse(p.observedAt)<=knownAt).slice(-24);
 if(!points.length||Date.parse(points.at(-1).observedAt)!==Date.parse(quote.observedAt)||points.at(-1).price!==quote.price)return {ready:false};
 const context=marketContext(points,null,knownAt,{version:EXECUTION_CONTEXT_VERSION,maxGapMs:EXECUTION_PROTOCOL.maxGapMs});if(!context.ready)return {ready:false};
 const technical=indicators(points);technical.return6hPct=(points.at(-1).price/points.at(-7).price-1)*100;
 const vector=featureVector(id,technical,{available:false,count:0,score:0},null);
 return {ready:vector.every(Number.isFinite),points,technical,vector,context,hash:digest({version:EXECUTION_CONTEXT_VERSION,points,vector,contextVector:context.vector}),momentumUp:points.at(-1).price>=points.at(-2).price};
}
export function executionSamples(points,id,minutes){
 const samples=[];let next=-Infinity;
 for(let i=23;i<points.length;i++){
  const current=points[i],at=Date.parse(current.at),target=at+minutes*60000;if(at<next)continue;if(target>Date.parse(points.at(-1).at))break;
  const input=executionInput(id,points.slice(Math.max(0,i-23),i+1),{price:current.price,observedAt:current.observedAt,source:current.source},at);if(!input.ready)continue;
  let j=i+1;while(j<points.length&&Date.parse(points[j].observedAt)<target)j++;
  const end=points[j],valid=end&&end.source===current.source&&Date.parse(end.observedAt)<=target+EXECUTION_PROTOCOL.maxEvaluationDelayMs;
  const known=valid?Date.parse(end.at):target+EXECUTION_PROTOCOL.expiryDelayMs;if(known>Date.parse(points.at(-1).at))continue;
  const t=input.technical,scenario=`${t.trendBps>20?'up':t.trendBps< -20?'down':'flat'}|${t.volatilityPct>.7?'high':t.volatilityPct>.2?'medium':'low'}|${t.rsi14<30?'oversold':t.rsi14>70?'overbought':'neutral'}`;
  samples.push({at:current.at,targetAt:new Date(target).toISOString(),labelKnownAt:new Date(known).toISOString(),status:valid?'scored':'missing-price',rawPct:valid?(end.price/current.price-1)*100:null,vector:input.vector,contextVector:input.context.vector,momentumUp:input.momentumUp,scenario});next=known;
 }
 return samples;
}
export function runExecutionStudy(raw,id,{now=Date.now(),source='Cotações da auditoria · aproximadamente a cada dois minutos'}={}){
 const observations=normalizeExecutionPoints(raw).filter(p=>Date.parse(p.at)<=now);
 const result=runScenarioStudy(observations,id,{now,source,protocol:EXECUTION_PROTOCOL,horizons:EXECUTION_PROTOCOL.horizons,sampleBuilder:executionSamples});
 result.report.limitations.push('Prazos em minutos; observações pontuais, não candles nem ticks de execução. Máximo atraso de avaliação: dois minutos. Não misturar estes casos com os estudos horários.');
 return {...result,observations};
}
