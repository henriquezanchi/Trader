import test from 'node:test';
import assert from 'node:assert/strict';
import { runExecutionStudy,executionSamples,normalizeExecutionPoints } from '../lib/execution-study.mjs';
import { advanceExecutionDirections } from '../lib/study-directions.mjs';
import { initialState } from '../lib/engine.mjs';
const now=Date.parse('2026-10-25T22:00:00Z');
const history=()=>Array.from({length:800},(_,i)=>({at:new Date(now-(800-i)*120000).toISOString(),observedAt:new Date(now-(800-i)*120000-20000).toISOString(),price:100+Math.sin(i/11),source:'coingecko'}));
test('prazos de execução usam minutos, janelas não sobrepostas e preços posteriores ao alvo',()=>{
 const p=history(),samples=executionSamples(p,'bitcoin',6);assert.ok(samples.length>50);
 for(let i=0;i<samples.length;i++){assert.equal(Date.parse(samples[i].targetAt)-Date.parse(samples[i].at),360000);assert.ok(Date.parse(samples[i].labelKnownAt)>=Date.parse(samples[i].targetAt));if(i)assert.ok(Date.parse(samples[i].at)>=Date.parse(samples[i-1].labelKnownAt));}
 const study=runExecutionStudy(p,'bitcoin',{now});assert.equal(study.report.protocol.horizonUnit,'minutes');assert.deepEqual(Object.keys(study.models),['6','20','60']);assert.equal(study.report.summary.horizonUnit,'minutes');
});
test('normalização conserva a primeira publicação e rejeita futuro observado ou dado velho',()=>{
 const p=history().at(-1),duplicate={...p,at:new Date(Date.parse(p.at)+1000).toISOString(),price:999},bad={...p,observedAt:new Date(Date.parse(p.at)+1).toISOString()};
 assert.equal(normalizeExecutionPoints([p,duplicate,bad]).length,1);assert.equal(normalizeExecutionPoints([p,duplicate,bad])[0].price,p.price);
});
test('testes futuros não escolhem os modelos de execução',()=>{
 const p=history(),first=runExecutionStudy(p,'bitcoin',{now}),changed=structuredClone(p);for(let i=560;i<changed.length;i++)changed[i].price*=1+(i%3)/10;
 const second=runExecutionStudy(changed,'bitcoin',{now});for(const h of [6,20,60]){assert.equal(first.report.horizons[h].chosen,second.report.horizons[h].chosen);const a=first.report.horizons[h],b=second.report.horizons[h];assert.equal(a.comparisons.find(c=>c.candidate===a.chosen).modelHash,b.comparisons.find(c=>c.candidate===b.chosen).modelHash);}
});
test('previsões de minutos não alteram saldo nem contadores horários e rejeitam avaliação antecipada',()=>{
 const p=history(),study=runExecutionStudy(p,'bitcoin',{now}),s=initialState(1000);s.config={allocations:{bitcoin:100}};s.fast={observations:{bitcoin:p.slice(-24)}};s.intelligence={scenarioLive:{sentinel:'preserve'}};
 const quote=(time,price=100)=>({bitcoin:{price,observedAt:new Date(time).toISOString()}});
 const a=advanceExecutionDirections(s,quote(now),[{id:1,asset:'bitcoin',protocol:'execution-horizons-v1',recordedAt:new Date(now).toISOString(),models:study.models}],now);
 assert.equal(a.intelligence.executionLive.pending.length,3);assert.equal(a.cash,1000);assert.deepEqual(a.intelligence.scenarioLive,s.intelligence.scenarioLive);
 const target=now+360000,b=advanceExecutionDirections(a,quote(target-1000),[],target);assert.equal(b.intelligence.executionLive.metrics['execution-horizons-v1:bitcoin:6'].stats.valid,0);
 const c=advanceExecutionDirections(b,quote(target+60000,101),[],target+60000);assert.equal(c.intelligence.executionLive.metrics['execution-horizons-v1:bitcoin:6'].stats.valid,1);assert.equal(c.cash,1000);
});
