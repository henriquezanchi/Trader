import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, equity } from '../lib/engine.mjs';
import { ASSETS, PROFILES, validateConfig, configurePortfolio, portfolioStep, stopReason } from '../lib/portfolio.mjs';
import { getQuotes, runTick } from '../lib/services.mjs';
import handler from '../api/agent.mjs';

const start = Date.parse('2026-10-01T06:17:00Z');
const config = (profile = 'moderado') => ({ profile, ...structuredClone(PROFILES[profile]) });
function configured() { const s = initialState(1000); s.paused = true; return configurePortfolio(s, config()); }
const quotes = (price, now) => Object.fromEntries(ASSETS.map(a => [a.id, { price, observedAt: new Date(now).toISOString() }]));
function warm() {
  let s = configured(); s.paused = false;
  for (let i = 0; i < 24; i++) { const now = start + i * 3600000; s = portfolioStep(s, quotes(100 + i, now), now).state; }
  return s;
}
test('perfis válidos, caixa preservado, ativos e pesos arbitrários rejeitados', () => {
  for (const p of Object.keys(PROFILES)) assert.ok(validateConfig(config(p)));
  for (const overrides of [{ allocations: { unknown: 1 } }, { allocations: { bitcoin: -1 } }, { allocations: { bitcoin: 26 } }, { orderPct: 30 }, { dailyLossPct: 6 }, { days: 1.5 }, { targetPct: Infinity }, { allocations: {} }, { profile: '__proto__' }]) assert.throws(() => validateConfig({ ...config(), ...overrides }));
});
test('conversão preserva saldo, BTC, cotações, histórico e capital; exige pausa', () => {
  const s = initialState(1000); s.cash = 850; s.btc = 1; s.lastPrice = 150; s.events.push({ action: 'LEGADO' });
  s.observations.push({ at: new Date(start).toISOString(), price: 150 });
  assert.throws(() => configurePortfolio(s, config()), /Pause/);
  s.paused = true; const next = configurePortfolio(s, config());
  assert.equal(next.cash, 850); assert.equal(next.initialCapital, 1000); assert.equal(next.portfolio.bitcoin.quantity, 1);
  assert.deepEqual(next.events, s.events); assert.deepEqual(next.portfolio.bitcoin.observations, s.observations);
  assert.equal(equity(next), equity(s)); assert.equal(next.paused, true);
  assert.throws(() => configurePortfolio(next, { ...config(), allocations: { ethereum: 10 } }), /posição aberta/);
});
test('mix compra ativos separadamente com pesos, custos e limite agregado', () => {
  const s = warm();
  assert.ok(s.portfolio.bitcoin.quantity > 0 && s.portfolio.ethereum.quantity > 0 && s.portfolio.solana.quantity > 0);
  // Entrada BTC é limitada a 10%, ETH a 8%, SOL a 2%: não consome os 25% inteiros.
  assert.ok(Math.abs(s.cash - 800) < 1e-8);
  assert.ok(equity(s) < 1000 && equity(s) > 999);
  assert.equal(s.events.filter(e => e.action === 'COMPRAR').length, 3);
  const p = s.portfolio; assert.ok(p.ethereum.quantity * p.ethereum.lastPrice < 80);
  const now = start + 24 * 3600000;
  const next = portfolioStep(s, quotes(124, now), now).state;
  assert.equal(next.cash, s.cash); assert.equal(next.portfolio.bitcoin.quantity, p.bitcoin.quantity);
  const dup = portfolioStep(next, quotes(124, now), now);
  assert.equal(dup.duplicate, true); assert.deepEqual(dup.state, next);
});
test('limite diário agregado liquida todos os ativos, mesmo com pausa manual', () => {
  const s = warm(), now = start + 24 * 3600000; s.paused = true;
  const next = portfolioStep(s, quotes(100, now), now).state;
  assert.equal(next.paused, true); assert.match(next.reason, /diário/);
  for (const p of Object.values(next.portfolio)) assert.equal(p.quantity, 0);
  assert.ok(next.events.slice(-3).every(e => e.action === 'VENDER' && e.fee > 0));
});
test('meta, prazo e perda total param sem elevar aporte para buscar retorno', () => {
  const now = start + 24 * 3600000;
  const loss = portfolioStep(warm(), quotes(1, now), now).state;
  assert.match(loss.reason, /total/); assert.equal(loss.paused, true);
  const gain = portfolioStep(warm(), quotes(200, now), now).state;
  assert.match(gain.reason, /Meta/); assert.equal(gain.paused, true);
  const s = warm(); s.startedAt = new Date(now - 91 * 86400000).toISOString();
  const expired = portfolioStep(s, quotes(123, now), now).state;
  assert.match(expired.reason, /Prazo/); assert.equal(expired.paused, true);
  assert.equal(stopReason({ ...configured(), day: '2026-09-30', dayEquity: 5000 }, start), null);
});
test('aquecimento é individual; ativo novo não herda os preços de BTC', () => {
  let s = initialState(1000); s.paused = true;
  s = configurePortfolio(s, { ...config(), allocations: { bitcoin: 15 } }); s.paused = false;
  for (let i = 0; i < 24; i++) { const now = start + i * 3600000; s = portfolioStep(s, quotes(100 + i, now), now).state; }
  s.paused = true; s = configurePortfolio(s, config()); s.paused = false;
  const now = start + 24 * 3600000;
  const next = portfolioStep(s, quotes(124, now), now).state;
  assert.equal(next.portfolio.solana.quantity, 0);
  assert.match(next.events.findLast(e => e.asset === 'solana').reason, /Aquecimento/);
});
test('cotação ausente ou antiga de um ativo impede qualquer commit', async () => {
  const s = configured(); let commits = 0;
  const repo = { read: async () => ({ version: 1, state: s }), commit: async () => commits++ };
  const q = quotes(100, start); delete q.ethereum;
  await assert.rejects(runTick(repo, async () => q, start));
  q.ethereum = { price: 100, observedAt: new Date(start - 600001).toISOString() };
  await assert.rejects(runTick(repo, async () => q, start));
  assert.equal(commits, 0); assert.equal(s.events.length, 0);
});
test('fonte busca apenas ativos autorizados e valida todos os timestamps', async () => {
  let url;
  const fetcher = async u => { url = u; return { ok: true, json: async () => Object.fromEntries(ASSETS.map(a => [a.id, { brl: 100, last_updated_at: start / 1000 }])) }; };
  const q = await getQuotes(['bitcoin', 'ethereum'], fetcher, start);
  assert.match(url, /bitcoin%2Cethereum/); assert.equal(Object.keys(q).length, 2);
  await assert.rejects(getQuotes(['fake'], fetcher, start));
  await assert.rejects(getQuotes(['solana'], fetcher, start + 600001));
});
test('API persiste configuração por versão, bloqueia conflito e exige token', async () => {
  const savedEnv = { ...process.env }, savedFetch = globalThis.fetch;
  let row = { version: 7, payload: initialState(1000) }; row.payload.paused = true;
  const token = 'test-token-'.repeat(5); let commits = 0;
  process.env.BOT_TOKEN = token; process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-key';
  process.env.APP_ORIGIN = 'https://trader-zanchi.vercel.app'; process.env.SUPABASE_ANON_KEY = 'synthetic-anon'; process.env.TRADE_LAB_USER_IDS = 'owner'; process.env.TRADE_LAB_EMAILS = 'owner@example.test';
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'owner', email: 'owner@example.test', email_confirmed_at: new Date().toISOString() }) };
    if (url.endsWith('trade_lab_read')) return { ok: true, json: async () => structuredClone(row) };
    const body = JSON.parse(opts.body); const ok = body.expected_version === row.version;
    if (ok) { row = { version: row.version + 1, payload: body.next_payload }; commits++; }
    return { ok: true, json: async () => ok };
  };
  async function call(expectedVersion, header = `Bearer ${token}`) {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
    await handler({ headers: { authorization: header, origin: 'https://trader-zanchi.vercel.app', ...(header === `Bearer ${token}` ? { cookie: '__Host-trade_lab_access=synthetic-session' } : {}) }, method: 'POST', url: '/api/agent?action=configure', body: { expectedVersion, config: config() } }, res);
    return res;
  }
  try {
    assert.equal((await call(7, 'Bearer wrong')).code, 401);
    assert.equal((await call(6)).code, 409); assert.equal(commits, 0);
    const r = await call(7); assert.equal(r.code, 200); assert.equal(r.data.version, 8); assert.ok(r.data.state.portfolio); assert.equal(r.data.state.cash, 1000);
    assert.equal((await call(7)).code, 409); assert.equal(commits, 1);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'TRADE_LAB_USER_IDS', 'TRADE_LAB_EMAILS', 'APP_ORIGIN']) { if (savedEnv[key] == null) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  }
});
