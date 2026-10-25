import test from 'node:test';
import assert from 'node:assert/strict';
import { marketContext,CONTEXT_NAMES } from '../lib/market-context.mjs';
import { indicators } from '../lib/indicators.mjs';
const now=Date.parse('2026-10-25T12:00:00Z');
const points=()=>Array.from({length:24},(_,i)=>({at:new Date(now-(23-i)*3600000).toISOString(),price:100+i}));
test('contexto usa somente dados conhecidos e mantém forma finita inclusive com preço constante',()=>{
 const p=points(),technical=indicators(p),a=marketContext(p,technical,now),b=marketContext([...p,{at:new Date(now+3600000).toISOString(),price:1e6}],indicators([...p,{at:new Date(now+3600000).toISOString(),price:1e6}]),now);
 assert.equal(a.ready,true);assert.equal(a.vector.length,CONTEXT_NAMES.length);assert.deepEqual(a.vector,b.vector);assert.ok(a.vector.every(Number.isFinite));
 const flat=p.map(p=>({...p,price:100}));assert.equal(marketContext(flat,indicators(flat),now).ready,true);
});
test('rompimentos e mudanças de inclinação alteram o contexto, mas lacunas não são inventadas',()=>{
 const p=points(),a=marketContext(p,indicators(p),now),b=structuredClone(p);b.at(-1).price=80;const changed=marketContext(b,indicators(b),now);assert.notDeepEqual(a.vector,changed.vector);assert.ok(a.vector[9]>0);assert.ok(changed.vector[15]<0);
 assert.equal(marketContext(p.slice(1),indicators(p.slice(1)),now).ready,false);
});
