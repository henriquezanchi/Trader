import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, equity } from '../lib/engine.mjs';
import { configurePortfolio, PROFILES, portfolioStep } from '../lib/portfolio.mjs';
import { fastStep, BLENDS } from '../lib/fast.mjs';
import { runTick } from '../lib/services.mjs';
const start=Date.parse('2026-10-24T12:00:00Z');
function state(){const s=initialState(1000);s.paused=true;const n=configurePortfolio(s,{profile:'agressivo',...PROFILES.agressivo,cryptoStrategy:'hybrid'});n.paused=false;return n;}
const quotes=(at,price=100)=>Object.fromEntries(['bitcoin','ethereum','solana'].map(id=>[id,{price,observedAt:new Date(at).toISOString()}]));
function warm(){let s=state();for(let i=0;i<3;i++)s=fastStep(s,quotes(start+i*120000,100+i*.01),start+i*120000).state;return s;}
test('híbrido prepara três cotações, compra e inclui posições curtas no patrimônio agregado',()=>{
 const original=state(),a=fastStep(original,quotes(start),start).state;assert.equal(a.cash,1000);assert.equal(original.fast,undefined);
 const s=warm();assert.ok(s.fast.stats.buys>0);assert.ok(s.cash<1000);assert.ok(equity(s)>s.cash);assert.ok(equity(s)<1000);
 assert.ok(s.events.find(e=>e.mode==='fast'&&e.action==='COMPRAR').indicators.recentQuotes.length===3);
 assert.ok(Object.values(s.fast.positions).reduce((v,p)=>v+p.quantity*p.lastPrice,0)<=s.initialCapital*s.config.exposurePct/100);
 assert.equal(fastStep(s,quotes(start+240000),start+240000).duplicate,true);
});
test('alvo considera ida e volta: ganho bruto de 0,2% não aciona lucro líquido de 0,5%',()=>{
 let s=warm();s=fastStep(s,quotes(start+360000,100.22),start+360000).state;assert.equal(s.fast.stats.sells,0);
 s=fastStep(s,quotes(start+480000,101.1),start+480000).state;assert.ok(s.fast.stats.sells>0);assert.ok(s.fast.stats.realizedPnl>0);assert.ok(s.events.some(e=>e.mode==='fast'&&e.reason.includes('Meta líquida')));
});
test('perda por posição, pausa e preço velho bloqueiam entradas sem prometer recuperação',()=>{
 let s=warm();s=fastStep(s,quotes(start+360000,98),start+360000).state;assert.ok(s.fast.stats.losses>0);assert.ok(s.events.some(e=>e.reason.includes('Limite de perda da posição')));
 const paused=state();paused.paused=true;for(let i=0;i<3;i++)Object.assign(paused,fastStep(paused,quotes(start+i*120000),start+i*120000).state);assert.equal(paused.cash,1000);
 assert.throws(()=>fastStep(state(),quotes(start),start+180000),/antiga/);
});
test('cenário horário não repete enquanto parcela curta processa minutos por CAS',async()=>{
 let row={version:0,state:state()},commits=0;const repo={read:async()=>structuredClone(row),commit:async(v,s)=>{assert.equal(v,row.version);row={version:v+1,state:s};commits++;}};
 for(let i=0;i<3;i++)await runTick(repo,async()=>quotes(start+i*120000),start+i*120000);
 assert.equal(row.state.portfolio.bitcoin.observations.length,1);assert.ok(row.state.fast.stats.buys>0);assert.equal(commits,3);
 assert.equal((await runTick(repo,async()=>quotes(start+240000),start+240000)).duplicate,true);assert.equal(commits,3);
});
test('blend varia por perfil e risco global fecha também as posições curtas',()=>{
 assert.ok(BLENDS.agressivo.fastShare>BLENDS.moderado.fastShare);assert.ok(BLENDS.moderado.fastShare>BLENDS.conservador.fastShare);
 let s=warm();s.cash-=120;s=fastStep(s,quotes(start+360000),start+360000).state;assert.equal(s.paused,true);assert.ok(Object.values(s.fast.positions).every(p=>p.quantity===0));
 const core=state();core.portfolio.bitcoin.quantity=.1;core.portfolio.bitcoin.lastPrice=100;core.cash=850;core.lastTick=new Date(start).toISOString().slice(0,13);const risk=portfolioStep(core,quotes(start),start,{id:'baseline',riskOnly:true}).state;assert.equal(risk.portfolio.bitcoin.quantity,0);
});

test('falha da fonte grava AGUARDAR privado sem mudar dinheiro ou posições',async()=>{
 const initial=state();let row={version:0,state:initial};const repo={read:async()=>structuredClone(row),commit:async(v,s)=>{assert.equal(v,row.version);row={version:v+1,state:s};}};
 await assert.rejects(runTick(repo,async()=>{throw Error('source offline')},start));assert.equal(row.state.cash,initial.cash);assert.deepEqual(row.state.portfolio,initial.portfolio);assert.equal(row.state.events.at(-1).mode,'data');assert.equal(row.state.events.at(-1).action,'AGUARDAR');assert.equal(row.version,1);
 await assert.rejects(runTick(repo,async()=>{throw Error('source offline')},start));assert.equal(row.version,1);
});

test('dez criptos compartilham o mesmo caixa e teto de exposição, sem multiplicar capital',()=>{
 let s=initialState(1000);s.paused=true;s=configurePortfolio(s,{profile:'diversificado-agressivo',...PROFILES['diversificado-agressivo'],cryptoStrategy:'hybrid'});s.paused=false;
 const ids=Object.keys(s.config.allocations).filter(id=>!['bova11','ivvb11'].includes(id));
 for(let i=0;i<3;i++){const at=start+i*120000,q=Object.fromEntries(ids.map(id=>[id,{price:100,observedAt:new Date(at).toISOString()}]));s=fastStep(s,q,at).state;}
 assert.equal(s.fast.stats.buys,10);assert.ok(s.cash>=0);assert.ok(equity(s)<=1000);assert.ok(1000-s.cash<=s.initialCapital*s.config.exposurePct/100);
 for(const [id,p] of Object.entries(s.fast.positions))assert.ok(p.quantity*p.lastPrice<=s.initialCapital*s.config.allocations[id]/100);
});
