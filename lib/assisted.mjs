import { isETF, fill, costs, etfBlock, dailyIndicators, releaseSettlement, settlementDate, localDate } from './markets.mjs';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { ASSETS, stopReason } from './portfolio.mjs';
import { equity, validateQuote } from './engine.mjs';
import { indicators } from './indicators.mjs';

const signingKey = () => { const k = process.env.SCHEDULER_SIGNING_KEY; if (!k || k.length < 32) throw new Error('Modo assistido ainda não configurado'); return k; };
const sign = s => createHmac('sha256', signingKey()).update(`trade-lab:assisted:${s}`).digest('base64url');
export const activeIds = s => [...new Set([...Object.keys(s.config?.allocations ?? {}), ...Object.keys(s.portfolio ?? {}).filter(id => s.portfolio[id].quantity > 0),...Object.keys(s.fast?.positions??{}).filter(id=>s.fast.positions[id].quantity>0)])];
function mark(previous, quotes, now) {
  if (!previous.config || !previous.portfolio) throw new Error('Configure a carteira primeiro');
  const s = structuredClone(previous);
  releaseSettlement(s, now);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (s.day !== today) { s.day = today; s.dayEquity = equity(s); }
  for (const id of activeIds(s)) {
    if (isETF(id)) { const q=quotes[id]; if(q && Number.isFinite(q.price) && q.price>0 && Date.parse(q.observedAt)<=now && now-Date.parse(q.observedAt)<7*86400000) s.portfolio[id].lastPrice=q.price; continue; }
    validateQuote(quotes[id], now);
    if (now - Date.parse(quotes[id].observedAt) > 120000) throw new Error('Cotação com mais de dois minutos; aguarde uma atualização para usar o modo assistido');
    s.portfolio[id].lastPrice = quotes[id].price;
    if(s.fast?.positions[id])s.fast.positions[id].lastPrice=quotes[id].price;
  }
  return s;
}
export function simulateOrder(previous, quotes, { asset, action, amount, quantity }, now = Date.now()) {
  if (!ASSETS.some(a => a.id === asset) || !activeIds(previous).includes(asset) || !['COMPRAR', 'VENDER'].includes(action)) throw new Error('Operação inválida');
  const s = mark(previous, quotes, now), p = s.portfolio[asset];
  const blocked = isETF(asset) ? etfBlock(quotes[asset],now) : null; if(blocked)throw Error(blocked);
  const price = quotes[asset].price;
  const before = { cash: s.cash, quantity: p.quantity, equity: equity(s), costBasis: p.costBasis ?? null };
  let fee, executionPrice, units, realizedPnl = null, estimatedTax=0, order;
  if (action === 'COMPRAR') {
    if (s.paused) throw new Error('Inicie a simulação antes de comprar');
    const stop = stopReason(s, now); if (stop) throw new Error(stop);
    const exposure = equity(s) - s.cash - (s.unsettled??[]).reduce((v,x)=>v+x.amount,0);
    const cap = Math.min(s.cash, s.initialCapital * s.config.orderPct / 100, s.initialCapital * (s.config.allocations[asset] ?? 0) / 100 - p.quantity * price - (s.fast?.positions[asset]?.quantity??0)*price, s.initialCapital * s.config.exposurePct / 100 - exposure);
    const value = amount ?? cap;
    if (!Number.isFinite(value) || value < .01 || value > cap + 1e-9) throw new Error('Valor excede saldo, peso ou limite de entrada/exposição');
    order=fill(asset,action,price,value,p,now);({executionPrice,fee,quantity:units}=order);if(units<=0)throw Error('Valor insuficiente para uma cota inteira do ETF');
    const debit=-order.cashChange;s.cash-=debit;p.costBasis=p.quantity===0?debit:p.costBasis==null?null:p.costBasis+debit;p.quantity+=units;p.acquiredDate=localDate(now);
    if (stopReason(s, now)) throw new Error('O custo da entrada ultrapassaria um limite de risco');
  } else {
    if (p.quantity <= 0 || quantity != null && quantity !== p.quantity) throw new Error('A posição mudou; atualize a proposta');
    order=fill(asset,action,price,0,p,now);({executionPrice,fee,quantity:units,realizedPnl,estimatedTax}=order);
    if(isETF(asset))s.unsettled.push({amount:order.cashChange,date:settlementDate(now),asset});else s.cash+=order.cashChange;p.quantity=0;p.costBasis=0;
    const stop = stopReason(s, now); if (stop) { s.paused = true; s.reason = stop; }
  }
  s.btc = s.portfolio.bitcoin?.quantity ?? 0; s.lastPrice = s.portfolio.bitcoin?.lastPrice ?? s.lastPrice;
  const after = { cash: s.cash, quantity: p.quantity, equity: equity(s), costBasis: p.costBasis ?? null };
  const scenarios = [-5, 0, 5].map(changePct => {
    const rates=costs(asset), gross=p.quantity*price*(1+changePct/100)*(1-rates.slippageRate)*(1-rates.feeRate);
    const tax=isETF(asset)?Math.max(0,gross-(p.costBasis??gross))*.20:0;
    const value = after.equity - p.quantity * price + gross-tax;
    return { changePct, equityAfterExit: value, differenceVsBefore: value - before.equity };
  });
  return { state: s, asset, action, amount: -order.cashChange, quantity: units, fee, estimatedTax, settlement: isETF(asset)&&action==='VENDER' ? settlementDate(now) : null, costs:costs(asset), executionPrice, price, before, after, realizedPnl, scenarios, maxPriceDeviationPct: .2 };
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
  if(isETF(p.asset)){const blocked=etfBlock(quotes[p.asset],now);if(blocked)throw Error(blocked);}else validateQuote(quotes[p.asset], now);
  if (Math.abs(quotes[p.asset].price / p.price - 1) > .002) throw new Error('O preço variou mais de 0,2%; solicite uma nova proposta');
  const result = simulateOrder(previous, quotes, p, now);
  if(isETF(p.asset)&&result.quantity!==p.quantity)throw Error('A quantidade de cotas mudou; solicite nova proposta');
  const s = result.state, at = new Date(now).toISOString();
  const technical = isETF(p.asset)?dailyIndicators(quotes[p.asset].history,now):indicators([...(previous.portfolio[p.asset].observations ?? []), { at, price: quotes[p.asset].price }]);
  const event = { id: randomUUID(), proposalId: p.id, mode: 'assisted', asset: p.asset, at, action: p.action, reason: 'Operação simulada confirmada pelo usuário', quantity: result.quantity, fee: result.fee, estimatedTax:result.estimatedTax, settlement:result.settlement, executionPrice: result.executionPrice, price: result.price, equity: result.after.equity, realizedPnl: result.realizedPnl, before: result.before, after: result.after,
    parameters: { engine: 'assisted-v1', config: structuredClone(s.config), ...costs(p.asset), acceptedPriceDeviationPct: .2 }, indicators: technical, quote: { ...quotes[p.asset], history:undefined, source: quotes[p.asset].source??'coingecko' }, approvedBy: userId };
  s.events = [...s.events, event].slice(-200);
  if (!s.paused) s.reason = 'Operação assistida registrada; estratégia automática continua habilitada';
  return { state: s, execution: event };
}
export function opportunities(state, quotes, now = Date.now()) {
  const snapshot = mark(state, quotes, now);
  return activeIds(state).map(asset => {
    const technical = isETF(asset)?dailyIndicators(quotes[asset]?.history,now):indicators([...(state.portfolio[asset].observations ?? []), { at: new Date(now).toISOString(), price: quotes[asset].price }]);
    const blocked=isETF(asset)?etfBlock(quotes[asset],now):null;
    if(blocked)return {asset,price:snapshot.portfolio[asset].lastPrice,observedAt:quotes[asset]?.observedAt??null,action:'AGUARDAR',reason:blocked,technical,hasPosition:snapshot.portfolio[asset].quantity>0};
    let action = 'AGUARDAR', reason;
    const stop = stopReason(snapshot, now);
    const rsi = technical.rsi14 == null ? 'indisponível' : technical.rsi14.toFixed(1);
    const trend = technical.trendBps == null ? 'indisponível' : `${(technical.trendBps / 100).toFixed(2)}%`;
    if (snapshot.portfolio[asset].quantity > 0 && (stop || technical.rsi14 > 70 || technical.trendBps < -5)) {
      action = 'VENDER';
      reason = stop ? `Limite de risco atingido: ${stop}.` : technical.rsi14 > 70 ? `RSI ${rsi} acima de 70: sinal de possível sobrecompra.` : `Média de 6 períodos abaixo da média de 24 períodos em ${trend}; saída sugerida abaixo de -0,05%.`;
      reason += ' Você possui uma posição neste ativo. A proposta vende a posição inteira; lucro não é garantido.';
    } else if (snapshot.paused) reason = 'Simulação pausada: sugestões de compra desabilitadas. Retome para avaliar entradas.';
    else if (!technical.continuous) reason = 'Janela de 24 observações horárias incompleta ou com lacunas; sem sinal de compra confiável nesta regra. A prévia manual continua disponível dentro dos limites.';
    else if (technical.rsi14 < 35 || technical.trendBps > 5 && technical.rsi14 < 70) {
      try { simulateOrder(state, quotes, { asset, action: 'COMPRAR' }, now); action = 'COMPRAR'; reason = technical.rsi14 < 35 ? `RSI ${rsi} abaixo de 35: hipótese de recuperação, que pode falhar.` : `Média de 6h acima da média de 24h em ${trend}, com RSI ${rsi}: hipótese de continuidade, sujeita a reversão.`; }
      catch (error) { reason = `Entrada bloqueada: ${error.message}.`; }
    } else reason = `Sem sinal de compra nesta regra: RSI ${rsi}; diferença entre médias de 6 e 24 períodos ${trend}. Compra sugerida com RSI abaixo de 35, ou diferença acima de 0,05% e RSI abaixo de 70. Você pode solicitar uma prévia manual.`;
    return { asset, price: quotes[asset].price, observedAt: quotes[asset].observedAt, action, reason, technical, hasPosition: snapshot.portfolio[asset].quantity > 0 };
  });
}
