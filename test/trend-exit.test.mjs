import test from 'node:test';
import assert from 'node:assert/strict';
import { exitProgress,trendSignal,armEntryEligible,TREND_ARMS } from '../lib/trend-exit.mjs';
import { runTrendStudy,simulateTrendExit } from '../lib/trend-study.mjs';
import { netRoundTrip } from '../lib/forecast-economics.mjs';
import { fastStep } from '../lib/fast.mjs';
import { initialState } from '../lib/engine.mjs';
import { configurePortfolio,PROFILES } from '../lib/portfolio.mjs';
import { profitabilityEvidence } from '../lib/profitability.mjs';
const now=Date.parse('2026-10-26T10:00:00Z'),at=m=>new Date(now+m*60000).toISOString();
const plan={maxMinutes:240,takeProfitPct:.5,exitMode:'trailing',trailingDrawdownPct:.3};
const history=(n=1200)=>Array.from({length:n},(_,i)=>({at:new Date(now-(n-i)*120000).toISOString(),observedAt:new Date(now-(n-i)*120000).toISOString(),price:100+Math.sin(i/31),source:'coingecko'}));
test('saída móvel deixa lucro continuar, acompanha pico líquido e não transforma gatilho em preço garantido',()=>{
 let a=exitProgress(plan,null,.6,at(0));assert.equal(a.reason,null);assert.equal(a.tracking.armed,true);
 a=exitProgress(plan,a.tracking,2,at(2));assert.equal(a.reason,null);assert.equal(a.tracking.peakNetPct,2);
 const b=exitProgress(plan,a.tracking,1.8,at(4));assert.equal(b.reason,null);
 const c=exitProgress(plan,b.tracking,-2,at(6));assert.ok(c.reason.includes('Saída móvel'));assert.ok(c.reason.includes('-2.000%'));
 const duplicate=exitProgress(plan,a.tracking,-99,at(2));assert.equal(duplicate.reason,null);assert.deepEqual(duplicate.tracking,a.tracking);
 const unarmed=exitProgress(plan,null,-5,at(0));assert.equal(unarmed.tracking.armed,false);assert.equal(unarmed.reason,null);
});
test('tendência e rompimento usam somente 24 cotações conhecidas e rejeitam lacunas',()=>{
 const p=Array.from({length:24},(_,i)=>({at:at(-46+i*2),price:100+i*.1}));const s=trendSignal(p,now);assert.equal(s.trend,true);assert.equal(s.breakout,true);
 assert.equal(trendSignal([...p,{at:at(2),price:1}],now).inputHash,s.inputHash);
 const gap=structuredClone(p);gap[0].at=at(-60);assert.equal(trendSignal(gap,now).ready,false);
 assert.equal(armEntryEligible({fast:{observations:{bitcoin:p}}},{asset:'bitcoin'},TREND_ARMS[0],now).eligible,true);
 assert.equal(armEntryEligible({}, {asset:'solana:pool'},TREND_ARMS[0],now).eligible,false);
});
test('simulação usa os mesmos preços observados e custos para alvo fixo e saída móvel',()=>{
 const path=[{at:at(2),observedAt:at(2),price:101},{at:at(4),observedAt:at(4),price:103},{at:at(6),observedAt:at(6),price:102.5}];
 const fixed=simulateTrendExit(path,100,'bitcoin',{...plan,exitMode:'fixed'},at(240));assert.equal(fixed.exitPrice,101);
 const trailing=simulateTrendExit(path,100,'bitcoin',plan,at(240));assert.equal(trailing.exitPrice,102.5);assert.ok(trailing.netPct>fixed.netPct);assert.equal(trailing.netPct,netRoundTrip(2.5,'bitcoin'));
});
test('nova entrada de tendência aprende no mesmo caixa; saída antiga continua fixa e programação do usuário prevalece',()=>{
 let s=initialState(1000);s.paused=true;s=configurePortfolio(s,{...PROFILES.conservador,profile:'conservador',cryptoStrategy:'active',simulationExploration:true});s.paused=false;
 s.learning={assets:{},families:{},summaries:[],closed:0,explorationArms:Object.fromEntries(['short','medium','patient'].map(id=>['major-crypto|'+id,{trades:10,sumReward:0}]))};
 s.fast={positions:{},observations:{},cooldowns:{}};
 for(const id of ['bitcoin','ethereum'])s.fast.observations[id]=Array.from({length:23},(_,i)=>({at:at(-46+i*2),observedAt:at(-46+i*2),price:99+i*.04}));
 const quote=(m,price)=>Object.fromEntries(['bitcoin','ethereum'].map(id=>[id,{price,observedAt:at(m),volume24h:1e9}]));
 const before=structuredClone(s),bought=fastStep(s,quote(0,100),now).state;assert.deepEqual(s,before);
 const p=bought.fast.positions.bitcoin;assert.equal(p.plan.exitMode,'trailing');assert.equal(p.plan.maxMinutes,240);assert.ok(bought.cash>=0);
 const held=fastStep(bought,quote(2,101),now+120000).state;assert.ok(held.fast.positions.bitcoin.quantity>0);assert.ok(held.fast.positions.bitcoin.exitTracking.armed);
 const peak=fastStep(held,quote(4,103),now+240000).state;
 const manual=structuredClone(peak);manual.fast.positions.bitcoin.userExit={kind:'price',value:120};
 const scheduled=fastStep(manual,quote(6,102.5),now+360000).state;assert.ok(scheduled.fast.positions.bitcoin.quantity>0);
 const sold=fastStep(peak,quote(6,102.5),now+360000).state;assert.equal(sold.fast.positions.bitcoin.quantity,0);assert.ok(sold.events.some(e=>e.asset==='bitcoin'&&e.action==='VENDER'&&e.reason.includes('Saída móvel')));assert.ok(sold.learning.closed>=1);
 const legacy=structuredClone(bought);delete legacy.fast.positions.bitcoin.plan.exitMode;const closed=fastStep(legacy,quote(2,101),now+120000).state;assert.equal(closed.fast.positions.bitcoin.quantity,0);
});
test('seleção de estratégia não muda ao alterar preços do teste futuro; janelas e comparações não misturam coortes',()=>{
 const p=history(),a=runTrendStudy(p,'bitcoin',{now}),changed=structuredClone(p);for(let i=720;i<changed.length;i++)changed[i].price*=1+(i%3)/10;
 const b=runTrendStudy(changed,'bitcoin',{now});assert.deepEqual(p,history());
 for(const h of [6,20,60,240,1440]){
  const x=a.report.horizons[h],y=b.report.horizons[h];assert.equal(x.comparisons.length,6);assert.equal(x.folds.length,5);
  assert.equal(x.folds[0].chosen,y.folds[0].chosen);assert.deepEqual(x.folds[0].validation,y.folds[0].validation);
  assert.equal(x.valid+x.missing,x.decisions.length);
  for(const r of x.decisions){assert.ok(r.at>=r.selectionBefore);if(r.status==='scored')assert.ok(r.exitAt<=r.labelKnownAt);}
 }
 assert.deepEqual(a.models,{});assert.ok(a.report.horizons[240].valid>0);assert.equal(a.report.horizons[1440].valid,0);
 const mix=[...p,{at:at(0),price:100,source:'other'}];assert.throws(()=>runTrendStudy(mix,'bitcoin',{now}),/provedores/);
});
test('referência de saída fixa permite medir melhoria de saída sem exigir filtro de compra',()=>{
 const rows=Array.from({length:30},(_,i)=>({at:at(-i*2),probability:1,status:'scored',rawPct:2})),reference=rows.map(r=>({...r,rawPct:.9}));
 assert.equal(profitabilityEvidence(rows,'bitcoin',{baselineRows:reference}).qualified,true);
 const missing=reference.map((r,i)=>i<5?{...r,status:'missing-price'}:r);assert.equal(profitabilityEvidence(rows,'bitcoin',{baselineRows:missing}).qualified,false);
});

test('comparações de caixa acompanham alternativas longas e saída móvel sem movimentar dinheiro',async()=>{
 const {advanceEntryReferences,ENTRY_POLICY}=await import('../lib/entry-learning.mjs');
 const observations=Array.from({length:24},(_,i)=>({at:at(-46+i*2),observedAt:at(-46+i*2),price:99+i/23}));
 const s={cash:1000,config:{simulationExploration:true,learningPolicy:ENTRY_POLICY.id},fast:{observations:{bitcoin:observations}},learning:{}};
 const q=(m,price)=>({bitcoin:{price,observedAt:at(m)}});
 const first=advanceEntryReferences(s,q(0,100),now);assert.equal(first.created.length,5);
 const a=advanceEntryReferences(s,q(2,101),now+120000);assert.equal(a.outcomes.some(r=>r.arm==='trend-hours'),false);
 advanceEntryReferences(s,q(4,103),now+240000);
 const b=advanceEntryReferences(s,q(6,102.5),now+360000),r=b.outcomes.find(r=>r.arm==='trend-hours');assert.ok(r);assert.equal(r.exitReason,'trailing');assert.ok(r.netPct>0);assert.equal(s.cash,1000);
});

test('foco em tendência evita compras curtas, explica recusa e preserva modo em clientes antigos',()=>{
 let s=initialState(1000);s.paused=true;s=configurePortfolio(s,{...PROFILES.conservador,profile:'conservador',cryptoStrategy:'active',simulationExploration:true,learningArmMode:'trend',discoveryPct:0});
 const saved=configurePortfolio(s,{...PROFILES.conservador,profile:'conservador',cryptoStrategy:'active'});assert.equal(saved.config.learningArmMode,'trend');
 s.paused=false;
 const quote=price=>({bitcoin:{price,observedAt:at(0),volume24h:1e9},ethereum:{price,observedAt:at(0),volume24h:1e9}});
 for(const id of ['bitcoin','ethereum']){s.fast??={positions:{},observations:{},cooldowns:{}};s.fast.observations[id]=Array.from({length:23},(_,i)=>({at:at(-46+i*2),observedAt:at(-46+i*2),price:110-i*.1}));}
 const held=fastStep(s,quote(100),now).state;assert.equal(held.cash,1000);assert.equal(held.fast.stats?.buys??0,0);assert.ok(held.events.some(e=>e.reason.includes('Foco em tendência')&&e.reason.includes('EMA8')));
 for(const id of ['bitcoin','ethereum'])s.fast.observations[id]=Array.from({length:23},(_,i)=>({at:at(-46+i*2),observedAt:at(-46+i*2),price:99+i*.04}));
 const bought=fastStep(s,quote(100),now).state;assert.ok(bought.fast.stats.buys>0);for(const p of Object.values(bought.fast.positions).filter(p=>p.quantity>0)){assert.equal(p.plan.exitMode,'trailing');assert.ok([240,1440].includes(p.plan.maxMinutes));}
});
