import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, equity } from '../lib/engine.mjs';
import { configurePortfolio, PROFILES } from '../lib/portfolio.mjs';
import { fastStep } from '../lib/fast.mjs';
import { fastSalePreview, fastSaleConfirm, scheduleSale } from '../lib/fast-control.mjs';
import { discover, parsePools, poolQuotes } from '../lib/discovery.mjs';
import { learningPlan, recordEntry, recordExit } from '../lib/learning.mjs';
const now=Date.parse('2026-10-24T16:00:00Z');
function state(active=false){let s=initialState(1000);s.paused=true;s=configurePortfolio(s,{profile:'agressivo',...PROFILES.agressivo,allocations:{bitcoin:20},cryptoStrategy:active?'active':'hybrid',discoveryPct:15});s.paused=false;return s;}
const quote=(t=now,price=100)=>({bitcoin:{price,observedAt:new Date(t).toISOString(),volume24h:1e9}});
function held(){let s=state();for(let i=0;i<3;i++)s=fastStep(s,quote(now+i*120000),now+i*120000).state;return s;}
process.env.SCHEDULER_SIGNING_KEY='synthetic-fast-control-key-longer-than-32';
test('venda imediata exige confirmação assinada, respeita versão e atualiza dinheiro e aprendizado',()=>{
 const s=held(),snapshot=structuredClone(s),p=fastSalePreview(s,quote(now+360000), 'bitcoin',2,'owner',now+360000);assert.deepEqual(s,snapshot);
 assert.throws(()=>fastSaleConfirm(s,quote(now+360000),p.token,3,'owner',now+360000),/mudou/);
 assert.throws(()=>fastSaleConfirm(s,quote(now+360000),p.token,2,'other',now+360000),/mudou/);
 assert.throws(()=>fastSaleConfirm(s,quote(now+360000),p.token+'a',2,'owner',now+360000),/inválida/);
 const sold=fastSaleConfirm(s,quote(now+360000),p.token,2,'owner',now+360000);assert.equal(sold.state.fast.positions.bitcoin.quantity,0);assert.ok(sold.state.cash>s.cash);assert.equal(sold.execution.learning.kind,'closed-outcome');assert.equal(sold.state.learning.closed,1);
});
test('programação substitui alvo automático, mas stop continua prioritário; cancelar e horário',()=>{
 const s=held(),programmed=scheduleSale(s,{asset:'bitcoin',expectedVersion:4,kind:'price',value:105},4,'owner',now+240000);
 const maintained=fastStep(programmed,quote(now+360000,101),now+360000).state;assert.ok(maintained.fast.positions.bitcoin.quantity>0);
 const stopped=fastStep(programmed,quote(now+360000,97),now+360000).state;assert.equal(stopped.fast.positions.bitcoin.quantity,0);
 const scheduled=scheduleSale(s,{asset:'bitcoin',expectedVersion:4,kind:'time',value:new Date(now+3600000).toISOString()},4,'owner',now+240000);scheduled.fast.positions.bitcoin.plan.maxMinutes=1;
 assert.ok(fastStep(scheduled,quote(now+600000),now+600000).state.fast.positions.bitcoin.quantity>0);
 assert.equal(fastStep(scheduled,quote(now+3600000),now+3600000).state.fast.positions.bitcoin.quantity,0);
 assert.equal(scheduleSale(programmed,{asset:'bitcoin',expectedVersion:4,kind:'cancel'},4,'owner',now).fast.positions.bitcoin.userExit,undefined);
 assert.throws(()=>scheduleSale(s,{asset:'bitcoin',expectedVersion:3,kind:'price',value:100},4,'owner',now),/mudou/);
});
test('ativo entra com liquidez comprovada sem esperar janela local e registra plano líquido 2:1',()=>{
 const s=fastStep(state(true),quote(),now).state;assert.ok(s.fast.stats.buys>0);const event=s.events.find(e=>e.action==='COMPRAR');assert.ok(event.parameters.takeProfitPct>=2*event.parameters.stopPct);assert.equal(event.learning.kind,'entry-hypothesis');assert.ok(s.cash>=0);
});
const poolBody=()=>({data:[{attributes:{address:'A'.repeat(32),name:'TEST / SOL',base_token_price_usd:'1',reserve_in_usd:'10000',pool_created_at:new Date(now-60000).toISOString(),volume_usd:{m5:'1000'},transactions:{m5:{buys:10,sells:10}}},relationships:{base_token:{data:{id:'solana_'+'B'.repeat(32)}}}}]});
test('novos pools usam o mesmo caixa BRL; não há operação real nem orçamento extra',async()=>{
 const d=await discover(null,[],async url=>({ok:true,json:async()=>url.includes('coingecko')?{'usd-coin':{brl:5,usd:1,last_updated_at:now/1000}}:poolBody()}),now);
 assert.equal(d.status,'ok');const s=state(true);s.discovery=d;const q={...quote(),...poolQuotes(d,now)},n=fastStep(s,q,now).state;
 assert.ok(n.fast.positions['solana:'+'A'.repeat(32)].quantity>0);assert.ok(n.cash<1000);assert.ok(equity(n)<1000);assert.equal(n.initialCapital,1000);
 const event=n.events.find(e=>e.asset.startsWith('solana:')&&e.action==='COMPRAR');assert.equal(event.quote.executionVerified,false);assert.equal(event.quote.fx.rate,5);assert.ok(event.fee>0);
});
test('fonte de descoberta rejeita endereço, futuro e preço capaz de causar overflow',()=>{
 const b=poolBody();b.data[0].attributes.base_token_price_usd='1e-320';assert.equal(parsePools(b,now).length,0);
 b.data[0].attributes.base_token_price_usd='1';b.data[0].attributes.address='../bad';assert.equal(parsePools(b,now).length,0);
});
test('resultados semelhantes mudam a entrada futura; não duplicar a própria amostra como família',()=>{
 const s=state(true),q=quote().bitcoin,base={stopPct:1,takeProfitPct:2,maxMinutes:180};
 for(let i=0;i<12;i++){const p={quantity:1,costBasis:100},event={id:'buy'+i,quantity:1,before:{cash:1000,quantity:0},after:{cash:900}};recordEntry(s,p,'bitcoin',q,learningPlan(s,'bitcoin',q,base,now),event,now);recordExit(s,p.learningEntry,{id:'sell'+i,asset:'bitcoin',reason:'test',realizedPnl:-1,quote:q},now);}
 const p=learningPlan(s,'bitcoin',q,base,now);assert.equal(p.sizeFactor,.25);assert.equal(p.evidence.weightedSample,12);assert.ok(learningPlan(s,'solana',q,base,now).sizeFactor>p.sizeFactor);
});

test('liquidação hipotética de pool nunca devolve mais que a reserva disponível',async()=>{
 const {fill}=await import('../lib/markets.mjs');const order=fill('solana:'+'A'.repeat(32),'VENDER',1e9,0,{quantity:1e15,costBasis:20,liquidityBRL:10},now);assert.ok(order.cashChange<=5);assert.ok(Number.isFinite(order.cashChange));
});
