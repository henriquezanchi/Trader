import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, step, equity, validateQuote } from '../lib/engine.mjs';
import { getQuote, runTick } from '../lib/services.mjs';
import handler, { authorized } from '../api/agent.mjs';

const start = Date.parse('2026-10-01T06:17:00Z');
const quote = (price, now) => ({ price, observedAt: new Date(now).toISOString() });
function trend() {
  let state = initialState();
  for (let i = 0; i < 24; i++) state = step(state, quote(500000 + i * 2000, start + i * 3600000), start + i * 3600000).state;
  return state;
}
test('aquecimento não negocia; tendência compra uma única posição com custos', () => {
  let state = initialState();
  for (let i = 0; i < 23; i++) state = step(state, quote(500000 + i * 2000, start + i * 3600000), start + i * 3600000).state;
  assert.equal(state.cash, 1000); assert.equal(state.btc, 0);
  state = step(state, quote(546000, start + 23 * 3600000), start + 23 * 3600000).state;
  assert.equal(state.cash, 980); assert.ok(state.btc > 0);
  assert.ok(equity(state) < 1000);
  assert.equal(state.events.at(-1).fee, .02);
  const next = step(state, quote(548000, start + 24 * 3600000), start + 24 * 3600000).state;
  assert.equal(next.cash, 980); assert.equal(next.btc, state.btc);
});
test('uma hora só pode ser processada uma vez; execução anterior é ignorada', () => {
  const state = trend();
  const again = step(state, quote(546000, start + 23 * 3600000), start + 23 * 3600000 + 1000);
  assert.equal(again.duplicate, true); assert.deepEqual(again.state, state);
  const older = step(state, quote(546000, start), start);
  assert.equal(older.duplicate, true);
});
test('pausa manual mantém posição e impede operações por estratégia', () => {
  const state = trend(); state.paused = true;
  const next = step(state, quote(547000, start + 24 * 3600000), start + 24 * 3600000).state;
  assert.equal(next.btc, state.btc); assert.equal(next.cash, 980);
  assert.equal(next.events.at(-1).action, 'AGUARDAR');
});
test('perda diária liquida, mesmo pausado, e considera custos de venda', () => {
  const state = trend(); state.paused = true;
  const now = start + 24 * 3600000;
  const next = step(state, quote(400000, now), now).state;
  assert.equal(next.paused, true); assert.equal(next.btc, 0);
  assert.equal(next.events.at(-1).action, 'VENDER');
  assert.match(next.reason, /diário/); assert.ok(next.cash < 997);
  assert.ok(next.events.at(-1).fee > 0);
});
test('limite total tem prioridade e liquida a posição virtual', () => {
  const state = trend(), now = start + 24 * 3600000;
  const next = step(state, quote(100000, now), now).state;
  assert.equal(next.btc, 0); assert.equal(next.paused, true);
  assert.match(next.reason, /total/);
});
test('novo dia em Brasília usa avaliação anterior como referência', () => {
  const state = trend();
  state.day = '2026-10-01'; state.dayEquity = 1003;
  const now = Date.parse('2026-10-03T03:17:00Z');
  const next = step(state, quote(546000, now), now).state;
  assert.equal(next.day, '2026-10-03');
  assert.equal(next.dayEquity, equity(state));
});
test('janela com lacuna não permite entrada', () => {
  let state = initialState();
  for (let i = 0; i < 24; i++) {
    const now = start + (i + (i > 12 ? 3 : 0)) * 3600000;
    state = step(state, quote(500000 + i * 2000, now), now).state;
  }
  assert.equal(state.btc, 0); assert.match(state.reason, /Aquecimento/);
});
test('sinal de baixa vende sem atingir limite de risco', () => {
  let state = trend();
  state.btc = .000001; state.cash = 999.45; // Exposição pequena permite testar saída sem disparar stop.
  for (let i = 24; i < 31; i++) {
    const now = start + i * 3600000;
    state = step(state, quote(500000, now), now).state;
  }
  assert.equal(state.btc, 0);
  assert.ok(state.events.some(e => e.action === 'VENDER' && e.reason.includes('abaixo')));
});
test('cotação inválida, antiga e futura é rejeitada', () => {
  for (const price of [0, -1, NaN, Infinity, '500000']) assert.throws(() => validateQuote(quote(price, start), start));
  assert.throws(() => validateQuote(quote(500000, start - 600001), start));
  assert.throws(() => validateQuote(quote(500000, start + 60001), start));
});
test('fonte de preço exige sucesso, preço e timestamp recente', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ bitcoin: { brl: 500000, last_updated_at: start / 1000 } }) });
  assert.equal((await getQuote(fetcher, start)).price, 500000);
  await assert.rejects(getQuote(async () => ({ ok: false }), start));
  await assert.rejects(getQuote(async () => ({ ok: true, json: async () => ({ bitcoin: { brl: 500000 } }) }), start));
  await assert.rejects(getQuote(fetcher, start + 600001));
});
test('falha da fonte preserva saldo e observações e registra a decisão de proteção', async () => {
  let stored;
  const initial=initialState();
  const repo={read:async()=>({version:0,state:initial}),commit:async(v,s)=>{assert.equal(v,0);stored=s;}};
  await assert.rejects(runTick(repo,async()=>{throw Error('offline')}));
  assert.equal(stored.cash,initial.cash);assert.equal(stored.btc,initial.btc);assert.deepEqual(stored.observations,initial.observations);assert.equal(stored.events.at(-1).action,'AGUARDAR');assert.equal(stored.events.at(-1).mode,'data');
});

test('token obrigatório, comparação exata e configuração mínima', () => {
  const token = 'a'.repeat(64);
  assert.equal(authorized(`Bearer ${token}`, token), true);
  for (const header of [undefined, '', 'Bearer wrong', `Bearer ${'b'.repeat(64)}`]) assert.equal(authorized(header, token), false);
  assert.equal(authorized('Bearer short', 'short'), false);
});
test('API bloqueia acesso sem token antes de acessar o banco', async () => {
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
  await handler({ headers: {}, method: 'GET', url: '/api/agent' }, res);
  assert.equal(res.code, 401);
});
