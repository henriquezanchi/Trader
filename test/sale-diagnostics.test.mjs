import test from 'node:test';import assert from 'node:assert/strict';import{saleDiagnostics}from'../lib/sale-diagnostics.mjs';
const t=Date.now()-7200000;
const row=(net,entry=100,out=99)=>({sale_light:{id:String(net),at:new Date(t).toISOString(),asset:'bitcoin',realizedPnl:net,parameters:{explorationArm:'trend-hours'}},reason:'Prazo máximo da posição encerrado',entry_price:entry,exit_price:out,quantity:1,entry_quantity:1,before:{costBasis:100},after_hour:{price:101,observedAt:new Date(t+3600000).toISOString()}});
test('diagnóstico separa preço e custos sem descontá-los novamente; retrospectiva não é lucro realizado',()=>{
 const data=saleDiagnostics([row(-2),row(-.5,100,100.1)]),g=data.groups[0];assert.equal(data.netBRL,-2.5);assert.equal(g.priceLosses,1);assert.equal(g.costOnlyLosses,1);assert.ok(Math.abs(g.executionCostBRL-1.6)<1e-10);assert.equal(g.exits.time,2);assert.equal(g.afterHourCases,2);assert.equal(g.betterAfterHour,2);assert.ok(g.afterHourDeltaBRL>0);assert.equal(data.netBRL,-2.5);
});
test('lotes sem pareamento e cotações fora da tolerância não recebem atribuição inventada',()=>{
 const a=row(-2);a.entry_quantity=2;const b=row(-1);b.after_hour.observedAt=new Date(t+3900001).toISOString();const r=saleDiagnostics([a,b]);assert.equal(r.groups[0].unknown,1);assert.equal(r.items[0].spotPnlBRL,null);assert.equal(r.groups[0].afterHourCases,0);
});
