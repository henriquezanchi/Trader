import test from 'node:test';
import assert from 'node:assert/strict';
import { discover,poolQuotes,POOL_BATCH_SIZE } from '../lib/discovery.mjs';
import { getPortfolioQuotes } from '../lib/services.mjs';
import { fastStep } from '../lib/fast.mjs';
import { initialState } from '../lib/engine.mjs';
import { configurePortfolio,PROFILES } from '../lib/portfolio.mjs';
const now=Date.parse('2026-10-26T13:00:00Z'),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const address=i=>'A'.repeat(30)+alphabet[Math.floor(i/58)]+alphabet[i%58];
const ids=Array.from({length:31},(_,i)=>'solana:'+address(i));
const row=id=>({attributes:{address:id.slice(7),name:'FIXTURE / SOL',base_token_price_usd:'1',reserve_in_usd:'10000',pool_created_at:new Date(now-86400000).toISOString()},relationships:{base_token:{data:{id:'solana_'+'B'.repeat(32)}}}});
const fx={'usd-coin':{brl:1,usd:1,last_updated_at:now/1000}};
const previous=()=>({assets:Object.fromEntries(ids.map(id=>[id,{id,token:'B'.repeat(32),priceUSD:1,liquidityUSD:10000,createdAt:new Date(now-86400000).toISOString(),collectedAt:new Date(now-86400000).toISOString()}]))});
const response=(body,status=200)=>({ok:status===200,status,json:async()=>structuredClone(body)});
const addresses=url=>url.split('/multi/')[1].split(',').map(x=>'solana:'+decodeURIComponent(x));
test('31 posições são consultadas em lotes limitados, mesmo com descoberta nova indisponível',async()=>{
 const calls=[],old=previous(),before=structuredClone(old);
 const d=await discover(old,ids,async url=>{calls.push(url);if(url.includes('coingecko'))return response(fx);if(url.includes('new_pools'))return response({},503);const requested=addresses(url);assert.ok(requested.length<=POOL_BATCH_SIZE);return response({data:requested.map(row)});},now);
 assert.deepEqual(old,before);assert.equal(calls.filter(x=>x.includes('/multi/')).length,2);assert.equal(d.status,'parcial');assert.equal(d.heldHealth.quoted,31);assert.equal(Object.keys(poolQuotes(d,now)).length,31);assert.equal(d.entryIds.length,0);
 assert.equal(Object.keys(poolQuotes(d,now+120001)).length,0);
});
test('um lote falha sem invalidar outros; fonte omissa, reserva zero e token trocado preservam a posição',async()=>{
 const d=await discover(previous(),ids,async url=>{
  if(url.includes('coingecko'))return response(fx);const requested=addresses(url);
  if(requested.includes(ids[20]))return response({},429);
  const data=requested.slice(1).map(row);data[0].attributes.reserve_in_usd='0';data[1].relationships.base_token.data.id='solana_'+'C'.repeat(32);
  return response({data});
 },now,{discoverNew:false});
 assert.equal(d.poolStatus[ids[0]].status,'missing');assert.equal(d.poolStatus[ids[1]].status,'no-liquidity');assert.equal(d.poolStatus[ids[2]].status,'invalid-data');assert.equal(d.poolStatus[ids[20]].status,'unavailable');
 assert.equal(Object.keys(poolQuotes(d,now)).length,17);assert.equal(d.assets[ids[20]].collectedAt,previous().assets[ids[20]].collectedAt);assert.equal(d.diagnostics.batches[1].httpStatus,429);
});
test('FX em cache só vale com horário original recente; nunca rejuvenesce câmbio ou cotação antiga',async()=>{
 const old=previous();old.fx={rate:1,observedAt:new Date(now-60000).toISOString()};
 const fetcher=async url=>url.includes('coingecko')?response({},503):response({data:addresses(url).map(row)});
 const d=await discover(old,[ids[0]],fetcher,now,{discoverNew:false});assert.equal(Object.keys(poolQuotes(d,now)).length,1);assert.equal(d.fx.observedAt,old.fx.observedAt);
 old.fx.observedAt=new Date(now-601000).toISOString();const stale=await discover(old,[ids[0]],fetcher,now,{discoverNew:false});assert.deepEqual(poolQuotes(stale,now),{});assert.equal(stale.poolStatus[ids[0]].status,'fx-unavailable');
});
test('pausado: atualiza posições abertas sem consultar novos pools, não reabre entradas',async()=>{
 let s=initialState(1000);s.paused=true;s=configurePortfolio(s,{...PROFILES.agressivo,profile:'agressivo',cryptoStrategy:'active',discoveryPct:15,allocations:{bitcoin:20}});s.paused=true;s.cash=0;s.discovery=previous();
 s.fast={positions:Object.fromEntries(ids.map(id=>[id,{quantity:20,costBasis:20,lastPrice:1,liquidityBRL:10000,openedAt:new Date(now-86400000).toISOString(),plan:{maxMinutes:60,takeProfitPct:2,stopPct:8}}])),observations:{},cooldowns:{}};
 const snapshot=structuredClone(s),calls=[];
 const data=await getPortfolioQuotes(s,async url=>{
  calls.push(url);assert.equal(url.includes('new_pools'),false);
  if(url.includes('ids=usd-coin'))return response(fx);
  if(url.includes('coingecko'))return response({bitcoin:{brl:100,last_updated_at:now/1000}});
  const requested=addresses(url);if(requested.includes(ids[20]))return response({},503);
  return response({data:requested.map(row)});
 },now);
 const result=fastStep({...s,discovery:data.discovery},data.quotes,now).state;
 assert.deepEqual(s,snapshot);assert.equal(result.paused,true);assert.equal(result.initialCapital,1000);assert.equal(result.fast.stats.buys,0);assert.equal(result.fast.stats.sells,20);
 assert.ok(result.cash>0);assert.equal(result.fast.positions[ids[0]].quantity,0);assert.equal(result.fast.positions[ids[20]].quantity,20);assert.equal(result.fast.positions[ids[20]].valuationStatus,'stale');assert.ok(result.fast.positions[ids[20]].pendingExit);
 assert.ok(result.events.some(e=>e.action==='AGUARDAR'&&e.reason.includes('Saída pendente')));
});
test('respostas malformadas e FX futuro não derrubam os demais lotes nem geram valores fictícios',async()=>{
 const d=await discover(previous(),ids,async url=>{
  if(url.includes('coingecko'))return response({'usd-coin':{brl:1,usd:1,last_updated_at:1e300}});
  const requested=addresses(url);return response({data:[null,...requested.map(row)]});
 },now,{discoverNew:false});assert.deepEqual(poolQuotes(d,now),{});assert.equal(d.status,'indisponível');assert.ok(d.error.includes('Câmbio'));
});
