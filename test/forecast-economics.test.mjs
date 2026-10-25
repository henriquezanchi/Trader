import test from 'node:test';
import assert from 'node:assert/strict';
import { economicAudit,netRoundTrip } from '../lib/forecast-economics.mjs';
import { fill } from '../lib/markets.mjs';
import { fitHistoricalDirection,applyHistoricalDirection } from '../lib/forecast-history.mjs';
import { initialState } from '../lib/engine.mjs';
const now=Date.parse('2026-10-25T12:00:00Z');
test('custo do diagnóstico coincide com compra e venda do simulador sem descontar duas vezes',()=>{
 const budget=100,entry=fill('bitcoin','COMPRAR',100,budget,{},now),exit=fill('bitcoin','VENDER',101,0,{quantity:entry.quantity,costBasis:budget},now+3600000);
 assert.ok(Math.abs(netRoundTrip(1,'bitcoin')-exit.realizedPnl)<1e-10);
});
test('prever alta corretamente pode perder depois dos custos; estresse piora o resultado',()=>{
 const r=economicAudit([{probability:.7,status:'scored',rawPct:.1}],'bitcoin');const p=r.policies[0];
 assert.equal(p.directionalHitRate,1);assert.equal(p.netWinRate,0);assert.ok(p.meanNetPct<0);assert.ok(p.meanStressNetPct<p.meanNetPct);assert.ok(r.breakEvenRawPct>.4);
});
test('regra de seleção só olha a probabilidade; resultado ausente não desaparece',()=>{
 const r=economicAudit([{probability:.7,status:'missing-price'},{probability:.55,status:'scored',rawPct:1},{probability:.4,status:'scored',rawPct:100}],'bitcoin');
 assert.equal(r.policies[1].selected,1);assert.equal(r.policies[1].missing,1);assert.equal(r.policies[1].meanNetPct,null);assert.equal(r.policies[0].selected,2);assert.equal(r.policies[2].selected,3);
});
test('auditoria do mesmo histórico preserva modelos online, pendentes, saldo e pausa',()=>{
 const points=Array.from({length:400},(_,i)=>({at:new Date(now-(399-i)*3600000).toISOString(),price:100+i*.02+Math.sin(i/6)*2}));
 const fitted=fitHistoricalDirection(points,'bitcoin',now);let s=structuredClone(applyHistoricalDirection(initialState(1000),fitted,now).state);
 delete s.intelligence.history.bitcoin.protocolMetrics[1].economics.returnForecast;
 s.intelligence.directionByAsset.bitcoin[1].weights[0]=4;s.intelligence.directionPending=[{id:'keep'}];s.paused=true;
 const before=structuredClone(s),result=applyHistoricalDirection(s,fitted,now);
 assert.equal(result.duplicate,false);assert.equal(result.state.cash,before.cash);assert.equal(result.state.paused,true);assert.deepEqual(result.state.intelligence.directionByAsset,before.intelligence.directionByAsset);assert.deepEqual(result.state.intelligence.directionPending,before.intelligence.directionPending);
 assert.equal(result.state.intelligence.history.bitcoin.protocolMetrics[1].economics.protocol,'hourly-direction-cost-audit-v2');assert.equal(applyHistoricalDirection(result.state,fitted,now).duplicate,true);
});
