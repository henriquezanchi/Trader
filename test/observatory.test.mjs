import test from 'node:test';import assert from 'node:assert/strict';
import {validateTip,advanceTip,observatoryReport,OBS_PROTOCOL,updateObservatory,collectTipCandidates,OBS_SOURCES} from '../lib/observatory.mjs';
const now=Date.now(),iso=t=>new Date(t).toISOString();
const input={sourceId:'coindesk',author:'Analista público',url:'https://www.coindesk.com/markets/example',publishedAt:iso(now-60000),excerpt:'Comprar Bitcoin no próximo dia conforme a análise publicada.',rationale:'Testar a direção em 24 horas sem reproduzir alvos e stops.',asset:'bitcoin',direction:'COMPRAR',horizonMinutes:1440,horizonBasis:'author',reviewed:true};
const row=()=>({id:'id',snapshot:validateTip(input,now).snapshot,registered_at:iso(now),evaluation:{status:'awaiting-entry'},version:0,phase:'selection'});
const quote=(time,price=100)=>({bitcoin:{price,observedAt:iso(time),source:'coingecko'}});
test('dicas exigem fonte, leitura, trecho e timestamp prospectivo; não há fetch de URL fornecida',()=>{
 const a=validateTip(input,now);assert.equal(a.id,validateTip(input,now).id);assert.equal(a.snapshot.snapshotHash.length,64);
 for(const patch of [{url:'http://coindesk.com/x'},{url:'https://127.0.0.1/x'},{url:'https://coindesk.com.evil.test/x'},{url:'https://secret@coindesk.com/x'},{publishedAt:iso(now+1)},{publishedAt:iso(now-86400001)},{reviewed:false},{horizonMinutes:10},{excerpt:'Buy'},{asset:'fakecoin'}])assert.throws(()=>validateTip({...input,...patch},now));
});
test('primeiro preço deve ser posterior ao registro e a saída posterior ao alvo, custos contam uma vez',()=>{
 const r=row();assert.equal(advanceTip(r,quote(now-1),now),null);const start=advanceTip(r,quote(now+1000),now+1000);assert.equal(start.status,'tracking');r.evaluation=start;
 assert.equal(advanceTip(r,quote(Date.parse(start.targetAt)-1,102),Date.parse(start.targetAt)),null);
 const out=advanceTip(r,quote(Date.parse(start.targetAt),102),Date.parse(start.targetAt));assert.equal(out.status,'scored');assert.ok(out.strategyPct>1.5&&out.strategyPct<2);assert.equal(out.buyHoldPct,out.strategyPct);assert.equal(out.directionCorrect,true);
 assert.equal(advanceTip({...r,evaluation:out},quote(now+1e9,200),now+1e9),null);
 const sell={...row(),snapshot:{...row().snapshot,direction:'VENDER'},evaluation:start};const avoided=advanceTip(sell,quote(Date.parse(start.targetAt),90),Date.parse(start.targetAt));assert.equal(avoided.strategyPct,0);assert.ok(avoided.edgeVsBuyHoldPct>10);assert.equal(avoided.directionCorrect,true);
 const unchanged=advanceTip(r,quote(Date.parse(start.targetAt),100),Date.parse(start.targetAt));assert.ok(unchanged.strategyPct<0);assert.equal(unchanged.directionCorrect,false);
});
test('ausências não viram preços fictícios nem são omitidas do denominador',()=>{
 const r=row();assert.equal(advanceTip(r,{},now+31*60000).status,'missing-entry');const start=advanceTip(r,quote(now),now);r.evaluation=start;
 const target=Date.parse(start.targetAt);assert.equal(advanceTip(r,quote(target,500),target+11*60000).status,'missing-exit');
 const report=observatoryReport({campaign:{selection_ends:iso(now+86400000),capture_ends:iso(now+2*86400000)},recommendations:[{...r,evaluation:{status:'missing-exit'}}]},now);assert.equal(report.sources[0].selection.coverage,0);assert.equal(report.sources[0].selection.missing,1);assert.equal(report.sources[0].selected,false);
});
test('seleção congela no corte: resultado tardio não elege autor; confirmação e prazos separados',()=>{
 const base=row(),cut=now-60000,campaign={selection_ends:iso(cut),capture_ends:iso(now+86400000)},r=(i,at,phase='selection')=>({...base,id:String(i),phase,evaluation:{status:'scored',evaluatedAt:iso(at),strategyPct:i%2?1:-.1,buyHoldPct:-1,directionCorrect:true}});
 const rows=Array.from({length:20},(_,i)=>r(i,cut-1));let report=observatoryReport({campaign,recommendations:rows},now);assert.equal(report.sources[0].selected,true);assert.equal(report.sources[0].confirmed,false);
 report=observatoryReport({campaign,recommendations:rows.map(r=>({...r,evaluation:{...r.evaluation,evaluatedAt:iso(cut+1)}}))},now);assert.equal(report.sources[0].selected,false);
 report=observatoryReport({campaign,recommendations:[...rows,{...r(99,now),snapshot:{...base.snapshot,horizonMinutes:60}}]},now);assert.equal(report.sources.length,2);
 report=observatoryReport({campaign,recommendations:[rows[0],{...rows[1],snapshot:{...base.snapshot,kind:'directional-forecast'}}]},now);assert.equal(report.sources.length,2);assert.ok(report.sources.some(s=>s.kind==='directional-forecast'));
});
test('coleta parcial é explícita, não transforma manchete em recomendação e não repete entrada',async()=>{
 const xml=`<rss><channel><item><title>Buy Bitcoin now? Analyst discusses outlook</title><link>https://www.coindesk.com/markets/example</link><pubDate>${new Date(now-1000).toUTCString()}</pubDate><source>CoinDesk</source></item></channel></rss>`;
 let i=0;const result=await collectTipCandidates(async()=>{const n=i++;if(n===0)throw Error('offline');return {ok:true,text:async()=>xml.replace('<source>CoinDesk</source>','<source>'+OBS_SOURCES[n].name+'</source>')};},now);
 assert.equal(result.sources[0].status,'unavailable');assert.equal(result.items.length,4);assert.ok(result.items.every(x=>x.status==='candidate'&&!x.direction));
 const calls=[],r=row(),state=JSON.stringify(r);let books=0;
 await updateObservatory({observatoryRead:async()=>{books++;return {recommendations:[r],campaign:{capture_ends:iso(now+1e8)}};},observatoryAdvance:async p=>calls.push(p),observatoryCollect:async()=>assert.fail('not collecting')},{},now,{collect:false,getAdditionalQuotes:async()=>quote(now)});
 assert.equal(calls[0][0].evaluation.status,'tracking');assert.equal(JSON.stringify(r),state);assert.equal(books,1);
});
