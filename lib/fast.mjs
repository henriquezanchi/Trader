import { randomUUID } from 'node:crypto';
import { equity, validateQuote } from './engine.mjs';
import { stopReason } from './portfolio.mjs';
import { isETF, fill } from './markets.mjs';
import { indicators } from './indicators.mjs';
import { blendFor } from './blend.mjs';
export { BLENDS, blendFor } from './blend.mjs';
export function fastStep(previous, quotes, now=Date.now()) {
 if(previous.config?.cryptoStrategy!=='hybrid' && !Object.values(previous.fast?.positions??{}).some(p=>p.quantity>0))return {state:previous,duplicate:true};
 const slot=String(Math.floor(now/120000));
 if(previous.fast?.lastSlot===slot)return {state:previous,duplicate:true};
 const s=structuredClone(previous), config=s.config, params=blendFor(config);
 s.fast??={positions:{},observations:{},cooldowns:{},lastSlot:null};s.fast.lastSlot=slot;
 const ids=[...new Set([...Object.keys(config.allocations).filter(id=>!isETF(id)),...Object.keys(s.fast.positions)])];
 for(const id of ids){validateQuote(quotes[id],now);if(now-Date.parse(quotes[id].observedAt)>120000)throw Error('Cotação antiga para ciclo curto; nenhuma decisão rápida executada');}
 const events=[];
 for(const id of ids){
  const q=quotes[id],p=s.fast.positions[id]??={quantity:0,costBasis:0,lastPrice:q.price};p.lastPrice=q.price;
  const observations=s.fast.observations[id]??=[];
  const fresh=!observations.length||Date.parse(q.observedAt)>Date.parse(observations.at(-1).observedAt);
  if(fresh)observations.push({at:new Date(now).toISOString(),observedAt:q.observedAt,price:q.price});
  s.fast.observations[id]=observations.slice(-120);
 }
 let stop=stopReason(s,now);if(stop){s.paused=true;s.reason=stop;}
 function record(id,action,reason,budget=0){
  const p=s.fast.positions[id],q=quotes[id],before={cash:s.cash,quantity:p.quantity,equity:equity(s),costBasis:p.costBasis};
  let order={quantity:0,fee:0,executionPrice:q.price,realizedPnl:null};
  if(action!=='AGUARDAR'){
   order=fill(id,action,q.price,budget,p,now);s.cash+=order.cashChange;
   if(action==='COMPRAR'){p.quantity=order.quantity;p.costBasis=-order.cashChange;p.openedAt=new Date(now).toISOString();}
   else{p.quantity=0;p.costBasis=0;s.fast.cooldowns[id]=new Date(now+params.cooldownMinutes*60000).toISOString();}
  }
  s.fast.stats??={buys:0,sells:0,wins:0,losses:0,fees:0,realizedPnl:0};
  if(action!=='AGUARDAR'){s.fast.stats.fees+=order.fee;if(action==='COMPRAR')s.fast.stats.buys++;else{s.fast.stats.sells++;s.fast.stats.realizedPnl+=order.realizedPnl??0;if(order.realizedPnl>0)s.fast.stats.wins++;else if(order.realizedPnl<0)s.fast.stats.losses++;}}
  events.push({id:randomUUID(),at:new Date(now).toISOString(),asset:id,mode:'fast',action,reason,quantity:order.quantity,fee:order.fee,executionPrice:order.executionPrice,price:q.price,realizedPnl:order.realizedPnl,equity:equity(s),indicators:{macro:indicators(s.portfolio[id]?.observations??[]),recentQuotes:s.fast.observations[id].slice(-3),entryRule:'3 distinct quotes in 2–10 min; last >= previous, last >= first * .9998; jump <= 1.5%; macro trend >= -3%'},parameters:{engine:'hybrid-fast-v1',...params,feeRate:.001,slippageRate:.001,netTarget:true,config:structuredClone(config)},quote:{...q,source:q.source??'coingecko'},before,after:{cash:s.cash,quantity:p.quantity,equity:equity(s),costBasis:p.costBasis}});
 }
 // All positions are marked first; exit before entry. Stops use the combined equity.
 const closed=new Set();
 for(const id of ids){const p=s.fast.positions[id];if(!p.quantity)continue;
  const liquidation=fill(id,'VENDER',quotes[id].price,0,p,now),netPct=(liquidation.cashChange/p.costBasis-1)*100;
  const age=(now-Date.parse(p.openedAt))/60000;
  if(stop||netPct>=params.takeProfitPct||netPct<=-params.stopPct||age>=params.maxMinutes){
   record(id,'VENDER',stop??(netPct>=params.takeProfitPct?`Meta líquida curta atingida: ${netPct.toFixed(2)}% após custos`:netPct<=-params.stopPct?`Limite de perda da posição curta: ${netPct.toFixed(2)}%`:`Prazo da posição curta encerrado; resultado líquido ${netPct.toFixed(2)}%, sem garantia de ganho`));closed.add(id);
  }
 }
 for(const id of ids){
  const p=s.fast.positions[id],obs=s.fast.observations[id],macro=indicators(s.portfolio[id]?.observations??[]);
  if(closed.has(id))continue;
  if(p.quantity){const net=(fill(id,'VENDER',quotes[id].price,0,p,now).cashChange/p.costBasis-1)*100;record(id,'AGUARDAR',`Parcela curta: resultado de saída após custos ${net.toFixed(2)}%; alvo +${params.takeProfitPct}%, limite -${params.stopPct}%`);continue;}
  if(s.paused||config.cryptoStrategy!=='hybrid'){record(id,'AGUARDAR','Novas entradas curtas desabilitadas ou simulação pausada');continue;}
  if(Date.parse(s.fast.cooldowns[id]??0)>now){record(id,'AGUARDAR',`Intervalo entre operações até ${s.fast.cooldowns[id]}`);continue;}
  const recent=obs.slice(-3),range=recent.length===3?Date.parse(recent[2].observedAt)-Date.parse(recent[0].observedAt):0;
  if(recent.length<3||range<120000||range>10*60000){record(id,'AGUARDAR','Preparando ciclo curto: três cotações distintas em 2–10 minutos; nenhuma compra com dados repetidos');continue;}
  const recovery=recent[2].price>=recent[1].price && recent[2].price>=recent[0].price*.9998;
  const jump=(recent[2].price/recent[0].price-1)*100;
  if(!recovery||jump>1.5||macro.trendBps!=null&&macro.trendBps < -300){record(id,'AGUARDAR',`Sem estabilização para entrada curta ou movimento excessivo; variação curta ${jump.toFixed(2)}%, cenário ${macro.trendBps==null?'indisponível':(macro.trendBps/100).toFixed(2)+'%'}`);continue;}
  const core=(s.portfolio[id]?.quantity??0)*quotes[id].price;
  const aggregate=equity(s)-s.cash-(s.unsettled??[]).reduce((v,x)=>v+x.amount,0);
  const amount=Math.min(s.cash,s.initialCapital*params.entryPct/100,s.initialCapital*(config.allocations[id]??0)/100*params.fastShare,s.initialCapital*(config.allocations[id]??0)/100-core,s.initialCapital*config.exposurePct/100-aggregate);
  if(amount<1){record(id,'AGUARDAR','Sem saldo ou exposição disponível para parcela curta (mínimo virtual de R$ 1)');continue;}
  record(id,'COMPRAR',`Entrada curta após estabilização; alvo líquido +${params.takeProfitPct}%, perda máxima de referência -${params.stopPct}%, sujeito a gaps`,amount);
  if(stopReason(s,now)){s.paused=true;s.reason=stopReason(s,now);stop=s.reason;break;}
 }
 stop=stopReason(s,now);if(stop){s.paused=true;s.reason=stop;}
 // A fee can cross the global limit. Close every fast position in that case.
 if(stop)for(const id of ids)if(s.fast.positions[id].quantity>0)record(id,'VENDER',stop);
 s.events=[...s.events,...events].slice(-200);s.fast.updatedAt=new Date(now).toISOString();s.fast.params=params;
 return {state:s,duplicate:false};
}
