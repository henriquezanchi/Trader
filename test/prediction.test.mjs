import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, equity } from '../lib/engine.mjs';
import { configurePortfolio, PROFILES } from '../lib/portfolio.mjs';
import { parseHourlyHistory, fitHistoricalDirection, applyHistoricalDirection } from '../lib/forecast-history.mjs';
import { advanceDirections } from '../lib/directions.mjs';
const now=Date.parse('2026-10-24T16:00:00Z');
const points=()=>Array.from({length:400},(_,i)=>({at:new Date(now-(399-i)*3600000).toISOString(),observedAt:new Date(now-(399-i)*3600000).toISOString(),price:100+i*.02+Math.sin(i/6)*2,historical:true}));
function state(){let s=initialState(1000);s.paused=true;s=configurePortfolio(s,{profile:'agressivo',...PROFILES.agressivo,allocations:{bitcoin:20},cryptoStrategy:'active'});s.paused=false;return s;}
test('teste histórico é temporal e não treina com os alvos do trecho reservado',()=>{
 const data=points(),first=fitHistoricalDirection(data,'bitcoin',now),changed=structuredClone(data);for(let i=Math.floor(data.length*.7);i<changed.length;i++)changed[i].price*=1+(i%3)/2;
 const second=fitHistoricalDirection(changed,'bitcoin',now);for(const h of [1,6,24]){assert.ok(first.report.metrics[h].samples>=10);assert.equal(first.report.metrics[h].evaluationModelHash,second.report.metrics[h].evaluationModelHash);assert.equal(first.banks[h].scored,0);}
 const s=state(),applied=applyHistoricalDirection(s,first,now);assert.equal(applied.state.cash,s.cash);assert.equal(equity(applied.state),equity(s));assert.equal(applied.state.events.at(-1).action,'TREINAR');assert.equal(applyHistoricalDirection(applied.state,first,now).duplicate,true);
});
test('previsão é gravada antes; acerto usa probabilidade original, não modelo atualizado depois',()=>{
 const s=applyHistoricalDirection(state(),fitHistoricalDirection(points(),'bitcoin',now),now).state,q={bitcoin:{price:110,observedAt:new Date(now).toISOString(),volume24h:1e9}};
 const first=advanceDirections(s,q,now),saved=first.intelligence.directionPending.find(p=>p.horizon===1);assert.ok(saved);assert.equal(first.intelligence.directionMetrics[1].scored,0);
 first.intelligence.directionByAsset.bitcoin[1].weights.fill(-20);
 const later=advanceDirections(first,{bitcoin:{...q.bitcoin,price:111,observedAt:new Date(now+3600000).toISOString()}},now+3600000);
 const outcome=later.intelligence.directionOutcomes.find(p=>p.id===saved.id);assert.equal(outcome.correct,saved.probability>=.5);assert.equal(later.intelligence.directionMetrics[1].scored,1);assert.equal(later.cash,s.cash);
});
test('candle não concluído e moeda errada não viram história conhecida',()=>{
 const list=points(),body={chart:{result:[{meta:{symbol:'BTC-BRL',currency:'BRL'},timestamp:[...list.map(p=>Date.parse(p.at)/1000-3600),now/1000],indicators:{quote:[{close:[...list.map(p=>p.price),999999]}]}}]}};
 const parsed=parseHourlyHistory(body,'bitcoin',now);assert.equal(parsed.length,400);assert.ok(parsed.every(p=>Date.parse(p.at)<=now));body.chart.result[0].meta.currency='USD';assert.throws(()=>parseHourlyHistory(body,'bitcoin',now));
});

test('histórico CoinGecko usa pontos reais por hora, sem interpolar ou aceitar futuro',async()=>{
 const {parseCoinGeckoHistory,historicalDirection}=await import('../lib/forecast-history.mjs');const rows=points().map(p=>[Date.parse(p.at),p.price]);rows.push([now+3600000,999]);const parsed=parseCoinGeckoHistory({prices:rows},now);assert.equal(parsed.length,400);assert.ok(parsed.every(p=>Date.parse(p.at)<=now));
 const fit=await historicalDirection('bitcoin',async()=>({ok:true,json:async()=>({prices:rows})}),now);assert.match(fit.report.source,/CoinGecko/);assert.ok(fit.report.metrics[1].samples>0);
});
