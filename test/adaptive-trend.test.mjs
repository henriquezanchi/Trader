import test from 'node:test';
import assert from 'node:assert/strict';
import { trendSignal,entryRuleEvidence,resolveExitPlan,armEntryEligible,TREND_ARMS,ADAPTIVE_EXIT_POLICY } from '../lib/trend-exit.mjs';
import { runTrendStudy,runAdaptiveTrendStudy } from '../lib/trend-study.mjs';
import { breakEvenRawPct,netRoundTrip } from '../lib/forecast-economics.mjs';
import { digest } from '../lib/prediction-protocol.mjs';
import { initialState } from '../lib/engine.mjs';
import { configurePortfolio,PROFILES } from '../lib/portfolio.mjs';
import { fastStep } from '../lib/fast.mjs';
const now=Date.parse('2026-10-26T16:00:00Z');
const prices=[...Array.from({length:14},(_,i)=>100+i*.1),101.5,101.7,101.9,102,102,101.95,101.9,101.85,101.8,101.85];
const points=(scale=1)=>prices.map((price,i)=>({price:100+(price-100)*scale,at:new Date(now-(23-i)*120000).toISOString(),observedAt:new Date(now-(23-i)*120000).toISOString()}));
const history=()=>Array.from({length:1200},(_,i)=>({at:new Date(now-(1200-i)*120000).toISOString(),price:100+Math.sin(i/31),source:'coingecko'}));
test('recuo exige tendência, reação e proximidade da média; custos têm referência explícita',()=>{
 const signal=trendSignal(points(),now),arm=TREND_ARMS.find(a=>a.id==='pullback-hours-adaptive');
 assert.equal(armEntryEligible({}, {asset:'bova11'},arm,now).eligible,false);
 assert.equal(signal.pullback,true);assert.equal(signal.breakout,false);assert.equal(entryRuleEvidence(signal,arm,'bitcoin').eligible,true);
 const calm={...signal,observedRangePct:.1};const rejected=entryRuleEvidence(calm,arm,'bitcoin');assert.equal(rejected.eligible,false);assert.ok(rejected.reason.includes('mínimo de referência'));assert.ok(rejected.requiredRangePct>rejected.breakEvenPct);
 assert.ok(Math.abs(netRoundTrip(breakEvenRawPct('bitcoin'),'bitcoin'))<1e-10);
 assert.equal(entryRuleEvidence({...signal,lastChangePct:-.1,pullback:false},arm).eligible,false);
});
test('saída varia com ruído conhecido e conserva snapshot; preços futuros não entram no dimensionamento',()=>{
 const arm=TREND_ARMS.find(a=>a.id==='pullback-hours-adaptive'),s=trendSignal(points(),now),plan=resolveExitPlan(arm,s,{snapshot:true});
 assert.equal(digest(plan.exitSizing.inputSnapshot),plan.exitSizing.inputHash);assert.equal(plan.exitSizing.policy,ADAPTIVE_EXIT_POLICY.id);
 const future=trendSignal([...points(),{at:new Date(now+120000).toISOString(),price:999}],now);assert.deepEqual(resolveExitPlan(arm,future,{snapshot:true}),plan);
 const quieter=resolveExitPlan(arm,trendSignal(points(.3),now));assert.ok(plan.trailingDrawdownPct>quieter.trailingDrawdownPct);assert.ok(plan.takeProfitPct>quieter.takeProfitPct);
 assert.ok(plan.trailingDrawdownPct>=.15&&plan.trailingDrawdownPct<=1.5);assert.throws(()=>resolveExitPlan(arm,{ready:false}),/insuficiente/);
 assert.equal(JSON.stringify(s).includes('inputPoints'),false);
});
test('novas posições adaptativas guardam parâmetros da entrada e preservam os limites configurados',()=>{
 let s=initialState(1000);s.paused=true;s=configurePortfolio(s,{...PROFILES.conservador,profile:'conservador',cryptoStrategy:'active',simulationExploration:true,learningArmMode:'trend',discoveryPct:0});s.paused=false;
 s.learning={assets:{},families:{},summaries:[],closed:0,explorationArms:Object.fromEntries(['trend-hours','trend-day'].map(id=>['major-crypto|'+id,{trades:10,sumReward:0}]))};
 s.fast={positions:{},observations:{bitcoin:points().slice(0,-1),ethereum:points().slice(0,-1)},cooldowns:{}};
 const config=structuredClone(s.config),q=(time,price)=>Object.fromEntries(['bitcoin','ethereum'].map(id=>[id,{price,observedAt:new Date(time).toISOString(),volume24h:1e9}]));
 const bought=fastStep(s,q(now,prices.at(-1)),now).state;const p=bought.fast.positions.bitcoin;assert.equal(p.plan.explorationArm,'pullback-hours-adaptive');assert.ok(p.quantity>0);assert.ok(bought.cash>=0);assert.deepEqual(bought.config,config);
 assert.equal(digest(p.plan.exitSizing.inputSnapshot),p.plan.exitSizing.inputHash);
 const frozen=structuredClone(p.plan),held=fastStep(bought,q(now+120000,prices.at(-1)+.01),now+120000).state;assert.deepEqual(held.fast.positions.bitcoin.plan,frozen);
 const event=bought.events.find(e=>e.action==='COMPRAR'&&e.asset==='bitcoin');assert.equal(event.parameters.exitSizing.policy,ADAPTIVE_EXIT_POLICY.id);
});
test('V2 compara onze regras sem mudar os resultados das seis regras anteriores; seleção não consulta o futuro',()=>{
 const p=history(),old=runTrendStudy(p,'bitcoin',{now}),v2=runAdaptiveTrendStudy(p,'bitcoin',{now}),changed=structuredClone(p);for(let i=720;i<changed.length;i++)changed[i].price*=1+(i%3)/10;
 const future=runAdaptiveTrendStudy(changed,'bitcoin',{now});assert.equal(v2.report.protocol.id,'trend-exit-comparison-v2');assert.deepEqual(v2.models,{});
 for(const h of [6,20,60,240,1440]){
  const a=v2.report.horizons[h],b=future.report.horizons[h];assert.equal(a.comparisons.length,11);assert.equal(a.folds[0].chosen,b.folds[0].chosen);assert.deepEqual(a.folds[0].validation,b.folds[0].validation);
  for(const prev of old.report.horizons[h].comparisons){const same=a.comparisons.find(c=>c.candidate===prev.candidate);assert.equal(same.meanNetPct,prev.meanNetPct);assert.equal(same.buyCases,prev.buyCases);assert.equal(same.valid,prev.valid);}
 }
});
