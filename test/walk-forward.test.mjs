import test from 'node:test';
import assert from 'node:assert/strict';
import { runWalkForward,WALK_PROTOCOL } from '../lib/walk-forward.mjs';
import { importMinuteCSV } from '../lib/minute-import.mjs';
import { profitabilityEvidence } from '../lib/profitability.mjs';
import { advanceStudyDirections } from '../lib/study-directions.mjs';
import { initialState } from '../lib/engine.mjs';
const now=Date.parse('2026-10-25T22:00:00Z');
const history=()=>Array.from({length:600},(_,i)=>({at:new Date(now-(600-i)*120000).toISOString(),observedAt:new Date(now-(600-i)*120000).toISOString(),price:100+Math.sin(i/11),source:'coingecko'}));
const profitable=()=>Array.from({length:50},(_,i)=>({probability:i%2?.2:.8,status:'scored',rawPct:i%2?-2:2}));
test('lucratividade exige expectativa líquida, estresse, robustez e vantagem sobre caixa e comprar sempre',()=>{
 const p=profitabilityEvidence(profitable(),'bitcoin');assert.equal(p.qualified,true);assert.ok(p.expectancyStressPct>0);assert.equal(p.buys,25);
 const loses=profitabilityEvidence(profitable().map(r=>({...r,rawPct:r.probability>.5?.1:2})),'bitcoin');assert.equal(loses.qualified,false);assert.ok(loses.expectancyNetPct<0);
 const short=profitabilityEvidence(profitable().slice(0,10),'bitcoin');assert.equal(short.qualified,false);
 const missing=profitable();missing[0].status='missing-price';missing[2].status='missing-price';assert.equal(profitabilityEvidence(missing,'bitcoin').qualified,false);
 const allBuy=profitable().map(r=>({...r,probability:.8,rawPct:2}));assert.equal(profitabilityEvidence(allBuy,'bitcoin').qualified,false);
});
test('um grande ganho isolado ou alto acerto com perda grande não certifica lucro',()=>{
 const outlier=profitable().map(r=>({...r,rawPct:r.probability>.5?-.2:-2}));outlier[0].rawPct=50;
 const a=profitabilityEvidence(outlier,'bitcoin');assert.ok(a.expectancyNetPct>0);assert.ok(a.withoutBestNetPct<0);assert.equal(a.qualified,false);
 const asymmetric=profitable().map(r=>({...r,rawPct:r.probability>.5?1:-2}));asymmetric[0].rawPct=-50;
 const b=profitabilityEvidence(asymmetric,'bitcoin');assert.ok(b.netWinRate>.8);assert.equal(b.qualified,false);
});
test('janelas sucessivas purgam rótulos, preservam contrafactuais e não escolhem pelo futuro',()=>{
 const points=history(),before=structuredClone(points),first=runWalkForward(points,'bitcoin',{now});
 assert.deepEqual(points,before);assert.equal(first.report.protocol.id,WALK_PROTOCOL.id);
 const changed=structuredClone(points);for(let i=360;i<changed.length;i++)changed[i].price*=1+(i%3)/10;
 const second=runWalkForward(changed,'bitcoin',{now});
 for(const h of [6,20,60]){
  const a=first.report.horizons[h],b=second.report.horizons[h];assert.equal(a.folds.length,5);assert.equal(a.comparisons.length,13);
  assert.equal(a.folds[0].chosen,b.folds[0].chosen);assert.equal(a.folds[0].modelHash,b.folds[0].modelHash);assert.deepEqual(a.folds[0].routes,b.folds[0].routes);
  assert.equal(a.opportunities.length,a.metrics.issued);assert.equal(a.goal.demonstrated,false);
  for(const f of a.folds){if(f.lastTrainingLabelAt)assert.ok(f.lastTrainingLabelAt<f.testFrom);assert.ok(f.sampledTestCases<=f.availableTestCases);}
  for(let i=0;i<a.opportunities.length;i++){
   const r=a.opportunities[i];assert.equal(r.cashNetPct,0);assert.ok(r.modelHash);assert.ok(r.labelKnownAt>=r.targetAt);
   if(i)assert.ok(r.at>=a.opportunities[i-1].labelKnownAt);
  }
 }
 assert.throws(()=>runWalkForward([...points,{...points.at(-1),at:new Date(now).toISOString(),observedAt:new Date(now).toISOString(),source:'another-provider'}],'bitcoin',{now}),/provedores/);
});
test('importação mantém preços reais em BRL, rejeita dados horários, futuros e preços conflitantes',()=>{
 const make=(step=60000)=>'available_at,observed_at,price_brl,asset\n'+Array.from({length:600},(_,i)=>{
  const t=new Date(now-(600-i)*step).toISOString();return `${t},${t},${100+i/100},bitcoin`;
 }).join('\n');
 const opts={asset:'bitcoin',source:'Fornecedor declarado',currency:'BRL',now};
 const imported=importMinuteCSV(make(),opts);assert.ok(imported.observations.length>=300);assert.equal(imported.manifest.volumeUsedByModel,false);
 assert.equal(imported.observations[0].price,100.01);assert.throws(()=>importMinuteCSV(make(),{...opts,currency:'USD'}),/BRL/);
 assert.throws(()=>importMinuteCSV(make(3600000),opts),/resolução/);
 const future=make().replaceAll(new Date(now-60000).toISOString(),new Date(now+60000).toISOString());assert.throws(()=>importMinuteCSV(future,opts),/inválido/);
 const duplicate=make()+'\n'+make().split('\n')[1].replace(',100,',',999,');assert.throws(()=>importMinuteCSV(duplicate,opts),/conflitante/);
});
test('pesquisa sucessiva emite previsões futuras isoladas, sem alterar saldo nem coortes anteriores',()=>{
 const points=history(),study=runWalkForward(points,'bitcoin',{now}),s=initialState(1000);s.config={allocations:{bitcoin:100}};s.fast={observations:{bitcoin:points.slice(-24)}};s.intelligence={executionLive:{sentinel:true}};
 const next=advanceStudyDirections(s,{bitcoin:{price:100,observedAt:new Date(now).toISOString()}},[{id:1,asset:'bitcoin',protocol:WALK_PROTOCOL.id,recordedAt:new Date(now).toISOString(),models:study.models}],now,{namespace:'walkForwardLive',short:true,protocolId:WALK_PROTOCOL.id,horizons:[6,20,60],unitMs:60000,publicationMs:120000,minTrainingCases:20,deltaKey:'walkForwardCycle'});
 assert.equal(next.cash,1000);assert.deepEqual(next.intelligence.executionLive,s.intelligence.executionLive);assert.ok(next.intelligence.walkForwardLive.pending.length>=2);assert.ok(next.researchDelta.walkForwardCycle);assert.equal(next.researchDelta.executionCycle,undefined);
});
