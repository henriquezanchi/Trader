import { forecastReadiness } from './forecast-assessment.mjs';
import { indicators, featureVector } from './indicators.mjs';
import { isPool } from './discovery.mjs';
import { isETF } from './markets.mjs';
const empty=()=>({n:0,wins:0,sumNetPct:0,sumR:0});
export function contextFor(id,state,quote,now) {
 const technical=indicators(state.portfolio[id]?.observations??[]);
 const family=isPool(id)?'new-solana-pool':isETF(id)?'etf': ['bitcoin','ethereum'].includes(id)?'major-crypto':'liquid-altcoin';
 const trend=technical.trendBps==null?'macro-unknown':technical.trendBps>20?'up':technical.trendBps< -20?'down':'flat';
 const vol=technical.volatilityPct==null?'unknown':technical.volatilityPct>.7?'high':technical.volatilityPct>.2?'medium':'low';
 const scenario=`${family}|${trend}|${vol}|${state.config?.cryptoStrategy??'manual'}`;
 return {asset:id,family,scenario,assetKey:id+'|'+scenario,at:new Date(now).toISOString(),technical,quoteSource:quote?.source??'coingecko'};
}
// Group lots closed by the same sale: they are one economic decision, not
// independent evidence. Net P/L already includes execution costs.
export function economicEvidence(summaries=[],scenario){
 const sales=new Map();
 for(const row of summaries){
  if(row.kind!=='closed-outcome'||row.context?.scenario!==scenario||!row.exitId||!Number.isFinite(row.realizedPnl))continue;
  const sale=sales.get(row.exitId)??{net:0,at:row.at};sale.net+=row.realizedPnl;sales.set(row.exitId,sale);
 }
 const rows=[...sales.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-30);
 const wins=rows.filter(r=>r.net>0),losses=rows.filter(r=>r.net<0),grossWins=wins.reduce((s,r)=>s+r.net,0),grossLosses=-losses.reduce((s,r)=>s+r.net,0);
 const averageWin=wins.length?grossWins/wins.length:null,averageLoss=losses.length?grossLosses/losses.length:null;
 return {method:'recent-net-sales-v1',sales:rows.length,wins:wins.length,losses:losses.length,winRate:rows.length?wins.length/rows.length:null,
 netPnl:grossWins-grossLosses,expectancyBRL:rows.length?(grossWins-grossLosses)/rows.length:null,
 profitFactor:grossLosses>0?grossWins/grossLosses:null,averageWinBRL:averageWin,averageLossBRL:averageLoss,
 breakEvenWinRate:averageWin!=null&&averageLoss!=null?averageLoss/(averageWin+averageLoss):null,
 lastAt:rows.at(-1)?.at??null,note:'Até 30 vendas recentes; lotes agrupados por venda. Evidência descritiva, não validação fora da amostra.'};
}
export function learningPlan(state,id,quote,base,now=Date.now()) {
 const context=contextFor(id,state,quote,now),a=state.learning?.assets?.[context.assetKey]??empty(),f=state.learning?.families?.[context.scenario]??empty();
 const familyWeight=a.n>=10?.2:.5;
 const n=a.n+Math.max(0,f.n-a.n)*familyWeight,wins=a.wins+Math.max(0,f.wins-a.wins)*familyWeight;
 const probability=(wins+1)/(n+2),averageNetPct=n?(a.sumNetPct+(f.sumNetPct-a.sumNetPct)*familyWeight)/n:null;
 let sizeFactor=.75,reason='Entrada exploratória: resultados anteriores ainda insuficientes; não é probabilidade validada';
 if(n>=5){sizeFactor=averageNetPct<0?.5:.85;reason=averageNetPct<0?'Cenários semelhantes tiveram retorno líquido negativo: entrada reduzida':'Cenários semelhantes positivos, com peso limitado pela incerteza';}
 if(n>=12&&averageNetPct<0){sizeFactor=.25;reason='Persistência de perdas em cenários semelhantes: entrada reduzida a 25% do limite';}
 if(a.n>=15&&averageNetPct>0&&probability>.6){sizeFactor=1;reason='Histórico próprio positivo: limite normal liberado, sem elevar os tetos do perfil';}
 const familyMean=f.n?f.sumNetPct/f.n:null,blockedUntil=f.n>=20&&familyMean< -1&&f.wins/f.n<.4&&Date.parse(f.lastAt)+6*3600000>now?new Date(Date.parse(f.lastAt)+6*3600000).toISOString():null;
 const economics=economicEvidence(state.learning?.summaries,context.scenario);
 if(economics.sales>=10&&economics.expectancyBRL<0){sizeFactor=Math.min(sizeFactor,.25);reason=`Resultado econômico recente negativo: ${economics.sales} vendas, média líquida R$ ${economics.expectancyBRL.toFixed(2)} por venda; entrada limitada a 25%, mesmo com muitos acertos`;}
 const economicBlockedUntil=economics.sales>=20&&economics.expectancyBRL<0&&Date.parse(economics.lastAt)+6*3600000>now?new Date(Date.parse(economics.lastAt)+6*3600000).toISOString():null;
 const effectiveBlock=[blockedUntil,economicBlockedUntil].filter(Boolean).sort().at(-1)??null;
 const stopPct=base.stopPct,takeProfitPct=Math.max(base.takeProfitPct,2*stopPct);
 return {...base,stopPct,takeProfitPct,sizeFactor,context,blockedUntil:effectiveBlock,evidence:{assetTrades:a.n,familyTrades:f.n,weightedSample:n,posteriorWinRate:probability,averageNetPct,reason,blockedUntil:effectiveBlock,economics,familyAverageNetPct:familyMean,model:'context-outcomes-v2'}};
}
export function recordEntry(state,position,id,quote,plan,event,now) {
 const context=plan.context??contextFor(id,state,quote,now);
 const lot={id:event.id,context,quantity:event.quantity,costBasis:Math.max(0,event.before.cash-event.after.cash),at:new Date(now).toISOString(),plan:{stopPct:plan.stopPct,takeProfitPct:plan.takeProfitPct,maxMinutes:plan.maxMinutes},evidence:plan.evidence??null};
 const prior=position.learningEntry;
 if(event.before.quantity>0){const lots=prior?.lots??(prior?[prior]:[{id:null,context:null,quantity:event.before.quantity,costBasis:event.before.costBasis}]);position.learningEntry={lots:[...lots,lot]};}else position.learningEntry=lot;
 return {kind:'entry-hypothesis',summary:`Entrada ${id}: cenário ${context.scenario}; alvo líquido +${plan.takeProfitPct}%, perda de referência -${plan.stopPct}%. Resultado ainda desconhecido; compra não conta como acerto.`,context,evidence:plan.evidence??null};
}
export function recordExit(state,entry,event,now) {
 if(entry?.lots){const proceeds=event.saleProceeds??(Number.isFinite(event.realizedPnl)&&Number.isFinite(event.before?.costBasis)?event.realizedPnl+event.before.costBasis:null);const total=entry.lots.reduce((v,l)=>v+(l.quantity??0),0);const outcomes=entry.lots.map(l=>recordExit(state,l,{...event,realizedPnl:Number.isFinite(proceeds)&&Number.isFinite(l.costBasis)?proceeds*(l.quantity/total)-l.costBasis:null},now));return {kind:'closed-lots',summary:`Venda de posição com ${entry.lots.length} entradas; resultados atribuídos proporcionalmente às quantidades e custos de cada compra.`,outcomes};}

 if(!entry?.context||!Number.isFinite(event.realizedPnl)||!(entry.costBasis>0))return {kind:'exit-unpaired',summary:'Saída registrada; contexto original de entrada ausente. Não treinar como se a hipótese inicial fosse conhecida.'};
 state.learning??={assets:{},families:{},summaries:[],closed:0};const l=state.learning,netPct=event.realizedPnl/entry.costBasis*100,r=netPct/entry.plan.stopPct;
 const update=(map,key)=>{const s=map[key]??=empty();s.n++;s.wins+=Number(event.realizedPnl>0);s.sumNetPct+=netPct;s.sumR+=r;s.lastAt=new Date(now).toISOString();};
 update(l.assets,entry.context.assetKey);update(l.families,entry.context.scenario);l.closed++;
 const synthesis={kind:'closed-outcome',at:new Date(now).toISOString(),entryId:entry.id,exitId:event.id,asset:event.asset,context:entry.context,netPct,realizedPnl:event.realizedPnl,rMultiple:r,minutes:(now-Date.parse(entry.at))/60000,
 summary:`${event.asset}: ${netPct.toFixed(2)}% líquido (${r.toFixed(2)}R), ${event.realizedPnl>0?'ganho':'perda ou empate'}. Cenário ${entry.context.scenario}; motivo da saída: ${event.reason}. Atualizados histórico do ativo e grupo; uma operação isolada não prova a estratégia.`,nextBehavior:learningPlan(state,event.asset,event.quote,entry.plan,now).evidence};
 l.summaries=[...l.summaries,synthesis].slice(-100);l.updatedAt=new Date(now).toISOString();
 const keys=Object.keys(l.assets);if(keys.length>1000)for(const key of keys.sort((a,b)=>Date.parse(l.assets[a].lastAt)-Date.parse(l.assets[b].lastAt)).slice(0,keys.length-1000))delete l.assets[key];
 return synthesis;
}

export function directionEvidence(state,id,quote){
 const r=state.intelligence,p=r?.latestDirectionalForecasts?.[id]?.[1],at=Date.parse(quote?.observedAt);
 if(!p||!Number.isFinite(at)||at<Date.parse(p.priceAt)||at>Date.parse(p.targetAt))return null;
 const assessed=forecastReadiness(state,id,1,at),{economics,...readiness}=assessed,supported=readiness.ready;
 return {forecastId:p.id,protocolId:p.protocolId,modelHash:p.modelHash,inputHash:p.inputHash,probabilityUp:p.probability,horizonHours:1,knownAt:p.knownAt,targetAt:p.targetAt,source:'registered-forecast',validated:Boolean(supported),readiness,supportNote:supported?'Critérios mínimos empíricos atendidos; não é garantia de lucro':'Sem superioridade demonstrada nas avaliações auditáveis; não tratar como vantagem comprovada'};
}
