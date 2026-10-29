import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';import{validateTip}from'../lib/observatory.mjs';
test('observatório privado: registro imutável, duplicação, CAS, captura parcial, revisão e carteira preservada',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['001_trade_lab.sql','002_audit.sql','006_equity_history.sql','015_recommendation_observatory.sql'])await db.exec(await readFile(new URL('../supabase/'+name,import.meta.url),'utf8'));
 const wallet=(await db.query('select payload from trade_lab.state')).rows[0].payload;
 const tip=validateTip({sourceId:'coindesk',author:'Autora de teste',url:'https://www.coindesk.com/x',publishedAt:new Date(Date.now()-60000).toISOString(),excerpt:'Trecho de recomendação sintética para teste privado.',rationale:'Avaliação sintética em uma hora, sem alvo intradiário.',asset:'bitcoin',direction:'COMPRAR',horizonMinutes:60,horizonBasis:'standardized',reviewed:true});
 const register=async t=>(await db.query('select public.trade_lab_tips_register($1,$2) as r',[t.id,JSON.stringify(t.snapshot)])).rows[0].r;
 const one=await register(tip),again=await register({...tip,snapshot:{...tip.snapshot,author:'Alterado'}});assert.equal(again.snapshot.author,one.snapshot.author);
 const patch=async e=>(await db.query('select public.trade_lab_tips_advance($1) as n',[JSON.stringify([{id:one.id,version:0,evaluation:e}])])).rows[0].n;
 await assert.rejects(patch({status:'tracking',entry:{observedAt:new Date(Date.now()-1e6).toISOString()},targetAt:new Date(Date.now()+36e5).toISOString()}),/retroativa/);
 const t=Date.now()+10;await new Promise(resolve=>setTimeout(resolve,15));const evaluation={status:'tracking',entry:{observedAt:new Date(t).toISOString(),price:100,quantity:9.98},targetAt:new Date(t+36e5).toISOString()};assert.equal(await patch(evaluation),1);assert.equal(await patch({...evaluation,status:'missing-entry'}),0);
 // A controlled old fixture tests late scoring and immutability without waiting an hour.
 const old=Date.now()-61*60000,exit=Date.now()-1000;
 await db.query("update trade_lab.tip_recommendations set registered_at=$1,evaluation=$2 where id=$3",[new Date(old-1000).toISOString(),JSON.stringify({status:'tracking',entry:{observedAt:new Date(old).toISOString()},targetAt:new Date(old+36e5).toISOString()}),one.id]);
 await db.query('insert into trade_lab.equity_points(observed_at,audit_id,equity) values($1,(select min(id) from trade_lab.audit),1000),($2,(select min(id) from trade_lab.audit),1005)',[new Date(old-1000).toISOString(),new Date(exit-1000).toISOString()]);
 const score={status:'scored',entry:{observedAt:new Date(old).toISOString()},targetAt:new Date(old+36e5).toISOString(),exit:{observedAt:new Date(exit).toISOString()},strategyPct:1};
 const advance=async e=>(await db.query('select public.trade_lab_tips_advance($1) as n',[JSON.stringify([{id:one.id,version:1,evaluation:e}])])).rows[0].n;
 await assert.rejects(advance({...score,entry:{observedAt:new Date().toISOString()}}),/imutável/);assert.equal(await advance(score),1);assert.equal(await advance({...score,strategyPct:999}),0);
 const collection={at:new Date().toISOString(),sources:[{sourceId:'coindesk',status:'ok'}],items:[{id:'candidate',title:'Texto original',url:'https://coindesk.com/x'}]};
 await db.query('select public.trade_lab_tips_collect($1)',[JSON.stringify(collection)]);await db.query('select public.trade_lab_tips_collect($1)',[JSON.stringify({...collection,items:[{...collection.items[0],title:'Editado'}]})]);
 await db.query('select public.trade_lab_tips_review($1,$2)',['candidate',JSON.stringify({status:'rejected',reason:'Não apresenta direção e prazo'})]);
 const report=(await db.query('select public.trade_lab_tips_read() as r')).rows[0].r;assert.equal(report.candidates[0].snapshot.title,'Texto original');assert.equal(report.candidates[0].review.status,'rejected');assert.equal(report.recommendations[0].evaluation.strategyPct,1);assert.ok(Math.abs(report.recommendations[0].evaluation.botPct-.5)<1e-9);assert.equal(report.collection.items,undefined);
 assert.deepEqual((await db.query('select payload from trade_lab.state')).rows[0].payload,wallet);
 for(const role of ['anon','authenticated','service_role']){await db.exec('set role '+role);for(const table of ['tip_candidates','tip_campaign','tip_recommendations'])await assert.rejects(db.query('select * from trade_lab.'+table),/permission denied/);if(role==='service_role')assert.equal((await db.query('select public.trade_lab_tips_read() as r')).rows[0].r.recommendations.length,1);else{await assert.rejects(db.query('select public.trade_lab_tips_read()'),/permission denied/);await assert.rejects(register(tip),/permission denied/);}await db.exec('reset role');}
 }finally{await db.close();}
});
