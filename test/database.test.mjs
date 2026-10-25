import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { initialState } from '../lib/engine.mjs';
import { configurePortfolio, PROFILES } from '../lib/portfolio.mjs';

test('migração real: isolamento por roles, saldo inicial e gravações concorrentes', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(await readFile(new URL('../supabase/001_trade_lab.sql', import.meta.url), 'utf8'));
    const state = (await db.query('select * from trade_lab.state')).rows[0];
    assert.equal(state.payload.cash, 1000); assert.equal(state.version, 0);
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from trade_lab.state'), /permission denied/);
    await assert.rejects(db.query("select public.trade_lab_commit(0, '{}'::jsonb)"), /permission denied/);
    await db.exec('reset role; set role authenticated');
    await assert.rejects(db.query('select * from trade_lab.state'), /permission denied/);
    await assert.rejects(db.query("select public.trade_lab_commit(0, '{}'::jsonb)"), /permission denied/);
    await assert.rejects(db.query('select public.trade_lab_read()'), /permission denied/);
    await db.exec('reset role; set role service_role');
    const paused = initialState(); paused.paused = true;
    const save = async s => (await db.query('select public.trade_lab_commit($1,$2::jsonb) as ok', [0, JSON.stringify(s)])).rows[0].ok;
    assert.equal(await save(paused), true);
    assert.equal(await save(initialState()), false); // Tick que leu antes da pausa não pode sobrescrevê-la.
    const latest = (await db.query('select public.trade_lab_read() as state')).rows[0].state;
    assert.equal(latest.payload.paused, true); assert.equal(latest.version, 1);
    await assert.rejects(db.query('select public.trade_lab_commit($1,$2::jsonb)', [1, JSON.stringify({ ...initialState(), cash: -1 })]), /Estado inválido/);
    await assert.rejects(db.query("select public.trade_lab_commit(1, '{}'::jsonb)"), /Estado inválido/);
    assert.equal((await db.query('select public.trade_lab_read() as state')).rows[0].state.version, 1);
    const multi = configurePortfolio(latest.payload, { ...PROFILES.moderado, profile: 'moderado' });
    assert.equal((await db.query('select public.trade_lab_commit($1,$2::jsonb) as ok', [1, JSON.stringify(multi)])).rows[0].ok, true);
    const restored = (await db.query('select public.trade_lab_read() as state')).rows[0].state;
    assert.deepEqual(restored.payload.config, multi.config);
    assert.equal(restored.payload.cash, latest.payload.cash);
    assert.equal(restored.payload.paused, true);
    assert.equal(restored.version, 2);
  } finally { await db.close(); }
});

test('auditoria privada é persistente, atômica, paginada e preserva parâmetros originais', async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(await readFile(new URL('../supabase/001_trade_lab.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/002_audit.sql', import.meta.url), 'utf8'));
    const count = async () => Number((await db.query("select jsonb_array_length(public.trade_lab_audit_read(null)->'entries') as n")).rows[0].n);
    assert.equal(await count(), 1);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select * from trade_lab.audit'), /permission denied/);
      await assert.rejects(db.query('select public.trade_lab_audit_read(null)'), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    const s = initialState(1000); s.paused = true;
    const multi = configurePortfolio(s, { ...PROFILES.moderado, profile: 'moderado' });
    multi.events.push({ id: 'synthetic-decision', action: 'AGUARDAR', parameters: { engine: 'test', targetPct: 5 }, indicators: { fastMean: 101, slowMean: 100 } });
    const commit = async (v, state) => (await db.query('select public.trade_lab_commit($1,$2::jsonb) as ok', [v, JSON.stringify(state)])).rows[0].ok;
    assert.equal(await commit(0, multi), true); assert.equal(await count(), 2);
    assert.equal(await commit(0, multi), false); assert.equal(await count(), 2);
    const page = (await db.query('select public.trade_lab_audit_read(null) as page')).rows[0].page;
    assert.equal(page.entries[0].decisions[0].parameters.targetPct, 5);
    assert.equal(page.entries[0].parameters.targetPct, 5);
    assert.equal(page.entries[1].kind, 'legacy_snapshot'); assert.equal(page.entries[1].parameters, null);
    multi.config.targetPct = 10;
    assert.equal(await commit(1, multi), true);
    const changed = (await db.query('select public.trade_lab_audit_read(null) as page')).rows[0].page;
    assert.equal(changed.entries[0].parameters.targetPct, 10);
    assert.equal(changed.entries[0].decisions.length, 0); // Old decisions are never duplicated on config changes.
    assert.equal(changed.entries[1].decisions[0].parameters.targetPct, 5);
    await assert.rejects(db.query('delete from trade_lab.audit'), /permission denied/);
    for (let v = 2; v < 33; v++) assert.equal(await commit(v, multi), true);
    const first = (await db.query('select public.trade_lab_audit_read(null) as page')).rows[0].page;
    assert.equal(first.entries.length, 30); assert.ok(first.nextCursor);
    const older = (await db.query('select public.trade_lab_audit_read($1) as page', [first.nextCursor])).rows[0].page;
    assert.equal(older.entries.length, 4);
    assert.ok(older.entries.every(e => e.id < first.nextCursor));
  } finally { await db.close(); }
});

test('pesquisa privada: trigger atômico, versão concorrente e paginação', async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 for(const migration of ['001_trade_lab.sql','002_audit.sql','003_research.sql'])await db.exec(await readFile(new URL('../supabase/'+migration,import.meta.url),'utf8'));
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.trade_lab_research_read(null)'),/permission denied/);await assert.rejects(db.query('select * from trade_lab.research_cycles'),/permission denied/);await db.exec('reset role');}
 await db.exec('set role service_role');const s=initialState(1000);
 const commit=async(v)=>(await db.query('select public.trade_lab_commit($1,$2::jsonb) as ok',[v,JSON.stringify(s)])).rows[0].ok;
 for(let v=0;v<14;v++){s.researchDelta={slot:v};assert.equal(await commit(v),true);assert.equal(await commit(v),false);}
 const page=(await db.query('select public.trade_lab_research_read(null) as page')).rows[0].page;assert.equal(page.entries.length,12);assert.equal(page.entries[0].data.slot,13);
 const older=(await db.query('select public.trade_lab_research_read($1) as page',[page.nextCursor])).rows[0].page;assert.equal(older.entries.length,2);
 assert.equal(await commit(14),true);const unchanged=(await db.query('select public.trade_lab_research_read(null) as page')).rows[0].page;assert.equal(unchanged.entries[0].state_version,14);
 await assert.rejects(db.query('delete from trade_lab.research_cycles'),/permission denied/);
 }finally{await db.close();}
});

test('relatório de qualidade é privado e não desconta taxas duas vezes do resultado líquido',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const name of ['001_trade_lab.sql','002_audit.sql','003_research.sql','004_prediction_quality.sql','005_training_lookup_index.sql'])await db.exec(await readFile(new URL('../supabase/'+name,import.meta.url),'utf8'));
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select public.trade_lab_quality_read()'),/permission denied/);await assert.rejects(db.query("select public.trade_lab_training_data_read('bitcoin')"),/permission denied/);await db.exec('reset role');}
 const s=initialState(1000);s.events=[{id:'buy',at:'2026-10-24T12:00:00Z',mode:'fast',asset:'solana:fixture',action:'COMPRAR',fee:.1},{id:'sell',at:'2026-10-24T13:00:00Z',mode:'fast',asset:'solana:fixture',action:'VENDER',fee:.2,realizedPnl:-2}];
 s.researchDelta={directionCycle:{newPredictions:[{id:'p',horizon:1}],outcomes:[{id:'p',horizon:1,status:'scored',targetAt:'2026-10-24T13:00:00Z',actualObservedAt:'2026-10-24T12:59:00Z'}]}};
 await db.query('select public.trade_lab_commit(0,$1::jsonb)',[JSON.stringify(s)]);await db.exec('set role service_role');const report=(await db.query('select public.trade_lab_quality_read() as report')).rows[0].report;
 assert.equal(report.trading[0].realized_net,-2);assert.equal(report.trading[0].fees,.3);assert.equal(report.evaluation[0].price_before_target,1);assert.equal(report.issuance[0].fingerprinted,0);
 await db.exec('reset role');
 for(const [asset,version] of [['solana',101],['bitcoin',102],['solana',103]])await db.query('insert into trade_lab.research_cycles(state_version,data) values($1,$2::jsonb)',[version,JSON.stringify({historyTraining:{report:{asset},observations:[version]}})]);
 await db.exec('set role service_role');
 assert.deepEqual((await db.query("select public.trade_lab_training_data_read('solana') as result")).rows[0].result.observations,[103]);
 assert.deepEqual((await db.query("select public.trade_lab_training_data_read('bitcoin') as result")).rows[0].result.observations,[102]);
 }finally{await db.close();}
});
