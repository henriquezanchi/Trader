import test from 'node:test';
import assert from 'node:assert/strict';
import { fitExpectedReturn,expectedNet,expectedStressNet,returnError } from '../lib/expected-return.mjs';
import { economicAudit,netRoundTrip } from '../lib/forecast-economics.mjs';
import { fitHistoricalDirection } from '../lib/forecast-history.mjs';
const samples=()=>Array.from({length:80},(_,i)=>({vector:[1,(i-40)/40,1],status:'scored',rawPct:1+(i-40)/40,labelKnownAt:String(i)}));
test('regressão lida com colunas constantes, é reproduzível e aprende relação sem usar teste',()=>{
 const model=fitExpectedReturn(samples(),'bitcoin');assert.equal(model.trained,80);assert.ok(expectedNet(model,[1,1,1])>expectedNet(model,[1,-1,1]));assert.deepEqual(fitExpectedReturn(samples(),'bitcoin'),model);assert.ok(model.weights.every(Number.isFinite));
 assert.equal(fitExpectedReturn(samples().slice(0,10),'bitcoin'),null);assert.equal(expectedNet(model,[1]),null);
});
test('conversão de estimativa para custos dobrados coincide com alvo conhecido',()=>{
 const net=netRoundTrip(1,'bitcoin');assert.ok(Math.abs(expectedStressNet(net,'bitcoin')-netRoundTrip(1,'bitcoin',2))<1e-10);
});
test('seleção de retorno não usa resultado futuro nem confunde probabilidade com magnitude',()=>{
 const rows=[{status:'scored',rawPct:-2,probability:.9,expectedNetPct:.2,expectedStressNetPct:-.2},{status:'scored',rawPct:-1,probability:.1,expectedNetPct:.5,expectedStressNetPct:.1}];
 const report=economicAudit(rows,'bitcoin',{minExpectedNetPct:.1}),policy=report.policies.find(p=>p.id==='expected-net');assert.equal(policy.selected,1);assert.equal(policy.netWinRate,0);assert.ok(policy.meanNetPct<0);
});
test('erro e viés são avaliados contra resultado conhecido, sem imputar ausentes',()=>{
 const model=fitExpectedReturn(samples(),'bitcoin'),actual=netRoundTrip(1,'bitcoin');
 const r=returnError([{status:'scored',rawPct:1,expectedNetPct:actual+2},{status:'missing-price',expectedNetPct:0}],model,'bitcoin');assert.equal(r.known,1);assert.ok(Math.abs(r.maePct-2)<1e-10);assert.ok(Math.abs(r.biasPct-2)<1e-10);
});
test('alterar preços do teste não muda estimador ou normalização do treino',()=>{
 const now=Date.parse('2026-10-25T12:00:00Z'),points=Array.from({length:400},(_,i)=>({at:new Date(now-(399-i)*3600000).toISOString(),price:100+i*.02+Math.sin(i/6)*2}));
 const first=fitHistoricalDirection(points,'bitcoin',now),changed=structuredClone(points);for(let i=Math.floor(points.length*.7);i<points.length;i++)changed[i].price*=1+(i%3)/10;
 const second=fitHistoricalDirection(changed,'bitcoin',now);
 for(const h of [1,6,24]){const a=first.report.protocolMetrics[h].economics.returnForecast,b=second.report.protocolMetrics[h].economics.returnForecast;assert.equal(a.modelHash,b.modelHash);assert.ok(a.model.lastTrainingLabelAt<first.report.cutoff);for(const fold of first.report.walkForward[h])assert.ok(fold.metrics.economics.returnForecast.model.lastTrainingLabelAt<fold.testFrom);}
});
