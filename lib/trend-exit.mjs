import { digest } from './prediction-protocol.mjs';
export const TREND_EXIT_POLICY = Object.freeze({id:'trend-trailing-v1',lookback:24,maxGapMs:300000});
export const TREND_ARMS = Object.freeze([
 {id:'trend-hours',label:'Tendência · 4 horas',maxMinutes:240,takeProfitPct:.5,exitMode:'trailing',trailingDrawdownPct:.3,entryRule:'trend'},
 {id:'trend-day',label:'Tendência · 1 dia',maxMinutes:1440,takeProfitPct:1,exitMode:'trailing',trailingDrawdownPct:.6,entryRule:'trend'},
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
 return {ready:true,trend,breakout,ema8,ema21,returnPct,priorHigh,inputHash:digest(points),
  reason:`EMA8 ${ema8>ema21?'acima':'abaixo ou igual'} à EMA21; variação das 24 observações ${returnPct.toFixed(3)}%; ${breakout?'rompimento da máxima anterior':'sem rompimento da máxima anterior'}`};
}
export function armEntryEligible(state,context,arm,now=Date.now()){
 if(!arm.entryRule)return {eligible:true,reason:'Alternativa de exploração sem filtro de tendência'};
 if(context.asset?.startsWith('solana:'))return {eligible:false,reason:'Alternativas longas restritas a criptomoedas estabelecidas'};
 const signal=trendSignal(state.fast?.observations?.[context.asset],now);
 return {eligible:!!signal[arm.entryRule],reason:signal.reason,signal};
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
