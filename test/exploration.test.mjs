import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../lib/engine.mjs';
import { configurePortfolio,PROFILES,stopReason } from '../lib/portfolio.mjs';
import { setExploration,explorationPlan } from '../lib/exploration.mjs';
import { fastStep } from '../lib/fast.mjs';
const now=Date.parse('2026-10-25T12:00:00Z');
function state(){const s=initialState(1000);s.paused=true;return configurePortfolio(s,{...PROFILES.conservador,profile:'conservador',cryptoStrategy:'active'});}
const quotes=(t=now,price=100)=>Object.fromEntries(['bitcoin','ethereum'].map(id=>[id,{price,observedAt:new Date(t).toISOString(),volume24h:1e9}]));
test('exploração é explícita, reversível e não reinicializa perdas ou caixa',()=>{
 const s=state();s.cash=700;assert.ok(stopReason(s,now));const e=setExploration(s,true,now);assert.equal(e.cash,700);assert.equal(e.initialCapital,1000);assert.equal(e.paused,false);assert.equal(stopReason(e,now),null);
 const off=setExploration(e,false,now);assert.equal(off.paused,true);assert.ok(stopReason(off,now));assert.equal(off.cash,700);assert.throws(()=>setExploration(s,'true'),/modo/);
});
test('exploração investe o caixa além dos tetos do perfil sem saldo negativo; parada manual continua válida',()=>{
 const s=setExploration(state(),true,now),b=fastStep(s,quotes(),now).state;assert.ok(b.fast.stats.buys>=2);assert.ok(b.cash>=-1e-9);assert.ok(b.cash<1);assert.ok(b.fast.positions.bitcoin.costBasis>100);
 s.paused=true;assert.equal(fastStep(s,quotes(),now).state.fast.stats?.buys??0,0);
 assert.equal(fastStep(b,quotes(),now).duplicate,true);
});
test('sem stop financeiro: perda não encerra posição; prazo gera resultado e aprendizado por alternativa',()=>{
 const bought=fastStep(setExploration(state(),true,now),quotes(),now).state;
 const held=fastStep(bought,quotes(now+120000,80),now+120000).state;assert.ok(held.fast.positions.bitcoin.quantity>0);assert.equal(held.paused,false);
 const closed=fastStep(held,quotes(now+181*60000,80),now+181*60000).state;assert.equal(closed.fast.stats.sells,2);assert.equal(closed.learning.closed,2);assert.ok(Object.keys(closed.learning.explorationArms).length>=1);assert.equal(closed.learning.summaries[0].rMultiple,null);assert.equal(closed.cash>=0,true);
});
test('alternativas são selecionadas por resultados anteriores, com exploração das não testadas',()=>{
 const context={family:'major-crypto'},s={learning:{explorationArms:{'major-crypto|short':{trades:10,sumReward:5},'major-crypto|medium':{trades:10,sumReward:-5},'major-crypto|patient':{trades:10,sumReward:-5}}}};
 assert.equal(explorationPlan(s,context,{}).explorationArm,'short');delete s.learning.explorationArms['major-crypto|medium'];assert.equal(explorationPlan(s,context,{}).explorationArm,'medium');
});
