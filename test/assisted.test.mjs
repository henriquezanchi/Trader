import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../lib/engine.mjs';
import { configurePortfolio, PROFILES } from '../lib/portfolio.mjs';
import { proposal, confirmProposal, simulateOrder, activeIds } from '../lib/assisted.mjs';
const now = Date.parse('2026-10-23T12:00:00Z');
const make = () => { const s = initialState(1000); s.paused = true; const p = configurePortfolio(s, { ...structuredClone(PROFILES.moderado), profile: 'moderado' }); p.paused = false; return p; };
const quotes = s => Object.fromEntries(activeIds(s).map(id => [id, {price: 100, observedAt: new Date(now).toISOString()}]));
process.env.SCHEDULER_SIGNING_KEY = 'synthetic-test-signing-key-32-characters';
test('prévia não altera carteira; confirmação registra custos e preserva agendamento', () => {
 const s=make(), q=quotes(s), original=structuredClone(s); const p=proposal(s,q,{asset:'bitcoin',action:'COMPRAR',amount:10},3,'owner',now);
 assert.deepEqual(s,original); assert.equal(p.fee,.01); assert.ok(p.after.equity<p.before.equity); assert.equal(p.scenarios.length,3);
 const r=confirmProposal(s,q,p.token,3,'owner',now+1000);
 assert.equal(r.state.cash,s.cash-10); assert.ok(r.state.portfolio.bitcoin.quantity>0); assert.equal(r.execution.mode,'assisted'); assert.equal(r.execution.approvedBy,'owner'); assert.equal(r.state.lastTick,s.lastTick);
 assert.throws(()=>confirmProposal(r.state,q,p.token,4,'owner',now+2000),/estado mudou/);
 const sold=simulateOrder(r.state,q,{asset:'bitcoin',action:'VENDER'},now+2000); assert.equal(sold.state.portfolio.bitcoin.quantity,0); assert.ok(sold.realizedPnl<0);
});
test('proposta rejeita adulteração, outro usuário, vencimento, preço alterado e limites',()=>{
 const s=make(),q=quotes(s),p=proposal(s,q,{asset:'bitcoin',action:'COMPRAR',amount:10},3,'owner',now);
 assert.throws(()=>confirmProposal(s,q,p.token+'a',3,'owner',now),/inválida/);
 assert.throws(()=>confirmProposal(s,q,p.token,3,'other',now),/estado mudou/);
 assert.throws(()=>confirmProposal(s,q,p.token,3,'owner',now+60000),/vencida/);
 assert.throws(()=>confirmProposal(s,{...q,bitcoin:{...q.bitcoin,price:101}},p.token,3,'owner',now),/variou/);
 assert.throws(()=>proposal(s,q,{asset:'bitcoin',action:'COMPRAR',amount:1000},3,'owner',now),/excede/);
 assert.throws(()=>proposal(s,q,{asset:'bitcoin',action:'COMPRAR',amount:10},3,'owner',now+121000),/dois minutos/);
 s.paused=true; assert.throws(()=>proposal(s,q,{asset:'bitcoin',action:'COMPRAR',amount:10},3,'owner',now),/Inicie/);
});
