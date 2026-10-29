import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('projeção privada preserva auditoria, custos e integridade; separa regras antigas e novas',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const file of ['001_trade_lab.sql','002_audit.sql','003_research.sql','004_prediction_quality.sql'])await db.exec(await readFile(new URL('../supabase/'+file,import.meta.url),'utf8'));
 const insert=async(version,events)=>db.query("insert into trade_lab.audit(state_version,kind,decisions,context) values($1,'cycle',$2::jsonb,'{}')",[version,JSON.stringify(events)]);
 const now=new Date().toISOString(),trade=(id,action,pnl,arm='trend-hours')=>({id,at:now,asset:'bitcoin',mode:'fast',action,fee:.1,realizedPnl:pnl,parameters:{explorationArm:arm,entryPolicy:'paper-entry-value-v1'},learning:{entryId:action==='VENDER'?'buy':null}});
 await insert(100,[trade('buy','COMPRAR',null),trade('sell','VENDER',2),{...trade('pool','VENDER',-5),asset:'solana:old',parameters:{},learning:{}}]);
 const dir={directionCycle:{newPredictions:[{id:'f',protocolId:'v2',horizon:1,targetAt:'2099-01-01',modelHash:'hash',inputHash:'hash',modelSnapshot:{large:'private'}}],outcomes:[{id:'f',protocolId:'v2',horizon:1,status:'scored',targetAt:'2020-01-02',actualObservedAt:'2020-01-01'}]}};
 await db.query('insert into trade_lab.research_cycles(state_version,data) values(100,$1)',[JSON.stringify(dir)]);
 const before=(await db.query('select public.trade_lab_quality_read() as r')).rows[0].r,wallet=(await db.query('select payload from trade_lab.state')).rows[0].payload;
 await db.exec(await readFile(new URL('../supabase/014_quality_strategy.sql',import.meta.url),'utf8'));
 const after=(await db.query('select public.trade_lab_quality_read() as r')).rows[0].r;
 for(const k of ['trading','evaluation','issuance'])assert.deepEqual(after[k],before[k]);
 const r=after.strategies.find(r=>r.period==='24h'&&r.arm==='trend-hours');assert.equal(r.realized_net,2);assert.equal(r.fees,.2);assert.equal(r.sells,1);assert.equal(r.expectancy_brl,2);
 assert.equal(after.strategies.find(r=>r.period==='all'&&r.asset_group==='new-pools').realized_net,-5);
 await insert(101,[trade('sale2','VENDER',-1,'wrong-exit-arm')]);
 const next=(await db.query('select public.trade_lab_quality_read() as r')).rows[0].r.strategies.find(r=>r.period==='all'&&r.arm==='trend-hours');assert.equal(next.sells,2);assert.equal(next.realized_net,1);assert.equal(next.profit_factor,2);
 await db.query('insert into trade_lab.research_cycles(state_version,data) values(101,$1)',[JSON.stringify(dir)]);
 assert.equal((await db.query('select public.trade_lab_quality_read() as r')).rows[0].r.issuance[0].recorded_predictions,2);
 assert.deepEqual((await db.query('select payload from trade_lab.state')).rows[0].payload,wallet);
 for(const role of ['anon','authenticated','service_role']){await db.exec('set role '+role);await assert.rejects(db.query('select * from trade_lab.quality_audit'),/permission denied/);await assert.rejects(db.query('select * from trade_lab.quality_research'),/permission denied/);if(role!=='service_role')await assert.rejects(db.query('select public.trade_lab_quality_read()'),/permission denied/);else assert.ok((await db.query('select public.trade_lab_quality_read() as r')).rows[0].r.strategies.length);await db.exec('reset role');}
 }finally{await db.close();}
});
