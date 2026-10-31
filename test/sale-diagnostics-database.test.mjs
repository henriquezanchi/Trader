import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{PGlite}from'@electric-sql/pglite';
test('diagnóstico lê só auditoria privada; revisão pendente pode ser concluída sem apagar triagem',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['001_trade_lab.sql','002_audit.sql','003_research.sql','004_prediction_quality.sql','006_equity_history.sql','008_scenario_studies.sql','009_scenario_versions.sql','010_execution_quotes.sql','014_quality_strategy.sql','015_recommendation_observatory.sql','016_sale_diagnostics.sql'])await db.exec(await readFile(new URL('../supabase/'+name,import.meta.url),'utf8'));
 const before=(await db.query('select payload from trade_lab.state')).rows[0].payload,now=Date.now(),at=new Date(now-7200000).toISOString();
 const buy={id:'buy',at:new Date(now-10800000).toISOString(),asset:'bitcoin',mode:'fast',action:'COMPRAR',price:100,quantity:1};
 const sale={id:'sale',at,asset:'bitcoin',mode:'fast',action:'VENDER',price:99,quantity:1,realizedPnl:-2,reason:'Prazo máximo da posição encerrado',before:{costBasis:101},learning:{entryId:'buy'}};
 await db.query("insert into trade_lab.audit(state_version,kind,decisions,context) values(100,'cycle',$1,'{}'),(101,'cycle',$2,'{}')",[JSON.stringify([buy]),JSON.stringify([sale])]);
 await db.query("insert into trade_lab.quote_observations values('bitcoin','coingecko',$1,$1,102,(select min(id) from trade_lab.audit))",[new Date(now-3600000).toISOString()]);
 const r=(await db.query('select public.trade_lab_sale_diagnostics() as r')).rows[0].r;assert.equal(r.length,1);assert.equal(r[0].entry_price,100);assert.equal(r[0].after_hour.price,102);
 await db.query("insert into trade_lab.tip_candidates(id,snapshot) values('candidate','{}')");
 await db.query('select public.trade_lab_tips_review($1,$2)',['candidate',JSON.stringify({status:'needs-original',reason:'Manchete apenas; original ainda pendente'})]);
 await db.query('select public.trade_lab_tips_review($1,$2)',['candidate',JSON.stringify({status:'registered',reason:'Original lido e hipótese registrada'})]);
 const c=(await db.query('select public.trade_lab_tips_read() as r')).rows[0].r.candidates[0];assert.equal(c.review.status,'registered');assert.equal(c.review.previous.status,'needs-original');
 assert.deepEqual((await db.query('select payload from trade_lab.state')).rows[0].payload,before);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.trade_lab_sale_diagnostics()'),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');assert.equal((await db.query('select public.trade_lab_sale_diagnostics() as r')).rows[0].r.length,1);
 }finally{await db.close();}
});
