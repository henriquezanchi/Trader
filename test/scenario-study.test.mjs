import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenarioStudy,CANDIDATES,SCENARIOS,goalEvidence } from '../lib/scenario-study.mjs';
import { advanceStudyDirections } from '../lib/study-directions.mjs';
import { initialState } from '../lib/engine.mjs';
const now=Date.parse('2026-10-25T12:00:00Z');
const history=()=>Array.from({length:400},(_,i)=>({at:new Date(now-(400-i)*3600000).toISOString(),price:100+Math.sin(i/7)*3+i*.02}));
test('dez métodos e 27 cenários são reportados sem fabricar casos nas categorias vazias',()=>{
 const {report}=runScenarioStudy(history(),'bitcoin',{now});assert.equal(CANDIDATES.length,10);assert.equal(SCENARIOS.length,27);
 for(const h of [1,6,24]){const r=report.horizons[h];assert.equal(r.comparisons.length,10);assert.equal(r.championTest.scenarios.length,27);assert.equal(r.championTest.scenarios.reduce((s,r)=>s+r.valid,0),r.championTest.metrics.valid);assert.equal(r.goal.demonstrated,false);assert.equal(r.goal.realTradingEnabled,false);}
});
test('mudar todo o teste não muda escolha, normalização ou coeficientes dos campeões',()=>{
 const points=history(),first=runScenarioStudy(points,'bitcoin',{now}),changed=structuredClone(points);for(let i=280;i<changed.length;i++)changed[i].price*=1+(i%4)/3;
 const second=runScenarioStudy(changed,'bitcoin',{now});for(const h of [1,6,24]){assert.equal(first.report.horizons[h].chosen,second.report.horizons[h].chosen);const a=first.report.horizons[h].comparisons.find(c=>c.candidate===first.report.horizons[h].chosen),b=second.report.horizons[h].comparisons.find(c=>c.candidate===second.report.horizons[h].chosen);assert.equal(a.modelHash,b.modelHash);assert.ok(a.lastTrainingLabelAt<first.report.testFrom);assert.ok(first.models[h].lastTrainingLabelAt<=first.report.dataEnd);}
});
test('80% em poucos casos ou com informações incompletas não atinge meta; não libera dinheiro real',()=>{
 const m={valid:200,accuracy:.8,tp:80,tn:80,fp:20,fn:20,coverage:1,brierSkill:.1,alwaysUpAccuracy:.5,momentumAccuracy:.5},e={buyCases:40,buyCoverage:1,meanNetPct:.2,meanStressNetPct:.1};
 assert.equal(goalEvidence(m,e).demonstrated,false);const r=goalEvidence(m,e,{prospective:true});assert.equal(r.demonstrated,true);assert.equal(r.realTradingEnabled,false);
 for(const broken of [{...m,valid:5},{...m,brierSkill:null},{...m,coverage:.5},{...m,tp:0,fn:0}])assert.equal(goalEvidence(broken,e,{prospective:true}).demonstrated,false);
 assert.equal(goalEvidence(m,{...e,meanNetPct:-.1},{prospective:true}).demonstrated,false);
});
test('previsões prospectivas preservam saldo, rejeitam preço anterior ao alvo e contam perdas e ausentes',()=>{
 const points=history(),study=runScenarioStudy(points,'bitcoin',{now}),s=initialState(1000);s.config={allocations:{bitcoin:100}};s.portfolio={bitcoin:{quantity:0,observations:points.slice(-72)}};s.intelligence={};
 const quotes=(t,price=110)=>({bitcoin:{price,observedAt:new Date(t).toISOString()}});
 const first=advanceStudyDirections(s,quotes(now),[{id:1,asset:'bitcoin',models:study.models}],now);assert.equal(first.cash,1000);assert.equal(first.intelligence.scenarioLive.pending.length,3);
 const target=now+3600000,early=advanceStudyDirections(first,quotes(target-1000),[],target);assert.equal(early.intelligence.scenarioLive.metrics['bitcoin:1'].stats.valid,0);
 const p=early.intelligence.scenarioLive.pending.find(p=>p.horizon===1);early.intelligence.scenarioLive.pending.push(structuredClone(p));
 const next=advanceStudyDirections(early,quotes(target+1000,90),[],target+1000);assert.equal(next.intelligence.scenarioLive.metrics['bitcoin:1'].stats.valid,1);assert.equal(next.intelligence.scenarioLive.metrics['bitcoin:1'].stats.missing,0);assert.equal(next.cash,1000);
 const missed=advanceStudyDirections(first,{},[],target+11*60000);assert.equal(missed.intelligence.scenarioLive.metrics['bitcoin:1'].stats.missing,1);
});
test('dataset futuro ou fora de ordem é rejeitado',()=>{
 const p=history();p.at(-1).at=new Date(now+1).toISOString();assert.throws(()=>runScenarioStudy(p,'bitcoin',{now}),/Dataset/);
});

test('preço recebido depois do alvo mas observado antes não serve como resultado histórico',async()=>{
 const {historicalSamples}=await import('../lib/historical-samples.mjs');
 const p=history().map((row,i)=>({...row,observedAt:new Date(Date.parse(row.at)-(i%2?1000:0)).toISOString()}));
 const samples=historicalSamples(p,'bitcoin',1);assert.ok(samples.some(s=>s.status==='missing-price'));
});
