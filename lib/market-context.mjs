import { indicators } from './indicators.mjs';
export const EXECUTION_CONTEXT_VERSION='two-minute-price-context-v1';
export const CONTEXT_VERSION='hourly-price-context-v1';
export const CONTEXT_NAMES=Object.freeze(['trend','rsi','volatility','return6','return1Observation','return3Observations','return12Observations','acceleration','shortVolatilityRatio','slope','trendFit','distanceHigh24','distanceLow24','rangePosition24','breakout23','breakdown23','upFraction','ema8vs21','rsiExtreme','returnAutocorrelation']);
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
const variance=a=>{const m=mean(a);return mean(a.map(v=>(v-m)**2));};
const clip=x=>Math.max(-5,Math.min(5,x));
export function marketContext(points,_technical,knownAt,{version=CONTEXT_VERSION,maxGapMs=5400000}={}){
 const p=points.filter(p=>Number.isFinite(p.price)&&p.price>0&&Date.parse(p.at)<=knownAt&&Date.parse(p.observedAt??p.at)<=knownAt).slice(-24);
 if(p.length<24||p.some((v,i)=>i&&(Date.parse(v.at)<=Date.parse(p[i-1].at)||Date.parse(v.at)-Date.parse(p[i-1].at)>maxGapMs)))return {ready:false,version,names:CONTEXT_NAMES,vector:[]};
 const technical=indicators(p);
 const prices=p.map(v=>v.price),last=prices.at(-1),returns=prices.slice(1).map((v,i)=>Math.log(v/prices[i])),logs=prices.map(Math.log),times=p.map(v=>(Date.parse(v.at)-Date.parse(p[0].at))/3600000);
 const xMean=mean(times),yMean=mean(logs),slope=times.reduce((v,x,i)=>v+(x-xMean)*(logs[i]-yMean),0)/times.reduce((v,x)=>v+(x-xMean)**2,0);
 const residual=logs.reduce((v,y,i)=>v+(y-yMean-slope*(times[i]-xMean))**2,0),total=logs.reduce((v,y)=>v+(y-yMean)**2,0),fit=total>0?Math.max(0,Math.min(1,1-residual/total)):0;
 const ret=n=>(last/prices.at(-1-n)-1)*100,hi=Math.max(...prices),lo=Math.min(...prices),vol=Math.sqrt(variance(returns)),shortVol=Math.sqrt(variance(returns.slice(-6)));
 const a=returns.slice(0,-1),b=returns.slice(1),am=mean(a),bm=mean(b),den=Math.sqrt(a.reduce((s,x)=>s+(x-am)**2,0)*b.reduce((s,x)=>s+(x-bm)**2,0)),correlation=den?a.reduce((s,x,i)=>s+(x-am)*(b[i]-bm),0)/den:0;
 const ema=n=>prices.reduce((v,x,i)=>i?v+2/(n+1)*(x-v):x,0);
 const vector=[(technical.trendBps??0)/100,((technical.rsi14??50)-50)/50,(technical.volatilityPct??0)/5,ret(6)/5,ret(1)/5,ret(3)/5,ret(12)/5,(ret(3)/3-ret(12)/12),vol?shortVol/vol:0,slope*100,fit,(last/hi-1)*20,(last/lo-1)*20,hi>lo?(last-lo)/(hi-lo):.5,(last/Math.max(...prices.slice(0,-1))-1)*20,(last/Math.min(...prices.slice(0,-1))-1)*20,returns.filter(r=>r>0).length/returns.length-.5,(ema(8)/ema(21)-1)*20,technical.rsi14<30?-1:technical.rsi14>70?1:0,correlation].map(clip);
 return {ready:vector.every(Number.isFinite),version,names:CONTEXT_NAMES,vector};
}
