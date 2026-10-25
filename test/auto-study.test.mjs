import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshOneStudy } from '../lib/auto-study.mjs';
const now=Date.parse('2026-10-25T12:00:00Z');
const points=()=>Array.from({length:240},(_,i)=>({at:new Date(now-(240-i)*3600000).toISOString(),observedAt:new Date(now-(240-i)*3600000).toISOString(),price:100+Math.sin(i/4),source:'coingecko-hourly-observation'}));
test('atualização automática usa somente novos dados conhecidos e mantém carteira intacta',async()=>{
 const data=points(),s={cash:800,config:{allocations:{bitcoin:10}},portfolio:{bitcoin:{observations:[{at:new Date(now).toISOString(),observedAt:new Date(now-1000).toISOString(),price:101}]}}},before=structuredClone(s);let saved;
 const repo={scenarioDataset:async()=>({observations:data,report:{source:'CoinGecko'}}),scenarioSave:async(asset,study,observations)=>{saved={asset,study,observations};}};
 const ok=await refreshOneStudy(repo,s,[{asset:'bitcoin',recordedAt:new Date(now-2*86400000).toISOString(),models:{1:{datasetHash:'old'}}}],now);
 assert.equal(ok,true);assert.equal(saved.asset,'bitcoin');assert.equal(saved.observations.at(-1).at,new Date(now).toISOString());assert.deepEqual(s,before);
 assert.equal(await refreshOneStudy(repo,s,[{asset:'bitcoin',recordedAt:new Date(now).toISOString()}],now),false);
});
test('não mistura candles de outro provedor com preço atual nem cria operações financeiras',async()=>{
 let saved=false;const repo={scenarioDataset:async()=>({observations:points().map(p=>({...p,source:'yahoo-hourly-completed'}))}),scenarioSave:async()=>{saved=true;}};
 assert.equal(await refreshOneStudy(repo,{config:{allocations:{bitcoin:10}},portfolio:{bitcoin:{observations:[]}}},[],now),false);assert.equal(saved,false);
});
