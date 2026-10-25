import test from 'node:test';
import assert from 'node:assert/strict';
import { economicEvidence, learningPlan, contextFor } from '../lib/learning.mjs';
const now=Date.parse('2026-10-24T20:00:00Z');
const row=(id,pnl,scenario='s')=>({kind:'closed-outcome',exitId:id,context:{scenario},realizedPnl:pnl,at:new Date(now).toISOString()});
test('muitos acertos não escondem expectativa negativa; taxas não são descontadas duas vezes',()=>{
 const r=economicEvidence([...Array.from({length:18},(_,i)=>row('w'+i,1)),row('l1',-20),row('l2',-20)],'s');
 assert.equal(r.winRate,.9);assert.equal(r.netPnl,-22);assert.equal(r.expectancyBRL,-1.1);assert.equal(r.profitFactor,.45);assert.ok(r.breakEvenWinRate>r.winRate);
});
test('lotes da mesma venda são agrupados antes de medir acertos',()=>{
 const r=economicEvidence([row('sale',2),row('sale',-3),row('other',100,'other')],'s');
 assert.equal(r.sales,1);assert.equal(r.losses,1);assert.equal(r.netPnl,-1);
});
test('evidência econômica limita entrada e gera bloqueio temporário mesmo com 90% de acertos',()=>{
 const s={portfolio:{},config:{cryptoStrategy:'active'}},q={price:100},c=contextFor('bitcoin',s,q,now);
 s.learning={summaries:[...Array.from({length:18},(_,i)=>row('w'+i,1,c.scenario)),row('l1',-20,c.scenario),row('l2',-20,c.scenario)]};
 const p=learningPlan(s,'bitcoin',q,{stopPct:1,takeProfitPct:2},now);
 assert.equal(p.sizeFactor,.25);assert.ok(Date.parse(p.blockedUntil)>now);assert.equal(p.evidence.economics.sales,20);
 assert.equal(learningPlan(s,'bitcoin',q,{stopPct:1,takeProfitPct:2},now+7*3600000).blockedUntil,null);
});
test('sem perdas ou sem amostra não inventa profit factor infinito nem taxa de equilíbrio',()=>{
 assert.equal(economicEvidence([],'s').expectancyBRL,null);
 const r=economicEvidence([row('w',2)],'s');assert.equal(r.profitFactor,null);assert.equal(r.breakEvenWinRate,null);
});
