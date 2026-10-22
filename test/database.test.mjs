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
