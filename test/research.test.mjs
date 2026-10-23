import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../lib/engine.mjs';
import { configurePortfolio, PROFILES } from '../lib/portfolio.mjs';
import { advanceResearch } from '../lib/research.mjs';
import { parseNews, collectNews, NEWS_SOURCES } from '../lib/news.mjs';
import { indicators } from '../lib/indicators.mjs';
const now=Date.parse('2026-10-23T12:00:00Z'), hour=3600000;
function fixture(at=now){const s=initialState(1000); s.paused=true; const state=configurePortfolio(s,{...structuredClone(PROFILES.moderado),profile:'moderado'}); const quotes={}; for(const [id,p] of Object.entries(state.portfolio)){p.observations=Array.from({length:24},(_,i)=>({at:new Date(at-(24-i)*hour).toISOString(),price:100})); quotes[id]={price:100,observedAt:new Date(at).toISOString()};}return{state,quotes};}
const news={fetchedAt:new Date(now).toISOString(),sources:[],items:[]};
test('indicadores planos e continuidade; lacuna invalida janela',()=>{ const {state}=fixture(); const obs=state.portfolio.bitcoin.observations; assert.equal(indicators(obs).rsi14,50);assert.equal(indicators(obs).continuous,true);assert.equal(indicators(obs.filter((_,i)=>i!==12)).continuous,false);});
test('pesquisa pontua previsões anteriores antes de aprender e não muda saldo ativo',()=>{
 const {state,quotes}=fixture(), original=structuredClone(state);const first=advanceResearch(null,state,quotes,news,now);assert.deepEqual(state,original);assert.ok(first.research.pending.length);assert.equal(first.research.models[1].trained,0);
 const later=fixture(now+hour);for(const q of Object.values(later.quotes))q.price=102;
 const second=advanceResearch(first.research,later.state,later.quotes,news,now+hour);
 const scored=second.delta.outcomes.filter(o=>o.status==='scored');assert.ok(scored.length);assert.ok(scored.every(o=>o.probability===.5));assert.equal(second.research.models[1].trained,scored.length);assert.equal(second.research.models[6].trained,0);
 assert.equal(advanceResearch(second.research,later.state,later.quotes,news,now+hour+1000).delta,null);
 assert.ok(second.research.recommendations.every(r=>r.status==='insufficient-evidence'));
});
test('atrasos não são usados como preço de uma hora',()=>{const a=fixture();const first=advanceResearch(null,a.state,a.quotes,news,now);const later=fixture(now+3*hour);for(const p of Object.values(later.state.portfolio))p.observations=[];const r=advanceResearch(first.research,later.state,later.quotes,news,now+3*hour);assert.equal(r.research.models[1].trained,0);assert.ok(r.research.models[1].missed>0);});
test('RSS rejeita entidades e datas futuras; indisponibilidade não inventa notícia',async()=>{
 assert.throws(()=>parseNews('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',NEWS_SOURCES[0],now));
 const xml=date=>`<rss><channel><item><title>Bitcoin approval rally</title><link>https://example.test/story</link><pubDate>${new Date(date).toUTCString()}</pubDate></item></channel></rss>`;
 assert.equal(parseNews(xml(now+hour),NEWS_SOURCES[0],now).length,0);
 const n=parseNews(xml(now-hour),NEWS_SOURCES[0],now);assert.equal(n.length,1);assert.equal(n[0].firstSeenAt,new Date(now).toISOString());
 const failed=await collectNews(null,async()=>{throw Error('offline')},now);assert.equal(failed.items.length,0);assert.ok(failed.sources.every(s=>s.status!=='ok'));
});
