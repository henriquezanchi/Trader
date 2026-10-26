import { isETF } from './markets.mjs';
import { breakEvenRawPct } from './forecast-economics.mjs';
import { digest } from './prediction-protocol.mjs';
export const TREND_EXIT_POLICY = Object.freeze({id:'trend-trailing-v1',lookback:24,maxGapMs:300000});
export const ADAPTIVE_EXIT_POLICY=Object.freeze({id:'quote-variation-exit-v1',lookback:24,activationMinPct:.25,activationMaxPct:2,drawdownMinPct:.15,drawdownMaxPct:1.5,costRangeMargin:1.25,activationScale:.8,drawdownScale:.5,pullbackMinFloorPct:.05,pullbackMaxFloorPct:.25,pullbackMinScale:.5,pullbackMaxScale:4,emaDistanceFloorPct:.15,emaDistanceScale:2});
export const TREND_ARMS = Object.freeze([
 {id:'trend-hours',label:'Tendência · 4 horas',maxMinutes:240,takeProfitPct:.5,exitMode:'trailing',trailingDrawdownPct:.3,entryRule:'trend'},
 {id:'trend-day',label:'Tendência · 1 dia',maxMinutes:1440,takeProfitPct:1,exitMode:'trailing',trailingDrawdownPct:.6,entryRule:'trend'},
 {id:'pullback-hours-adaptive',label:'Recuo + custos · 4 horas',maxMinutes:240,takeProfitPct:.5,exitMode:'trailing',trailingDrawdownPct:.3,entryRule:'pullback',adaptiveExit:true,costAware:true},
 {id:'pullback-day-adaptive',label:'Recuo + custos · 1 dia',maxMinutes:1440,takeProfitPct:1,exitMode:'trailing',trailingDrawdownPct:.6,entryRule:'pullback',adaptiveExit:true,costAware:true},
]);
export function trendSignal(observations,now=Date.now()){
 const seen=new Map();
 for(const p of observations??[]){const at=Date.parse(p.at),observed=Date.parse(p.observedAt??p.at);if(Number.isFinite(at)&&Number.isFinite(observed)&&at<=now&&observed<=at&&at-observed<=120000&&Number.isFinite(p.price)&&p.price>0&&!seen.has(observed))seen.set(observed,{...p,observedAt:new Date(observed).toISOString()});}
 const points=[...seen.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-24);
 const ready=points.length===24&&points.every((p,i)=>!i||Date.parse(p.at)>Date.parse(points[i-1].at)&&Date.parse(p.at)-Date.parse(points[i-1].at)<=TREND_EXIT_POLICY.maxGapMs);
 if(!ready)return {ready:false,trend:false,breakout:false,reason:'Tendência não confirmada: requer 24 cotações distintas, sem lacunas maiores que cinco minutos'};
 const prices=points.map(p=>p.price),last=prices.at(-1),ema=n=>prices.reduce((v,x,i)=>i?v+2/(n+1)*(x-v):x,0);
 const ema8=ema(8),ema21=ema(21),returnPct=(last/prices[0]-1)*100,priorHigh=Math.max(...prices.slice(0,-1));
 const trend=ema8>ema21&&returnPct>0,breakout=trend&&last>priorHigh;
 const minutes=(Date.parse(points.at(-1).at)-Date.parse(points[0].at))/60000;
 const returns=prices.slice(1).map((p,i)=>Math.log(p/prices[i])*100);
 const variationRatePct=Math.sqrt(returns.reduce((n,r)=>n+r*r,0)/minutes);
 const observedRangePct=(Math.max(...prices)/Math.min(...prices)-1)*100;
 const recentHigh=Math.max(...prices.slice(-12,-2)),pullbackPct=(recentHigh/last-1)*100;
 const lastChangePct=(last/prices.at(-2)-1)*100,distanceEma8Pct=(last/ema8-1)*100;
 const pullback=trend&&lastChangePct>0&&pullbackPct>=Math.max(ADAPTIVE_EXIT_POLICY.pullbackMinFloorPct,variationRatePct*ADAPTIVE_EXIT_POLICY.pullbackMinScale)&&pullbackPct<=Math.max(ADAPTIVE_EXIT_POLICY.pullbackMaxFloorPct,variationRatePct*ADAPTIVE_EXIT_POLICY.pullbackMaxScale)&&distanceEma8Pct<=Math.max(ADAPTIVE_EXIT_POLICY.emaDistanceFloorPct,variationRatePct*ADAPTIVE_EXIT_POLICY.emaDistanceScale);
 const result={ready:true,trend,breakout,pullback,variationRatePct,observedRangePct,pullbackPct,lastChangePct,distanceEma8Pct,minutesCovered:minutes,ema8,ema21,returnPct,priorHigh,inputHash:digest(points),
  reason:`EMA8 ${ema8>ema21?'acima':'abaixo ou igual'} à EMA21; variação das 24 observações ${returnPct.toFixed(3)}%; ${breakout?'rompimento da máxima anterior':'sem rompimento da máxima anterior'}; recuo ${pullbackPct.toFixed(3)}%, reação ${lastChangePct.toFixed(3)}%; faixa observada ${observedRangePct.toFixed(3)}%`};
 Object.defineProperty(result,'inputPoints',{value:points});return result;
}
export function entryRuleEvidence(signal,arm,asset='bitcoin'){
 const rule=arm.entryRule??'always',signalAllows=rule==='always'||!!signal[rule];
 const breakEvenPct=breakEvenRawPct(asset),requiredRangePct=breakEvenPct*ADAPTIVE_EXIT_POLICY.costRangeMargin;
 const costAllows=!arm.costAware||signal.ready&&signal.observedRangePct>=requiredRangePct;
 const reason=`${signal.reason??'Entrada sem filtro de preço'}. ${arm.costAware?`Faixa observada ${Number.isFinite(signal.observedRangePct)?signal.observedRangePct.toFixed(3)+'%':'indisponível'}; mínimo de referência ${requiredRangePct.toFixed(3)}% para custos de ida/volta de ${breakEvenPct.toFixed(3)}%. Faixa passada não prevê retorno futuro.`:''}`;
 return {eligible:signalAllows&&costAllows,reason,breakEvenPct,requiredRangePct,costAllows};
}
export function resolveExitPlan(arm,signal,{snapshot=false}={}){
 if(!arm.adaptiveExit)return {};
 if(!signal?.ready||!Number.isFinite(signal.variationRatePct)||signal.variationRatePct<0)throw Error('Variação conhecida insuficiente para dimensionar a saída');
 const p=ADAPTIVE_EXIT_POLICY,scale=signal.variationRatePct*Math.sqrt(arm.maxMinutes),clip=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
 const takeProfitPct=clip(scale*p.activationScale,p.activationMinPct,p.activationMaxPct),trailingDrawdownPct=clip(scale*p.drawdownScale,p.drawdownMinPct,p.drawdownMaxPct);
 return {takeProfitPct,trailingDrawdownPct,exitSizing:{policy:p.id,inputHash:signal.inputHash,...(snapshot&&signal.inputPoints?{inputSnapshot:structuredClone(signal.inputPoints)}:{}),variationRatePct:signal.variationRatePct,minutesCovered:signal.minutesCovered,horizonScalePct:scale,
  activationPct:takeProfitPct,drawdownPct:trailingDrawdownPct,note:'Escala de variação de preços observados, com hipótese de raiz do tempo; não é ATR nem previsão de valorização. Congelada na entrada.'}};
}
export function armEntryEligible(state,context,arm,now=Date.now()){
 if(!arm.entryRule)return {eligible:true,reason:'Alternativa de exploração sem filtro de tendência'};
 if(context.asset?.startsWith('solana:')||isETF(context.asset))return {eligible:false,reason:'Alternativas longas restritas a criptomoedas estabelecidas'};
 const signal=trendSignal(state.fast?.observations?.[context.asset],now);
 return {...entryRuleEvidence(signal,arm,context.asset),signal};
}
// Tracks net liquidation returns, after entry and exit costs. No assumed fill at a threshold.
export function exitProgress(plan,previous,netPct,observedAt){
 if(!Number.isFinite(netPct)||!Number.isFinite(Date.parse(observedAt)))throw Error('Preço de saída inválido');
 if(previous?.notBefore&&Date.parse(observedAt)<=Date.parse(previous.notBefore))return {tracking:previous,reason:null};
 if(previous?.lastObservedAt&&Date.parse(observedAt)<=Date.parse(previous.lastObservedAt))return {tracking:previous,reason:null};
 const peakNetPct=Math.max(previous?.peakNetPct??-Infinity,netPct),armed=previous?.armed===true||peakNetPct>=plan.takeProfitPct;
 const tracking={peakNetPct,armed,lastObservedAt:observedAt};
 if(plan.exitMode==='trailing'){
  if(!Number.isFinite(plan.trailingDrawdownPct)||plan.trailingDrawdownPct<=0)throw Error('Distância da saída móvel inválida');
  const drawdown=peakNetPct-netPct;
  return {tracking,reason:armed&&drawdown>=plan.trailingDrawdownPct?`Saída móvel: recuo de ${drawdown.toFixed(3)} ponto(s) percentual(is) desde o pico líquido de ${peakNetPct.toFixed(3)}%; resultado observado ${netPct.toFixed(3)}%`:null};
 }
 return {tracking,reason:netPct>=plan.takeProfitPct?`Meta líquida curta atingida: ${netPct.toFixed(2)}% após custos`:null};
}
