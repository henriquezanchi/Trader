import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { ASSETS, stopReason } from './portfolio.mjs';
import { equity, validateQuote } from './engine.mjs';
import { indicators } from './indicators.mjs';

const signingKey = () => { const k = process.env.SCHEDULER_SIGNING_KEY; if (!k || k.length < 32) throw new Error('Modo assistido ainda não configurado'); return k; };
const sign = s => createHmac('sha256', signingKey()).update(`trade-lab:assisted:${s}`).digest('base64url');
export const activeIds = s => [...new Set([...Object.keys(s.config?.allocations ?? {}), ...Object.keys(s.portfolio ?? {}).filter(id => s.portfolio[id].quantity > 0)])];
function mark(previous, quotes, now) {
  if (!previous.config || !previous.portfolio) throw new Error('Configure a carteira primeiro');
  const s = structuredClone(previous);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (s.day !== today) { s.day = today; s.dayEquity = equity(s); }
  for (const id of activeIds(s)) {
    validateQuote(quotes[id], now);
    if (now - Date.parse(quotes[id].observedAt) > 120000) throw new Error('Cotação com mais de dois minutos; aguarde uma atualização para usar o modo assistido');
    s.portfolio[id].lastPrice = quotes[id].price;
  }
  return s;
}
export function simulateOrder(previous, quotes, { asset, action, amount, quantity }, now = Date.now()) {
  if (!ASSETS.some(a => a.id === asset) || !activeIds(previous).includes(asset) || !['COMPRAR', 'VENDER'].includes(action)) throw new Error('Operação inválida');
  const s = mark(previous, quotes, now), p = s.portfolio[asset], price = quotes[asset].price;
  const before = { cash: s.cash, quantity: p.quantity, equity: equity(s), costBasis: p.costBasis ?? null };
  let fee, executionPrice, units, realizedPnl = null;
  if (action === 'COMPRAR') {
    if (s.paused) throw new Error('Inicie a simulação antes de comprar');
    const stop = stopReason(s, now); if (stop) throw new Error(stop);
    const exposure = equity(s) - s.cash;
    const cap = Math.min(s.cash, s.initialCapital * s.config.orderPct / 100, s.initialCapital * (s.config.allocations[asset] ?? 0) / 100 - p.quantity * price, s.initialCapital * s.config.exposurePct / 100 - exposure);
    const value = amount ?? cap;
    if (!Number.isFinite(value) || value < .01 || value > cap + 1e-9) throw new Error('Valor excede saldo, peso ou limite de entrada/exposição');
    executionPrice = price * 1.001; fee = value * .001; units = (value - fee) / executionPrice;
    s.cash -= value; p.costBasis = p.quantity === 0 ? value : p.costBasis == null ? null : p.costBasis + value; p.quantity += units;
    if (stopReason(s, now)) throw new Error('O custo da entrada ultrapassaria um limite de risco');
  } else {
    if (p.quantity <= 0 || quantity != null && quantity !== p.quantity) throw new Error('A posição mudou; atualize a proposta');
    units = p.quantity; executionPrice = price * .999; const gross = units * executionPrice; fee = gross * .001;
    if (p.costBasis != null) realizedPnl = gross - fee - p.costBasis;
    s.cash += gross - fee; p.quantity = 0; p.costBasis = 0;
    const stop = stopReason(s, now); if (stop) { s.paused = true; s.reason = stop; }
  }
  s.btc = s.portfolio.bitcoin?.quantity ?? 0; s.lastPrice = s.portfolio.bitcoin?.lastPrice ?? s.lastPrice;
  const after = { cash: s.cash, quantity: p.quantity, equity: equity(s), costBasis: p.costBasis ?? null };
  const scenarios = [-5, 0, 5].map(changePct => {
    const value = after.equity - p.quantity * price + p.quantity * price * (1 + changePct / 100) * .999 * .999;
    return { changePct, equityAfterExit: value, differenceVsBefore: value - before.equity };
  });
  return { state: s, asset, action, amount: before.cash - s.cash, quantity: units, fee, executionPrice, price, before, after, realizedPnl, scenarios, maxPriceDeviationPct: .2 };
}
export function proposal(previous, quotes, order, version, userId, now = Date.now()) {
  const { state, ...preview } = simulateOrder(previous, quotes, order, now);
  const p = { id: randomUUID(), userId, asset: order.asset, action: order.action, amount: order.action === 'COMPRAR' ? preview.amount : null, quantity: preview.quantity, price: preview.price, version, issuedAt: now, expiresAt: now + 60000 };
  const encoded = Buffer.from(JSON.stringify(p)).toString('base64url');
  return { ...preview, id: p.id, version, expiresAt: p.expiresAt, token: `${encoded}.${sign(encoded)}` };
}
export function confirmProposal(previous, quotes, token, version, userId, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('Proposta inválida');
  const parts = token.split('.'); if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw new Error('Proposta inválida');
  const expected = Buffer.from(sign(parts[0])), actual = Buffer.from(parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error('Proposta inválida');
  let p; try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { throw new Error('Proposta inválida'); }
  if (p.userId !== userId || p.version !== version) throw new Error('O estado mudou; solicite uma nova proposta');
  if (!Number.isFinite(p.issuedAt) || !Number.isFinite(p.expiresAt) || p.issuedAt > now + 5000 || now >= p.expiresAt || p.expiresAt - p.issuedAt !== 60000) throw new Error('Proposta vencida; consulte o mercado novamente');
  validateQuote(quotes[p.asset], now);
  if (Math.abs(quotes[p.asset].price / p.price - 1) > .002) throw new Error('O preço variou mais de 0,2%; solicite uma nova proposta');
  const result = simulateOrder(previous, quotes, p, now), s = result.state, at = new Date(now).toISOString();
  const technical = indicators([...(previous.portfolio[p.asset].observations ?? []), { at, price: quotes[p.asset].price }]);
  const event = { id: randomUUID(), proposalId: p.id, mode: 'assisted', asset: p.asset, at, action: p.action, reason: 'Operação simulada confirmada pelo usuário', quantity: result.quantity, fee: result.fee, executionPrice: result.executionPrice, price: result.price, equity: result.after.equity, realizedPnl: result.realizedPnl, before: result.before, after: result.after,
    parameters: { engine: 'assisted-v1', config: structuredClone(s.config), feeRate: .001, slippageRate: .001, acceptedPriceDeviationPct: .2 }, indicators: technical, quote: { ...quotes[p.asset], source: 'coingecko' }, approvedBy: userId };
  s.events = [...s.events, event].slice(-200);
  if (!s.paused) s.reason = 'Operação assistida registrada; estratégia automática continua habilitada';
  return { state: s, execution: event };
}
export function opportunities(state, quotes, now = Date.now()) {
  const snapshot = mark(state, quotes, now);
  return activeIds(state).map(asset => {
    const technical = indicators([...(state.portfolio[asset].observations ?? []), { at: new Date(now).toISOString(), price: quotes[asset].price }]);
    let action = 'AGUARDAR', reason = 'Sem oportunidade clara; você pode solicitar uma simulação manual dentro dos limites';
    if (snapshot.portfolio[asset].quantity > 0 && (stopReason(snapshot, now) || technical.rsi14 > 70 || technical.trendBps < -5)) { action = 'VENDER'; reason = 'Revisar saída ou redução de exposição; veja os custos antes de confirmar'; }
    else if (!snapshot.paused && technical.continuous && (technical.rsi14 < 35 || technical.trendBps > 5 && technical.rsi14 < 70)) {
      try { simulateOrder(state, quotes, { asset, action: 'COMPRAR' }, now); action = 'COMPRAR'; reason = technical.rsi14 < 35 ? 'RSI baixo: hipótese de recuperação, que pode falhar' : 'Movimento de alta de curto prazo; risco de reversão'; } catch { reason = 'Entrada indisponível pelos limites da carteira'; }
    }
    return { asset, price: quotes[asset].price, observedAt: quotes[asset].observedAt, action, reason, technical, hasPosition: snapshot.portfolio[asset].quantity > 0 };
  });
}
