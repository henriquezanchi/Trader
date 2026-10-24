import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, equity } from '../lib/engine.mjs';
import { configurePortfolio, portfolioStep, PROFILES } from '../lib/portfolio.mjs';
import { marketOpen, settlementDate, releaseSettlement, parseETF, dailyIndicators, getETFs } from '../lib/markets.mjs';
import { proposal, confirmProposal } from '../lib/assisted.mjs';
import { upgradeCapital, updatePerformance, parseCDI } from '../lib/performance.mjs';
const now=Date.parse('2026-10-23T15:00:00Z');
function state(profile='diversificado-moderado'){const s=initialState(1000);s.paused=true;const c=configurePortfolio(s,{profile,...structuredClone(PROFILES[profile])});c.paused=false;return c;}
function quotes(s,at=now){return Object.fromEntries(Object.keys(s.config.allocations).map(id=>[id,{price:100,observedAt:new Date(at).toISOString(),history:Array.from({length:40},(_,i)=>({at:new Date(at-(40-i)*86400000).toISOString(),price:70+i}))}]))}
test('B3: pregão, leilão, fim de semana, feriado e liquidação D+2',()=>{
 assert.equal(marketOpen(now),true);assert.equal(marketOpen(Date.parse('2026-10-24T15:00:00Z')),false);assert.equal(marketOpen(Date.parse('2026-11-20T15:00:00Z')),false);assert.equal(marketOpen(Date.parse('2026-10-23T13:00:00Z')),false);assert.equal(settlementDate(now),'2026-10-27');
});
test('ETFs usam cotas inteiras e custos; venda reserva imposto e só libera caixa em D+2',()=>{
 const s=state(),q=quotes(s);process.env.SCHEDULER_SIGNING_KEY='synthetic-signing-key-for-market-tests-32';
 const preview=proposal(s,q,{asset:'bova11',action:'COMPRAR',amount:200},1,'test',now);assert.equal(preview.quantity,1);assert.ok(preview.amount>100&&preview.amount<101);assert.equal(s.cash,1000);
 const bought=confirmProposal(s,q,preview.token,1,'test',now+1000).state;assert.equal(bought.portfolio.bova11.quantity,1);
 q.bova11.price=110;const sell=proposal(bought,q,{asset:'bova11',action:'VENDER'},2,'test',now+2000);assert.ok(sell.estimatedTax>0);assert.equal(sell.settlement,'2026-10-27');
 const sold=confirmProposal(bought,q,sell.token,2,'test',now+3000).state;assert.equal(sold.cash,bought.cash);assert.ok(sold.unsettled[0].amount>100);assert.ok(equity(sold)>sold.cash);
 releaseSettlement(sold,Date.parse('2026-10-26T15:00:00Z'));assert.equal(sold.cash,bought.cash);releaseSettlement(sold,Date.parse('2026-10-27T15:00:00Z'));assert.equal(sold.unsettled.length,0);assert.ok(sold.cash>bought.cash);
 assert.throws(()=>proposal(s,q,{asset:'bova11',action:'COMPRAR',amount:50},1,'test',now),/cota inteira/);
});
test('ETF fechado ou sem dados não executa ordens, nem bloqueia coleta cripto',()=>{
 const s=state(),q=quotes(s,Date.parse('2026-10-24T15:00:00Z'));q.bova11={unavailable:true};const n=portfolioStep(s,q,Date.parse('2026-10-24T15:00:00Z')).state;
 assert.equal(n.portfolio.bova11.quantity,0);assert.equal(n.portfolio.bitcoin.observations.length,1);assert.ok(n.events.find(e=>e.asset==='bova11').reason.includes('Fora da janela'));
 assert.throws(()=>proposal(s,q,{asset:'bova11',action:'COMPRAR'},1,'test',Date.parse('2026-10-24T15:00:00Z')),/Fora da janela/);
});
test('histórico diário não usa candle do dia; fonte exige ativo, moeda e data válidos',async()=>{
 const history=quotes(state()).bova11.history;history.push({at:new Date(now).toISOString(),price:999999});const t=dailyIndicators(history,now);assert.equal(t.continuous,true);assert.ok(t.slowMean<200);
 assert.throws(()=>parseETF({chart:{result:[{meta:{symbol:'OTHER.SA',currency:'BRL',regularMarketPrice:100,regularMarketTime:now/1000}}]}},'bova11',now));
 const failed=await getETFs(['bova11'],async()=>({ok:false}),now);assert.equal(failed.bova11.unavailable,true);
});
test('aporte de 100 para 1000 preserva perdas, posições e histórico; repetição é inócua',()=>{
 const s=initialState(100);s.cash=99;const upgraded=upgradeCapital(s,now);assert.equal(s.cash,99);assert.equal(upgraded.initialCapital,1000);assert.equal(upgraded.cash,999);assert.equal(equity(upgraded)-upgraded.initialCapital,-1);assert.equal(upgraded.events.at(-1).action,'APORTE');assert.equal(upgradeCapital(upgraded,now+1000),upgraded);
});
test('CDI usa taxas publicadas, sem projetar futuro nem contar aporte como retorno',async()=>{
 const s=upgradeCapital(initialState(100),now-3*86400000);const rows=[{data:'21/10/2026',valor:'0,05'},{data:'22/10/2026',valor:'0.05'},{data:'24/10/2026',valor:'0.5'}];
 assert.equal(parseCDI(rows,now).length,2);const n=await updatePerformance(s,async()=>({ok:true,json:async()=>rows}),now);assert.equal(n.performance.netPnl,0);assert.ok(Math.abs(n.performance.cdi.equity-1001.00025)<.00001);assert.equal(n.performance.cdi.days,2);assert.ok(n.performance.conclusion.includes('insuficiente'));
});
test('DCA começa sem janela técnica, respeita frequência semanal e teto de BTC',()=>{
 const s=state('moderado');s.config.cryptoStrategy='dca-weekly';let n=portfolioStep(s,quotes(s),now).state;assert.equal(n.events.filter(e=>e.action==='COMPRAR').length,1);assert.equal(n.events.find(e=>e.action==='COMPRAR').asset,'bitcoin');assert.equal(n.cash,990);
 const next=portfolioStep(n,quotes(n,now+3600000),now+3600000).state;assert.equal(next.cash,990);assert.ok(next.events.at(-3).reason.includes('DCA')||next.events.some(e=>e.reason.includes('próximo aporte')));
 n.portfolio.bitcoin.quantity=.5;n.portfolio.bitcoin.lastPrice=100;n.cash=950;const capped=portfolioStep(n,quotes(n,now+8*86400000),now+8*86400000).state;assert.equal(capped.cash,n.cash);
});

test('RSI compra somente após cruzar 30 com reação; RSI baixo isolado não basta',()=>{
 const s=state('moderado');s.config.cryptoStrategy='rsi-recovery';
 for(const p of Object.values(s.portfolio))p.observations=Array.from({length:24},(_,i)=>({at:new Date(now-(24-i)*3600000).toISOString(),price:100-i}));
 const q=quotes(s);for(const v of Object.values(q))v.price=76;
 const falling=portfolioStep(s,q,now).state;assert.equal(falling.events.filter(e=>e.action==='COMPRAR').length,0);
 for(const v of Object.values(q))v.price=90;
 const recovered=portfolioStep(s,q,now).state;assert.ok(recovered.events.some(e=>e.action==='COMPRAR'));assert.equal(recovered.events.find(e=>e.action==='COMPRAR').parameters.engine,'rsi-recovery-v1');assert.ok(recovered.cash>=0);
});

test('catálogo ampliado contém 16 ativos únicos e busca dez criptos em um único lote',async()=>{
 const {ASSETS}=await import('../lib/portfolio.mjs');const {getQuotes}=await import('../lib/services.mjs');
 assert.equal(ASSETS.length,16);assert.equal(new Set(ASSETS.map(a=>a.id)).size,16);
 const ids=ASSETS.filter(a=>a.market!=='b3').map(a=>a.id);assert.equal(ids.length,10);let calls=0;
 const q=await getQuotes(ids,async()=>{calls++;return {ok:true,json:async()=>Object.fromEntries(ids.map(id=>[id,{brl:100,last_updated_at:now/1000,brl_24h_vol:1e9}]))};},now);
 assert.equal(calls,1);assert.equal(Object.keys(q).length,10);
});
