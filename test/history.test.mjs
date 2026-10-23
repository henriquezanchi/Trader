import test from 'node:test';
import assert from 'node:assert/strict';
import { hourlyHistory, bootstrapTick } from '../lib/history.mjs';
import { configurePortfolio, PROFILES } from '../lib/portfolio.mjs';
import { initialState } from '../lib/engine.mjs';
const now = Date.parse('2026-10-23T19:17:00Z');
const baseHour = Math.floor(now / 3600000);
const prices = Array.from({ length: 48 }, (_, i) => [(baseHour - 48 + i) * 3600000 + 10 * 60000, 100 + i]);
function state() { const s = initialState(1000); s.paused = true; const configured = configurePortfolio(s, { ...PROFILES.moderado, profile: 'moderado' }); configured.paused = false; return configured; }
const response = value => ({ ok: true, json: async () => value });
const fetcher = async url => url.includes('market_chart') ? response({ prices }) : response(Object.fromEntries(['bitcoin', 'ethereum', 'solana'].map(id => [id, { brl: 150, last_updated_at: now / 1000 }])));

test('histórico seleciona 23 horas passadas reais, rejeita lacunas e não usa dados futuros', () => {
  const h = hourlyHistory([...prices, [now + 3600000, 1e7]], now);
  assert.equal(h.length, 23); assert.ok(h.every(x => x.historical && Date.parse(x.at) < now));
  assert.equal(h.at(-1).price, 147);
  assert.throws(() => hourlyHistory(prices.slice(0, -1), now), /incompleto/);
  assert.throws(() => hourlyHistory(prices.map(([t]) => [t, -1]), now), /incompleto/);
});

test('preparação permite avaliar agora sem replay, preserva capital e audita parâmetros', async () => {
  const before = state(); before.events = [{ action: 'AGUARDAR', reason: 'registro anterior' }];
  let saved, commits = 0;
  const repo = { read: async () => ({ version: 9, state: before }), commit: async (version, s) => { assert.equal(version, 9); saved = s; commits++; } };
  const result = await bootstrapTick(repo, fetcher, now);
  assert.equal(commits, 1); assert.equal(result.version, 10); assert.equal(before.cash, 1000); assert.equal(before.events.length, 1);
  assert.equal(saved.initialCapital, 1000); assert.equal(saved.bootstrap.replayedTrades, 0);
  assert.equal(saved.portfolio.bitcoin.observations.length, 24);
  assert.equal(saved.events[0].reason, 'registro anterior');
  assert.ok(saved.events.slice(1).every(e => e.at === new Date(now).toISOString() && e.parameters && e.indicators.continuous && e.quote.observedAt));
  assert.equal(saved.events.filter(e => e.action === 'COMPRAR').length, 3);
  assert.ok(saved.cash < 1000); // Only the single current decision trades, never the historical samples.
});

test('dados incompletos, preço antigo, pausa, posição aberta ou repetição não gravam', async () => {
  let commits = 0, s = state();
  const repo = { read: async () => ({ version: 1, state: s }), commit: async () => commits++ };
  await assert.rejects(bootstrapTick(repo, async () => response({ prices: [] }), now));
  await assert.rejects(bootstrapTick(repo, async url => url.includes('market_chart') ? response({ prices }) : response({ bitcoin: { brl: 100, last_updated_at: now / 1000 - 1000 } }), now));
  s.paused = true; await assert.rejects(bootstrapTick(repo, fetcher, now), /Inicie/);
  s.paused = false; s.portfolio.bitcoin.quantity = 1; await assert.rejects(bootstrapTick(repo, fetcher, now), /posição/);
  s.portfolio.bitcoin.quantity = 0; s.bootstrap = {}; await assert.rejects(bootstrapTick(repo, fetcher, now), /já foi/);
  delete s.bootstrap; s.lastTick = new Date(now).toISOString().slice(0, 13); await assert.rejects(bootstrapTick(repo, fetcher, now), /hora já/);
  assert.equal(commits, 0);
});

test('pausa concorrente invalida preparação inteira por CAS, sem sobrescrever controle', async () => {
  const current = state(); let version = 1;
  const repo = { read: async () => ({ version, state: structuredClone(current) }), commit: async v => { assert.notEqual(v, version); throw new Error('concurrent control'); } };
  let interrupted = false;
  const provider = async u => { if (!interrupted) { interrupted = true; current.paused = true; version++; } return fetcher(u); };
  await assert.rejects(bootstrapTick(repo, provider, now), /concurrent control/);
  assert.equal(current.paused, true); assert.equal(current.cash, 1000); assert.equal(current.bootstrap, undefined);
});
