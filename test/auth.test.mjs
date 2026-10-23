import test from 'node:test';
import assert from 'node:assert/strict';
import authHandler from '../api/auth.mjs';
import agentHandler from '../api/agent.mjs';
import { cookieTokens, allowedUser } from '../lib/auth.mjs';

const origin = 'https://trader-zanchi.vercel.app';
const owner = { id: 'owner-1', email: 'owner@example.test', email_confirmed_at: '2026-01-01T00:00:00Z', is_anonymous: false };
const session = { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, user: owner };
function res() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(d) { this.data = d; } }; }
async function sandbox(fn) {
  const originalEnv = { ...process.env }, originalFetch = globalThis.fetch;
  Object.assign(process.env, { APP_ORIGIN: origin, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service', TRADE_LAB_USER_IDS: 'owner-1,owner-2', TRADE_LAB_EMAILS: 'owner@example.test,other@example.test', BOT_TOKEN: 's'.repeat(64) });
  const calls = [];
  let provider = async () => ({ status: 200, ok: true, json: async () => structuredClone(session) });
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return provider(url, options); };
  const run = async (action, body = {}, options = {}) => {
    const response = res();
    await authHandler({ url: `/api/auth?action=${action}`, method: action === 'session' ? 'GET' : 'POST', body, headers: { origin, cookie: '__Host-trade_lab_access=synthetic-access; __Host-trade_lab_refresh=synthetic-refresh', ...options } }, response);
    return response;
  };
  try { await fn({ run, calls, setProvider: p => { provider = p; } }); }
  finally { globalThis.fetch = originalFetch; for (const k of Object.keys(process.env)) if (!Object.hasOwn(originalEnv, k)) delete process.env[k]; Object.assign(process.env, originalEnv); }
}

test('login autorizado emite cookies HttpOnly/Secure sem devolver tokens ao JavaScript', async () => sandbox(async ({ run, calls }) => {
  const r = await run('login', { email: owner.email, password: 'synthetic-password' });
  assert.equal(r.code, 200); assert.deepEqual(r.data, { authenticated: true });
  assert.equal(r.headers['Set-Cookie'].length, 2);
  for (const c of r.headers['Set-Cookie']) { assert.match(c, /HttpOnly/); assert.match(c, /; Secure/); assert.match(c, /SameSite=Strict/); assert.match(c, /Path=\//); assert.match(c, /^__Host-/); }
  assert.equal(calls[0].options.headers.apikey, 'synthetic-anon');
  assert.ok(!calls[0].options.headers.Authorization);
}));

test('contas do projeto compartilhado não autorizadas e contas anônimas são bloqueadas', async () => sandbox(async ({ run, calls, setProvider }) => {
  let r = await run('login', { email: 'stranger@example.test', password: 'synthetic-password' });
  assert.equal(r.code, 401); assert.equal(calls.length, 0);
  setProvider(async () => ({ ok: true, status: 200, json: async () => ({ ...session, user: { ...owner, id: 'unrelated-app-user' } }) }));
  r = await run('login', { email: owner.email, password: 'synthetic-password' }); assert.equal(r.code, 403);
  assert.ok(!r.headers['Set-Cookie'].some(c => c.includes('synthetic-access')));
  assert.equal(allowedUser({ ...owner, is_anonymous: true }), false);
  assert.equal(allowedUser({ ...owner, email_confirmed_at: null }), false);
  assert.equal(allowedUser({ ...owner, id: 'owner-2', email: 'other@example.test' }), true);
}));

test('login, recuperação e mutações exigem Origin correto; nenhum pedido externo é feito', async () => sandbox(async ({ run, calls }) => {
  for (const action of ['login', 'recover', 'reset', 'logout', 'refresh', 'recovery-session']) {
    const r = await run(action, { email: owner.email, password: 'synthetic-password' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.equal(r.code, 403);
  }
  assert.equal(calls.length, 0);
}));

test('sessão é validada no serviço e refresh funciona sem expor credenciais', async () => sandbox(async ({ run, calls, setProvider }) => {
  setProvider(async () => ({ ok: false, status: 401 }));
  let r = await run('session'); assert.equal(r.code, 401);
  assert.equal(r.headers['Set-Cookie'], undefined, 'An expired access cookie must not erase the refresh cookie');
  setProvider(async () => ({ ok: true, status: 200, json: async () => structuredClone(session) }));
  r = await run('refresh'); assert.equal(r.code, 200);
  assert.match(calls.at(-1).url, /grant_type=refresh_token/);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { refresh_token: 'synthetic-refresh' });
  setProvider(async () => ({ ok: true, status: 200, json: async () => structuredClone(owner) }));
  r = await run('session'); assert.equal(r.code, 200);
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer synthetic-access');
  assert.deepEqual(r.data, { authenticated: true });
}));

test('recuperação só solicita e-mail para contas permitidas e não revela existência', async () => sandbox(async ({ run, calls }) => {
  const r = await run('recover', { email: owner.email }); assert.equal(r.code, 200);
  assert.match(calls[0].url, /recover\?redirect_to=/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: owner.email });
  const other = await run('recover', { email: 'stranger@example.test' }); assert.equal(other.code, 200);
  assert.deepEqual(r.data, other.data); assert.equal(calls.length, 1);
}));

test('link de recuperação validado antes de criar sessão; reset exige senha forte', async () => sandbox(async ({ run, calls, setProvider }) => {
  setProvider(async () => ({ ok: true, status: 200, json: async () => structuredClone(owner) }));
  let r = await run('recovery-session', { accessToken: 'link-access', refreshToken: 'link-refresh' });
  assert.equal(r.code, 200); assert.equal(calls[0].options.headers.Authorization, 'Bearer link-access');
  r = await run('reset', { password: 'short' }); assert.equal(r.code, 400);
  const before = calls.length;
  r = await run('reset', { password: 'synthetic-new-password' }); assert.equal(r.code, 200);
  assert.equal(calls.length - before, 3); // verify user, update password, revoke local session
  assert.equal(calls.at(-2).options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls.at(-2).options.body), { password: 'synthetic-new-password' });
  assert.ok(r.headers['Set-Cookie'].every(c => c.includes('Max-Age=0')));
}));

test('logout apaga cookies e revoga sessão; indisponibilidade não é anunciada como revogação', async () => sandbox(async ({ run, setProvider }) => {
  let r = await run('logout'); assert.equal(r.code, 200);
  assert.ok(r.headers['Set-Cookie'].every(c => c.includes('Max-Age=0')));
  setProvider(async () => { throw new Error('provider offline'); });
  r = await run('logout'); assert.equal(r.code, 503);
  assert.ok(r.headers['Set-Cookie'].every(c => c.includes('Max-Age=0')));
}));

test('cookie forjado ou duplicado e token de agendamento não abrem o painel', async () => sandbox(async ({ setProvider, calls }) => {
  assert.deepEqual(cookieTokens({ headers: { cookie: '__Host-trade_lab_access=a; __Host-trade_lab_access=b' } }), {});
  assert.deepEqual(cookieTokens({ headers: { cookie: '__Host-trade_lab_access=%ZZ' } }), {});
  let r;
  for (const action of ['status', 'audit', 'configure', 'bootstrap']) {
    r = res(); await agentHandler({ url: `/api/agent?action=${action}`, method: ['status', 'audit'].includes(action) ? 'GET' : 'POST', headers: { authorization: `Bearer ${process.env.BOT_TOKEN}` } }, r);
    assert.equal(r.code, 401);
  }
  assert.equal(calls.length, 0);
  setProvider(async () => ({ ok: false, status: 401 }));
  r = res(); await agentHandler({ url: '/api/agent', method: 'GET', headers: { cookie: '__Host-trade_lab_access=forged' } }, r); assert.equal(r.code, 401);
}));

test('agendador continua podendo executar tick sem login ou Origin de navegador', async () => sandbox(async ({ setProvider }) => {
  setProvider(async (url) => {
    if (url.endsWith('trade_lab_read')) return { ok: true, json: async () => ({ version: 1, payload: { initialCapital: 1000, cash: 1000, btc: 0, lastPrice: null, lastTick: null, observations: [], events: [], paused: false } }) };
    if (url.includes('coingecko')) return { ok: true, json: async () => ({ bitcoin: { brl: 100, last_updated_at: Date.now() / 1000 } }) };
    if (url.endsWith('trade_lab_commit')) return { ok: true, json: async () => true };
    throw new Error('Unexpected provider request');
  });
  const r = res(); await agentHandler({ url: '/api/agent?action=tick', method: 'POST', headers: { authorization: `Bearer ${process.env.BOT_TOKEN}` } }, r);
  assert.equal(r.code, 200); assert.equal(r.data.duplicate, false); assert.equal(r.data.version, 2); assert.ok(!('state' in r.data));
}));

test('requisições grandes, método incorreto e provedor limitado falham com segurança', async () => sandbox(async ({ run, setProvider }) => {
  let r = await run('login', { email: owner.email, password: 'x'.repeat(9000) }); assert.equal(r.code, 400);
  setProvider(async () => ({ ok: false, status: 429 }));
  r = await run('login', { email: owner.email, password: 'synthetic-password' }); assert.equal(r.code, 429);
  r = res(); await authHandler({ url: '/api/auth?action=login', method: 'GET', headers: {} }, r); assert.equal(r.code, 405);
}));
