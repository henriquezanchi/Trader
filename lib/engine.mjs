export const LIMITS = Object.freeze({ order: 20, fee: 0.001, slippage: 0.001, dailyLoss: 3, totalLoss: 10 });
export const initialState = (capital = 1000) => ({ initialCapital: capital, cash: capital, btc: 0, paused: false, reason: 'Aguardando primeira cotação', lastPrice: null, lastTick: null, day: null, dayEquity: capital, observations: [], events: [] });
export function validateQuote(quote, now = Date.now()) {
  if (!Number.isFinite(quote?.price) || quote.price <= 0 || quote.price > 1e9) throw new Error('Cotação inválida');
  const age = now - Date.parse(quote.observedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 600000) throw new Error('Cotação ausente, antiga ou no futuro');
}
export const equity = (s, price = s.lastPrice) => s.cash + s.btc * (price ?? 0);
const mean = a => a.reduce((sum, x) => sum + x, 0) / a.length;
export function step(previous, quote, now = Date.now()) {
  validateQuote(quote, now);
  const s = structuredClone(previous);
  const slot = new Date(now).toISOString().slice(0, 13);
  if (s.lastTick && slot <= s.lastTick) return { state: s, duplicate: true };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  // A referência diária usa a última avaliação conhecida, antes da nova cotação.
  if (s.day !== day) { s.day = day; s.dayEquity = equity(s); }
  s.lastTick = slot;
  s.lastPrice = quote.price;
  s.observations = [...s.observations, { at: new Date(now).toISOString(), price: quote.price, observedAt: quote.observedAt }].slice(-72);
  let action = 'AGUARDAR', quantity = 0, fee = 0, executionPrice = quote.price;
  const totalHit = equity(s) <= s.initialCapital - LIMITS.totalLoss;
  const dailyHit = equity(s) <= s.dayEquity - LIMITS.dailyLoss;
  let reason;
  // Ao atingir limite, liquidar a posição virtual e travar novas compras.
  if (totalHit || dailyHit) {
    s.paused = true;
    reason = totalHit ? 'Limite total de perda atingido' : 'Limite diário de perda atingido';
    if (s.btc > 0) action = 'VENDER';
  } else if (s.paused) reason = 'Pausado pelo usuário ou limite de risco';
  else {
    const recent = s.observations.slice(-24);
    const contiguous = recent.length === 24 && recent.every((x, i) => !i || Date.parse(x.at) - Date.parse(recent[i - 1].at) <= 90 * 60000);
    if (!contiguous) reason = 'Aquecimento: precisa de 24 observações horárias consecutivas';
    else {
      const fast = mean(recent.slice(-6).map(x => x.price));
      const slow = mean(recent.map(x => x.price));
      if (fast > slow * 1.002 && s.btc === 0 && s.cash >= LIMITS.order) {
        action = 'COMPRAR'; reason = 'Média de 6h acima da média de 24h em mais de 0,2%';
      } else if (fast < slow * 0.998 && s.btc > 0) {
        action = 'VENDER'; reason = 'Média de 6h abaixo da média de 24h em mais de 0,2%';
      } else reason = 'Sem sinal novo; manter posição';
    }
  }
  if (action === 'COMPRAR') {
    executionPrice *= 1 + LIMITS.slippage;
    fee = LIMITS.order * LIMITS.fee;
    quantity = (LIMITS.order - fee) / executionPrice;
    s.cash -= LIMITS.order;
    s.btc += quantity;
  } else if (action === 'VENDER') {
    executionPrice *= 1 - LIMITS.slippage;
    quantity = s.btc;
    const gross = quantity * executionPrice;
    fee = gross * LIMITS.fee;
    s.cash += gross - fee;
    s.btc = 0;
  }
  s.reason = reason;
  s.events = [...s.events, { at: new Date(now).toISOString(), action, reason, quantity, fee, executionPrice, price: quote.price, equity: equity(s) }].slice(-200);
  return { state: s, duplicate: false };
}
