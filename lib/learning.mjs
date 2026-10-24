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
export function learningPlan(state,id,quote,base,now=Date.now()) {
 const context=contextFor(id,state,quote,now),a=state.learning?.assets?.[context.assetKey]??empty(),f=state.learning?.families?.[context.scenario]??empty();
 const familyWeight=a.n>=10?.2:.5;
 const n=a.n+Math.max(0,f.n-a.n)*familyWeight,wins=a.wins+Math.max(0,f.wins-a.wins)*familyWeight;
 const probability=(wins+1)/(n+2),averageNetPct=n?(a.sumNetPct+(f.sumNetPct-a.sumNetPct)*familyWeight)/n:null;
 let sizeFactor=.75,reason='Entrada exploratória: resultados anteriores ainda insuficientes; não é probabilidade validada';
 if(n>=5){sizeFactor=averageNetPct<0?.5:.85;reason=averageNetPct<0?'Cenários semelhantes tiveram retorno líquido negativo: entrada reduzida':'Cenários semelhantes positivos, com peso limitado pela incerteza';}
 if(n>=12&&averageNetPct<0){sizeFactor=.25;reason='Persistência de perdas em cenários semelhantes: entrada reduzida a 25% do limite';}
 if(a.n>=15&&averageNetPct>0&&probability>.6){sizeFactor=1;reason='Histórico próprio positivo: limite normal liberado, sem elevar os tetos do perfil';}
 const stopPct=base.stopPct,takeProfitPct=Math.max(base.takeProfitPct,2*stopPct);
 return {...base,stopPct,takeProfitPct,sizeFactor,context,evidence:{assetTrades:a.n,familyTrades:f.n,weightedSample:n,posteriorWinRate:probability,averageNetPct,reason,model:'context-outcomes-v1'}};
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
 const bank=state.intelligence?.directionByAsset?.[id]?.[1]??state.intelligence?.directionModels?.[1];
 if(!bank?.weights||bank.trained<30)return null;
 const points=state.portfolio[id]?.observations??[],technical=indicators([...points,...(quote?.observedAt&&Date.parse(quote.observedAt)>Date.parse(points.at(-1)?.at??0)?[{at:quote.observedAt,price:quote.price}]:[])]),news=state.intelligence?.features?.[id]?.news??{available:false,count:0,score:0};
 const vector=featureVector(id,technical,{available:false,count:0,score:0},null),z=vector.reduce((sum,x,i)=>sum+x*(bank.weights[i]??0),0);
 return {probabilityUp:1/(1+Math.exp(-Math.max(-20,Math.min(20,z)))),horizonHours:1,trained:bank.trained,source:'historical-and-online-logistic',validated:(state.intelligence?.history?.[id]?.metrics?.[1]?.samples??0)>=100&&(state.intelligence?.history?.[id]?.metrics?.[1]?.balancedAccuracy??0)>=.55&&(state.intelligence?.history?.[id]?.metrics?.[1]?.accuracy??0)>=(state.intelligence?.history?.[id]?.metrics?.[1]?.baselineAccuracy??1)+.02};
}
