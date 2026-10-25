import { directionInput,PREDICTION_PROTOCOL } from './prediction-protocol.mjs';
export function historicalSamples(points,id,h){
 const samples=[];
 for(let i=23;i<points.length;i++){
  const at=Date.parse(points[i].at),observed=Date.parse(points[i].observedAt??points[i].at),target=at+h*3600000;if(target>Date.parse(points.at(-1).at))break;
  if(!Number.isFinite(observed)||observed>at||at-observed>120000)continue;
  const input=directionInput(id,points.slice(Math.max(0,i-71),i+1),{price:points[i].price,observedAt:points[i].observedAt??points[i].at},at);if(!input.ready)continue;
  let endIndex=i+1;while(endIndex<points.length&&Date.parse(points[endIndex].observedAt??points[endIndex].at)<target)endIndex++;
  const end=points[endIndex],valid=end&&Date.parse(end.observedAt??end.at)<=target+PREDICTION_PROTOCOL.maxEvaluationDelayMs;
  const known=valid?Date.parse(end.at):target+PREDICTION_PROTOCOL.expiryDelayMs;if(known>Date.parse(points.at(-1).at))continue;
  const t=input.technical;
  const trend=t.trendBps>20?'up':t.trendBps< -20?'down':'flat',vol=t.volatilityPct>.7?'high':t.volatilityPct>.2?'medium':'low',rsi=t.rsi14<30?'oversold':t.rsi14>70?'overbought':'neutral';
  samples.push({at:points[i].at,targetAt:new Date(target).toISOString(),labelKnownAt:new Date(known).toISOString(),status:valid?'scored':'missing-price',rawPct:valid?(end.price/points[i].price-1)*100:null,vector:input.vector,momentumUp:input.momentumUp,scenario:`${trend}|${vol}|${rsi}`});
 }
 return samples;
}
