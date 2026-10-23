import { validateQuote, equity } from './engine.mjs';
import { randomUUID } from 'node:crypto';
import { indicators as technicalIndicators } from './indicators.mjs';

export const ASSETS = Object.freeze([
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', risk: 'Alto', potential: 'Volatilidade elevada; sem previsão de retorno' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', risk: 'Muito alto', potential: 'Maior incerteza tecnológica e de mercado' },
  { id: 'solana', symbol: 'SOL', name: 'Solana', risk: 'Muito alto', potential: 'Oscilações intensas, com risco de grandes perdas' },
]);
export const PROFILES = Object.freeze({
  conservador: { label: 'Conservador relativo a cripto', allocations: { bitcoin: 6, ethereum: 4 }, exposurePct: 10, orderPct: 5, dailyLossPct: 0.5, totalLossPct: 2, targetPct: 2, days: 90 },
  moderado: { label: 'Moderado relativo a cripto', allocations: { bitcoin: 15, ethereum: 8, solana: 2 }, exposurePct: 25, orderPct: 10, dailyLossPct: 1, totalLossPct: 5, targetPct: 5, days: 90 },
  agressivo: { label: 'Arrojado / agressivo', allocations: { bitcoin: 25, ethereum: 15, solana: 10 }, exposurePct: 50, orderPct: 20, dailyLossPct: 2, totalLossPct: 10, targetPct: 10, days: 90 },
});
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(PROFILES, input.profile)) throw new Error('Perfil inválido');
  const c = { profile: input.profile, allocations: {} };
  for (const [key, min, max] of [['exposurePct', 0.1, 100], ['orderPct', 0.1, 100], ['dailyLossPct', 0.1, 50], ['totalLossPct', 0.1, 100], ['targetPct', 0.1, 1000], ['days', 1, 365]]) {
    const v = input[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (key === 'days' && !Number.isInteger(v))) throw new Error(`Parâmetro inválido: ${key}`);
    c[key] = v;
  }
  if (c.orderPct > c.exposurePct || c.dailyLossPct > c.totalLossPct) throw new Error('Entrada excede exposição ou perda diária excede perda total');
  if (!input.allocations || typeof input.allocations !== 'object' || Array.isArray(input.allocations)) throw new Error('Selecione os ativos');
  for (const [id, pct] of Object.entries(input.allocations)) {
    if (!ASSETS.some(a => a.id === id) || typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error('Ativo ou peso inválido');
    c.allocations[id] = pct;
  }
  const sum = Object.values(c.allocations).reduce((a, b) => a + b, 0);
  if (!sum || sum > c.exposurePct + 1e-9) throw new Error('A soma dos pesos deve ser positiva e não exceder a exposição máxima');
  return c;
}

export function configurePortfolio(previous, input) {
  if (!previous.paused) throw new Error('Pause a simulação antes de alterar a carteira');
  const config = validateConfig(input);
  const s = structuredClone(previous);
  if (!s.portfolio) {
    s.portfolio = { bitcoin: { quantity: s.btc, lastPrice: s.lastPrice, observations: s.observations } };
  }
  for (const [id, holding] of Object.entries(s.portfolio)) {
    if (!Object.hasOwn(config.allocations, id) && holding.quantity > 0) throw new Error('Não remova um ativo com posição aberta; encerre a posição virtual primeiro');
  }
  for (const id of Object.keys(config.allocations)) s.portfolio[id] ??= { quantity: 0, lastPrice: null, observations: [] };
  s.config = config;
  s.reason = 'Carteira configurada; inicie a simulação quando estiver pronto';
  return s;
}

export function stopReason(s, now = Date.now()) {
  const c = s.config, value = equity(s), base = s.initialCapital;
  if (value <= base * (1 - c.totalLossPct / 100)) return 'Limite total de perda atingido';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (s.day === today && s.dayEquity != null && value <= s.dayEquity - base * c.dailyLossPct / 100) return 'Limite diário de perda atingido';
  if (value >= base * (1 + c.targetPct / 100)) return 'Meta de ganho atingida';
  if (s.startedAt && now >= Date.parse(s.startedAt) + c.days * 86400000) return 'Prazo de avaliação encerrado';
  return null;
}

export function portfolioStep(previous, quotes, now = Date.now(), policy = { id: 'baseline' }) {
  if (!['baseline', 'rsi-confirmed', 'learned'].includes(policy.id)) throw new Error('Estratégia experimental inválida');
  const s = structuredClone(previous), c = validateConfig(s.config);
  if (!(s.initialCapital > 0) || !Number.isFinite(s.initialCapital)) throw new Error('Capital inicial inválido');
  const ids = [...new Set([...Object.keys(c.allocations), ...Object.keys(s.portfolio).filter(id => s.portfolio[id].quantity > 0)])];
  for (const id of ids) validateQuote(quotes[id], now);
  const slot = new Date(now).toISOString().slice(0, 13);
  if (s.lastTick && slot <= s.lastTick) return { state: s, duplicate: true };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (s.day !== day) { s.day = day; s.dayEquity = equity(s); }
  s.lastTick = slot;
  for (const id of ids) {
    const p = s.portfolio[id], q = quotes[id];
    p.lastPrice = q.price;
    p.observations = [...p.observations, { at: new Date(now).toISOString(), ...q }].slice(-72);
  }
  let stop = stopReason(s, now);
  if (stop) { s.paused = true; s.reason = stop; }
  const decisions = [];
  function trade(id, action, reason, amount = 0) {
    const p = s.portfolio[id], price = p.lastPrice;
    const recent = p.observations.slice(-24);
    const mean = a => a.length ? a.reduce((sum, x) => sum + x.price, 0) / a.length : null;
    const indicators = { fastMean: mean(recent.slice(-6)), slowMean: mean(recent), samples: recent.length,
      continuous: recent.length === 24 && recent.every((x, i) => !i || Date.parse(x.at) - Date.parse(recent[i - 1].at) <= 90 * 60000) };
    Object.assign(indicators, technicalIndicators(p.observations));
    const before = { cash: s.cash, quantity: p.quantity, equity: equity(s), costBasis: p.costBasis ?? null };
    let quantity = 0, fee = 0, realizedPnl = null;
    const executionPrice = price * (action === 'COMPRAR' ? 1.001 : action === 'VENDER' ? .999 : 1);
    if (action === 'COMPRAR') {
      fee = amount * .001; quantity = (amount - fee) / executionPrice;
      s.cash -= amount; p.quantity += quantity; p.costBasis = amount;
    } else if (action === 'VENDER') {
      quantity = p.quantity; const gross = quantity * executionPrice;
      if (p.costBasis != null) realizedPnl = gross * .999 - p.costBasis;
      fee = gross * .001; s.cash += gross - fee; p.quantity = 0; p.costBasis = 0;
    }
    decisions.push({ id: randomUUID(), at: new Date(now).toISOString(), asset: id, action, reason, quantity, fee, executionPrice, price, realizedPnl,
      parameters: { engine: policy.id === 'baseline' ? 'moving-average-6-24-v2' : `shadow-${policy.id}-v1`, config: structuredClone(c), feeRate: .001, slippageRate: .001, signalThreshold: .002, forecast: policy.predictions?.[id] ?? null },
      indicators, quote: { ...quotes[id], source: 'coingecko' }, before,
      after: { cash: s.cash, quantity: p.quantity, equity: equity(s), costBasis: p.costBasis ?? null },
      risk: { initialCapital: s.initialCapital, dayEquity: s.dayEquity, stop, paused: s.paused } });
  }
  // Sell before buying so allocation is deterministic and cash is never overdrawn.
  const buy = [];
  for (const id of ids) {
    const p = s.portfolio[id], recent = p.observations.slice(-24);
    if (stop) trade(id, p.quantity > 0 ? 'VENDER' : 'AGUARDAR', stop);
    else if (s.paused) trade(id, 'AGUARDAR', 'Pausado; posição continua exposta');
    else if (recent.length < 24 || recent.some((x, i) => i && Date.parse(x.at) - Date.parse(recent[i - 1].at) > 90 * 60000)) trade(id, 'AGUARDAR', 'Aquecimento: 24 observações horárias consecutivas');
    else {
      const mean = a => a.reduce((sum, x) => sum + x.price, 0) / a.length;
      const ratio = mean(recent.slice(-6)) / mean(recent);
      const rsi = technicalIndicators(p.observations).rsi14;
      const forecast = policy.predictions?.[id];
      const enter = policy.id === 'learned' ? forecast?.ready && forecast.probability > .6 : ratio > 1.002 && (policy.id !== 'rsi-confirmed' || rsi > 45 && rsi < 68);
      const exit = policy.id === 'learned' ? forecast?.ready && forecast.probability < .4 : ratio < .998 || policy.id === 'rsi-confirmed' && rsi > 75;
      if (exit && p.quantity > 0) trade(id, 'VENDER', policy.id === 'baseline' ? 'Média curta abaixo da longa' : 'Sinal de saída da estratégia experimental');
      else if (enter && p.quantity === 0) buy.push(id);
      else if (policy.id === 'learned' && !forecast?.ready) trade(id, 'AGUARDAR', 'Modelo experimental ainda sem 100 resultados de 6h para liberar entradas');
      else trade(id, 'AGUARDAR', 'Sem novo sinal');
    }
  }
  for (const id of buy) {
    const exposure = Object.values(s.portfolio).reduce((sum, p) => sum + p.quantity * (p.lastPrice ?? 0), 0);
    const amount = Math.min(s.cash, s.initialCapital * c.orderPct / 100, s.initialCapital * (c.allocations[id] ?? 0) / 100, s.initialCapital * c.exposurePct / 100 - exposure);
    if (amount >= .01) trade(id, 'COMPRAR', policy.id === 'baseline' ? 'Tendência de alta; entrada limitada ao peso e exposição' : 'Entrada experimental limitada ao mesmo perfil de risco', amount);
    else trade(id, 'AGUARDAR', 'Sem saldo ou exposição disponível');
  }
  // Costs can themselves cross a loss threshold; enforce again in this cycle.
  if (!stop && (stop = stopReason(s, now))) {
    s.paused = true; s.reason = stop;
    for (const id of ids) if (s.portfolio[id].quantity > 0) trade(id, 'VENDER', stop);
  }
  if (!stop) s.reason = s.paused ? 'Pausado pelo usuário; limites continuam ativos' : 'Ciclo multiativo concluído';
  s.btc = s.portfolio.bitcoin?.quantity ?? 0;
  s.lastPrice = s.portfolio.bitcoin?.lastPrice ?? s.lastPrice;
  s.observations = s.portfolio.bitcoin?.observations ?? s.observations;
  const value = equity(s);
  s.events = [...s.events, ...decisions.map(d => ({ ...d, equity: value }))].slice(-200);
  return { state: s, duplicate: false };
}
