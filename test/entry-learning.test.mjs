import test from 'node:test';
import assert from 'node:assert/strict';
import { entryEvidence,valueEntryPlan,entryBudget,learnEntry,advanceEntryReferences,ENTRY_POLICY } from '../lib/entry-learning.mjs';
import { explorationPlan,learnExploration } from '../lib/exploration.mjs';
const now=Date.parse('2026-10-25T12:00:00Z'),context={asset:'bitcoin',family:'major-crypto',scenario:'major-crypto|up|low|active'};
const rows=(n,netPct=.5)=>Array.from({length:n},()=>({at:new Date(now-1000).toISOString(),netPct,stressPct:netPct-.1}));
const state=()=>({cash:1000,config:{simulationExploration:true,learningPolicy:ENTRY_POLICY.id,learningExplorationPct:20},learning:{},fast:{positions:{}}});
test('não aprova estratégia sem validação independente ou que perde para caixa',()=>{
 const s=state();s.learning.entryEvidence={[context.scenario+'|short']:{fit:rows(20),validation:rows(10)}};assert.equal(entryEvidence(s,context,now).qualified,true);
 s.learning.entryEvidence[context.scenario+'|short'].validation=rows(10,-.2);assert.equal(entryEvidence(s,context,now).qualified,false);
});
test('seleciona pelo ajuste e não escolhe retrospectivamente outro vencedor pela validação',()=>{
 const s=state();s.learning.entryEvidence={
 [context.scenario+'|short']:{fit:rows(20,1),validation:rows(10,-1)},
 [context.scenario+'|medium']:{fit:rows(20,.5),validation:rows(10,1)}};
 const e=entryEvidence(s,context,now);assert.equal(e.candidate.arm.id,'short');assert.equal(e.qualified,false);
});
test('parcela de teste é controlada sem gastar caixa reservado; 100% permite optar por somente explorar',()=>{
 const s=state(),plan=valueEntryPlan(s,'bitcoin',{},explorationPlan(s,context,{context}),now);assert.equal(plan.entryBucket,'explore');assert.equal(entryBudget(s,plan,1000,2),100);
 s.fast.positions.bitcoin={quantity:1,costBasis:200,plan:{entryBucket:'explore'}};assert.equal(entryBudget(s,plan,1000,2),0);
 s.config.learningExplorationPct=100;s.fast.positions={};assert.equal(entryBudget(s,plan,1000,2),500);
});
test('validação não alimenta ajuste nem recompensa UCB; custo observado não é subtraído duas vezes',()=>{
 const learning={explorationArms:{}},decision={policy:ENTRY_POLICY.id,phase:'validation',key:context.scenario+'|short'},entry={id:'buy',context,quantity:1,costBasis:100,referencePrice:99,plan:{explorationArm:'short'},evidence:{entryDecision:decision}};
 const event={id:'sell',price:103,realizedPnl:2};learnEntry(learning,entry,event,2,now);learnEntry(learning,entry,event,2,now);
 const r=learning.entryEvidence[decision.key];assert.equal(r.fit.length,0);assert.equal(r.validation.length,1);assert.equal(r.validation[0].netPct,2);assert.equal(r.validation[0].stressPct,0);
 learnExploration(learning,entry,2,now);assert.equal(learning.explorationArms['major-crypto|short'].fitTrades,0);
});
test('comparação compra versus caixa não movimenta carteira e não usa cotações futuras',()=>{
 const s=state(),q=t=>({bitcoin:{price:100,observedAt:new Date(t).toISOString()}});const first=advanceEntryReferences(s,q(now),now);assert.equal(first.created.length,3);assert.equal(s.cash,1000);
 const future=advanceEntryReferences(s,q(now+7*60000),now+6*60000);assert.equal(future.outcomes.length,0);
 const scored=advanceEntryReferences(s,q(now+6*60000),now+6*60000);assert.equal(scored.outcomes.length,1);assert.ok(scored.outcomes[0].netPct<0);assert.equal(scored.outcomes[0].betterThanCash,false);assert.equal(s.cash,1000);
});

test('um único grande ganho não certifica vantagem econômica',()=>{
 const s=state(),fit=rows(20,.5),validation=rows(10,-1);validation[0].netPct=20;validation[0].stressPct=19;
 s.learning.entryEvidence={[context.scenario+'|short']:{fit,validation}};
 assert.equal(entryEvidence(s,context,now).candidate.validation.expectedNetPct>0,true);assert.equal(entryEvidence(s,context,now).qualified,false);
});

test('salvar perfil por cliente antigo preserva modo e política de aprendizado',async()=>{
 const {initialState}=await import('../lib/engine.mjs'),{configurePortfolio,PROFILES}=await import('../lib/portfolio.mjs');let s=initialState(1000);s.paused=true;s=configurePortfolio(s,{...PROFILES.moderado,profile:'moderado',simulationExploration:true,learningPolicy:ENTRY_POLICY.id,learningExplorationPct:30});
 const saved=configurePortfolio(s,{...PROFILES.agressivo,profile:'agressivo'});assert.equal(saved.config.simulationExploration,true);assert.equal(saved.config.learningPolicy,ENTRY_POLICY.id);assert.equal(saved.config.learningExplorationPct,30);
});
