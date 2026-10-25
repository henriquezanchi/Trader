import { randomUUID } from 'node:crypto';
import { equity, validateQuote } from './engine.mjs';
import { stopReason } from './portfolio.mjs';
import { isETF, fill, costs } from './markets.mjs';
import { indicators } from './indicators.mjs';
import { blendFor } from './blend.mjs';
import { isPool } from './discovery.mjs';
import { scheduledExit } from './fast-control.mjs';
import { learningPlan, recordEntry, recordExit, directionEvidence } from './learning.mjs';
export { BLENDS, blendFor } from './blend.mjs';

export function fastStep(previous,quotes,now=Date.now()){
 const active=previous.config?.cryptoStrategy==='active',enabled=active||previous.config?.cryptoStrategy==='hybrid';
 if(!enabled&&!Object.values(previous.fast?.positions??{}).some(p=>p.quantity>0))return {state:previous,duplicate:true};
 const slot=String(Math.floor(now/120000));if(previous.fast?.lastSlot===slot)return {state:previous,duplicate:true};
 const s=structuredClone(previous),config=s.config,legacy=blendFor(config);
 const params=active?{...legacy,stopPct:config.profile.includes('agressivo')?.6:config.profile.includes('conservador')?.4:.5,takeProfitPct:config.profile.includes('agressivo')?1.2:config.profile.includes('conservador')?.8:1,maxMinutes:180}:legacy;
 s.fast??={positions:{},observations:{},cooldowns:{},lastSlot:null};s.fast.lastSlot=slot;
 const candidates=active&&config.discoveryPct>0?(s.discovery?.liveIds??[]).sort((a,b)=>(quotes[b]?.liquidityUSD??0)-(quotes[a]?.liquidityUSD??0)).slice(0,20):[];
 const ids=[...new Set([...Object.keys(s.fast.positions).filter(id=>s.fast.positions[id].quantity>0),...candidates,...Object.keys(config.allocations).filter(id=>!isETF(id))])];
 const available=new Set(),blocked={};
 for(const id of ids){
  try{validateQuote(quotes[id],now);if(now-Date.parse(quotes[id].observedAt)>120000)throw Error('Cotação antiga: mais de dois minutos');available.add(id);}
  catch(error){if(!active&&!isPool(id))throw error;blocked[id]='Sem preço executável recente; não criar uma execução fictícia. Os demais ativos continuam sendo avaliados';}
  const q=quotes[id],p=s.fast.positions[id]??={quantity:0,costBasis:0,lastPrice:0};p.market=isPool(id)?'dex':'crypto';p.lastSeenAt=new Date(now).toISOString();p.symbol=s.discovery?.assets?.[id]?.symbol??p.symbol;
  if(available.has(id)){p.lastPrice=q.price;p.liquidityBRL=q.liquidityBRL??p.liquidityBRL;if(isPool(id))p.liquidationValue=p.quantity>0?fill(id,'VENDER',p.lastPrice,0,p,now).cashChange:0;}
  const obs=s.fast.observations[id]??=[];
  if(available.has(id)&&(!obs.length||Date.parse(q.observedAt)>Date.parse(obs.at(-1).observedAt)))obs.push({at:new Date(now).toISOString(),observedAt:q.observedAt,price:q.price});
  s.fast.observations[id]=obs.slice(-120);
 }
 let stop=stopReason(s,now);if(stop){s.paused=true;s.reason=stop;}
 const events=[];
 function record(id,action,reason,budget=0,plan=s.fast.positions[id].plan??params){
  const p=s.fast.positions[id],q=quotes[id]??{},before={cash:s.cash,quantity:p.quantity,equity:equity(s),costBasis:p.costBasis},entry=p.learningEntry,userOrder=p.userExit;
  let order={quantity:0,fee:0,executionPrice:q.price??p.lastPrice,realizedPnl:null};
  if(action!=='AGUARDAR'){
   order=fill(id,action,q.price,budget,p,now);s.cash+=order.cashChange;
   if(action==='COMPRAR'){p.quantity=order.quantity;p.costBasis=-order.cashChange;p.openedAt=new Date(now).toISOString();p.plan={stopPct:plan.stopPct,takeProfitPct:plan.takeProfitPct,maxMinutes:plan.maxMinutes};}
   else{p.quantity=0;p.costBasis=0;p.closedAt=new Date(now).toISOString();delete p.userExit;delete p.learningEntry;s.fast.cooldowns[id]=new Date(now+params.cooldownMinutes*60000).toISOString();}
  }
  if(isPool(id))p.liquidationValue=p.quantity>0?fill(id,'VENDER',p.lastPrice,0,p,now).cashChange:0;
  const event={id:randomUUID(),at:new Date(now).toISOString(),asset:id,assetSymbol:p.symbol,mode:'fast',action,reason,quantity:order.quantity,fee:order.fee,executionPrice:order.executionPrice,price:q.price??p.lastPrice,realizedPnl:order.realizedPnl,equity:equity(s),
   indicators:{macro:indicators(s.portfolio[id]?.observations??[]),recentQuotes:s.fast.observations[id].slice(-3),directionForecast:directionEvidence(s,id,q),entryRule:active?'Active liquidity/context scan; small exploratory entries; shared risk caps':'Three distinct quotes with stabilization'},
   parameters:{engine:active?'active-adaptive-v1':'hybrid-fast-v1',...params,...plan,...costs(id),netTarget:true,userOrder:userOrder??null,config:structuredClone(config)},quote:{...q,source:q.source??(isPool(id)?'geckoterminal-unavailable':'coingecko')},before,after:{cash:s.cash,quantity:p.quantity,equity:equity(s),costBasis:p.costBasis}};
  if(action==='COMPRAR')event.learning=recordEntry(s,p,id,q,plan,event,now);
  if(action==='VENDER')event.learning=recordExit(s,entry,event,now);
  const stats=s.fast.stats??={buys:0,sells:0,wins:0,losses:0,fees:0,realizedPnl:0};
  if(action!=='AGUARDAR'){stats.fees+=order.fee;if(action==='COMPRAR')stats.buys++;else{stats.sells++;stats.realizedPnl+=order.realizedPnl??0;if(order.realizedPnl>0)stats.wins++;else if(order.realizedPnl<0)stats.losses++;}}
  events.push(event);
 }
 const closed=new Set();
 for(const id of ids){const p=s.fast.positions[id];if(!p.quantity||!available.has(id))continue;
  const plan=p.plan??params,netPct=(fill(id,'VENDER',quotes[id].price,0,p,now).cashChange/p.costBasis-1)*100,age=(now-Date.parse(p.openedAt))/60000,maxMinutes=p.userExit?.kind==='time'?Math.max(plan.maxMinutes,(Date.parse(p.userExit.value)-Date.parse(p.openedAt))/60000+2):plan.maxMinutes;
  const userExit=scheduledExit(p,quotes[id],netPct,now),direction=active?directionEvidence(s,id,quotes[id]):null;
  const forecastExit=direction?.validated&&direction.probabilityUp<.35?'Saída antecipada: modelo com suporte no teste histórico estima maior chance de queda no horizonte de 1h':null;
  if(stop||userExit||!p.userExit&&netPct>=plan.takeProfitPct||netPct<=-plan.stopPct||age>=maxMinutes||!p.userExit&&forecastExit){
   record(id,'VENDER',stop??(netPct<=-plan.stopPct?`Limite de perda da posição: ${netPct.toFixed(2)}% líquido`:userExit??forecastExit??(netPct>=plan.takeProfitPct?`Meta líquida curta atingida: ${netPct.toFixed(2)}% após custos`:`Prazo máximo da posição encerrado; resultado líquido ${netPct.toFixed(2)}%`)));closed.add(id);
  }
 }
 for(const id of ids){
  const p=s.fast.positions[id],q=quotes[id],obs=s.fast.observations[id],macro=indicators(s.portfolio[id]?.observations??[]);
  if(closed.has(id))continue;
  if(!available.has(id)){record(id,'AGUARDAR',blocked[id]);continue;}
  if(p.quantity){const plan=p.plan??params,net=(fill(id,'VENDER',q.price,0,p,now).cashChange/p.costBasis-1)*100;record(id,'AGUARDAR',`Manter posição: saída agora realizaria ${net.toFixed(2)}% líquido; alvo +${plan.takeProfitPct}%, limite -${plan.stopPct}%, prazo ${plan.maxMinutes} min${p.userExit?'; venda programada ativa':''}`);continue;}
  if(s.paused||!enabled){record(id,'AGUARDAR','Risco: novas entradas desabilitadas ou simulação pausada');continue;}
  if(Date.parse(s.fast.cooldowns[id]??0)>now){record(id,'AGUARDAR',`Evitar recompra imediata e custos repetidos: intervalo até ${s.fast.cooldowns[id]}`);continue;}
  let planBase=params;
  if(isPool(id)){
   const age=(now-Date.parse(q.createdAt))/60000;
   if(age>60||q.liquidityUSD<1000||q.volume5mUSD<100||q.buys5m<1||q.sells5m<1){record(id,'AGUARDAR',`Novo pool fora dos critérios: idade ${age.toFixed(1)} min (máx. 60), liquidez US$ ${q.liquidityUSD}, volume 5min US$ ${q.volume5mUSD}, compras/vendas recentes ${q.buys5m}/${q.sells5m}. Segurança e venda futura não verificadas`);continue;}
   if(Object.entries(s.fast.positions).some(([other,h])=>other!==id&&h.quantity>0&&quotes[other]?.token===q.token)){record(id,'AGUARDAR','Concentração: já existe posição neste token em outro pool');continue;}
   const budget=Math.min(20,s.cash),entry=fill(id,'COMPRAR',q.price,budget,p,now),roundTrip=fill(id,'VENDER',q.price,0,{...p,quantity:entry.quantity,costBasis:budget},now);
   const friction=(1-roundTrip.cashChange/budget)*100;planBase={...params,stopPct:Math.max(8,friction+3),takeProfitPct:Math.max(16,2*(friction+3)),maxMinutes:45};
  }else if(active){
   const direction=directionEvidence(s,id,q);
   if(!(q.volume24h>=1000000)){record(id,'AGUARDAR',`Liquidez insuficiente ou não comprovada: volume 24h ${q.volume24h??'não verificado'} BRL; mínimo R$ 1 milhão`);continue;}
   if(macro.trendBps!=null&&macro.trendBps< -500||direction?.validated&&direction.probabilityUp<.4){record(id,'AGUARDAR',`Cenário desfavorável: tendência ${macro.trendBps==null?'não medida':(macro.trendBps/100).toFixed(2)+'%'}; previsão de alta ${direction?(direction.probabilityUp*100).toFixed(1)+'%':'ainda não calibrada'}`);continue;}
  }else{
   const recent=obs.slice(-3),range=recent.length===3?Date.parse(recent[2].observedAt)-Date.parse(recent[0].observedAt):0;
   if(recent.length<3||range<120000||range>600000){record(id,'AGUARDAR','Preparando ciclo curto: três cotações distintas em 2–10 minutos; nenhuma compra com dados repetidos');continue;}
   const recovery=recent[2].price>=recent[1].price&&recent[2].price>=recent[0].price*.9998,jump=(recent[2].price/recent[0].price-1)*100;
   if(!recovery||jump>1.5||macro.trendBps!=null&&macro.trendBps< -300){record(id,'AGUARDAR',`Sem estabilização para entrada curta ou movimento excessivo; variação curta ${jump.toFixed(2)}%, cenário ${macro.trendBps==null?'não medido':(macro.trendBps/100).toFixed(2)+'%'}`);continue;}
  }
  const plan=active?learningPlan(s,id,q,planBase,now):planBase;
  if(plan.blockedUntil){record(id,'AGUARDAR',`Proteção econômica: ${plan.evidence.reason}; ${plan.evidence.familyTrades} resultados históricos nesta família; novas entradas bloqueadas até ${plan.blockedUntil}. Não é falta de dados`);continue;}
  const core=(s.portfolio[id]?.quantity??0)*q.price;
  const aggregate=equity(s)-s.cash-(s.unsettled??[]).reduce((v,x)=>v+x.amount,0),poolExposure=Object.entries(s.fast.positions).filter(([key])=>isPool(key)).reduce((v,[,h])=>v+h.quantity*h.lastPrice,0);
  const assetCap=isPool(id)?Math.min(s.initialCapital*.02,s.initialCapital*(config.discoveryPct??0)/100-poolExposure):Math.min(s.initialCapital*(config.allocations[id]??0)/100*params.fastShare,s.initialCapital*(config.allocations[id]??0)/100-core);
  let amount=Math.min(s.cash,s.initialCapital*params.entryPct/100,assetCap,s.initialCapital*config.exposurePct/100-aggregate,s.initialCapital*.005/(plan.stopPct/100))*(plan.sizeFactor??1);
  if(isPool(id)&&amount>=5){
   const preview=fill(id,'COMPRAR',q.price,amount,p,now),exit=fill(id,'VENDER',q.price,0,{...p,quantity:preview.quantity,costBasis:amount},now),friction=(1-exit.cashChange/amount)*100;
   if(friction>20){record(id,'AGUARDAR',`Custo econômico excessivo: ida e volta estimada em ${friction.toFixed(2)}% antes de qualquer movimento do mercado`);continue;}
   plan.stopPct=Math.max(plan.stopPct,friction+3);plan.takeProfitPct=Math.max(plan.takeProfitPct,2*plan.stopPct);
   if(amount*plan.stopPct/100>s.initialCapital*.005){record(id,'AGUARDAR','Risco estimado da entrada em pool excede 0,5% do capital; não aumentar a perda permitida para forçar uma operação');continue;}
  }
  if(amount<(isPool(id)?5:1)){record(id,'AGUARDAR',`Limite financeiro: disponível para esta entrada ${amount.toFixed(2)} BRL; caixa, peso do ativo, exposição total e risco por operação foram considerados`);continue;}
  record(id,'COMPRAR',`${isPool(id)?'Entrada na detecção de novo pool; execução apenas hipotética, taxas de token e segurança não verificadas':active?'Entrada ativa: liquidez verificada e contexto sem bloqueio de risco':'Entrada curta após estabilização'}; alvo líquido +${plan.takeProfitPct.toFixed(2)}%, perda de referência -${plan.stopPct.toFixed(2)}%. ${plan.evidence?.reason??''}`,amount,plan);
  if(stopReason(s,now)){stop=stopReason(s,now);s.paused=true;s.reason=stop;break;}
 }
 stop=stopReason(s,now);if(stop){s.paused=true;s.reason=stop;for(const id of ids)if(s.fast.positions[id].quantity>0&&available.has(id))record(id,'VENDER',stop);}
 const dormant=Object.keys(s.fast.positions).filter(id=>isPool(id)&&s.fast.positions[id].quantity===0).sort((a,b)=>Date.parse(s.fast.positions[b].lastSeenAt)-Date.parse(s.fast.positions[a].lastSeenAt));for(const id of dormant.slice(100)){delete s.fast.positions[id];delete s.fast.observations[id];delete s.fast.cooldowns[id];}
 s.events=[...s.events,...events].slice(-200);s.fast.updatedAt=new Date(now).toISOString();s.fast.params=params;
 return {state:s,duplicate:false};
}
