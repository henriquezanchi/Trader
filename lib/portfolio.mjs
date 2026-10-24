import { isETF, costs, fill, etfBlock, dailyIndicators, releaseSettlement, settlementDate, localDate } from './markets.mjs';
import { validateQuote, equity } from './engine.mjs';
import { randomUUID } from 'node:crypto';
import { indicators as technicalIndicators } from './indicators.mjs';

export const ASSETS = Object.freeze([
  { id: 'bova11', symbol: 'BOVA11', name: 'ETF Ibovespa', market:'b3', risk:'Alto', potential:'Ações brasileiras; cotas inteiras; sujeito a perdas' },
  { id: 'ivvb11', symbol: 'IVVB11', name: 'ETF S&P 500 em reais', market:'b3', risk:'Alto', potential:'Ações dos EUA e variação cambial; cotas inteiras' },
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', risk: 'Alto', potential: 'Volatilidade elevada; sem previsão de retorno' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', risk: 'Muito alto', potential: 'Maior incerteza tecnológica e de mercado' },
  { id: 'solana', symbol: 'SOL', name: 'Solana', risk: 'Muito alto', potential: 'Oscilações intensas, com risco de grandes perdas' },
]);
export const PROFILES = Object.freeze({
  'diversificado-conservador': {label:'Menor exposição · experimental',allocations:{bova11:10},exposurePct:10,orderPct:10,dailyLossPct:.5,totalLossPct:3,targetPct:3,days:90},
  'diversificado-moderado': {label:'Diversificado moderado · experimental',allocations:{bova11:20,ivvb11:45,bitcoin:5,ethereum:3,solana:2},exposurePct:75,orderPct:45,dailyLossPct:1,totalLossPct:5,targetPct:5,days:90},
  'diversificado-agressivo': {label:'Diversificado arrojado · experimental',allocations:{bova11:20,ivvb11:50,bitcoin:15,ethereum:10,solana:5},exposurePct:100,orderPct:50,dailyLossPct:2,totalLossPct:10,targetPct:10,days:90},
  conservador: { label: 'Conservador relativo a cripto', allocations: { bitcoin: 6, ethereum: 4 }, exposurePct: 10, orderPct: 5, dailyLossPct: 0.5, totalLossPct: 2, targetPct: 2, days: 90 },
  moderado: { label: 'Moderado relativo a cripto', allocations: { bitcoin: 15, ethereum: 8, solana: 2 }, exposurePct: 25, orderPct: 10, dailyLossPct: 1, totalLossPct: 5, targetPct: 5, days: 90 },
  agressivo: { label: 'Arrojado / agressivo', allocations: { bitcoin: 25, ethereum: 15, solana: 10 }, exposurePct: 50, orderPct: 20, dailyLossPct: 2, totalLossPct: 10, targetPct: 10, days: 90 },
});
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(PROFILES, input.profile)) throw new Error('Perfil inválido');
  const cryptoStrategy=input.cryptoStrategy??'trend';
  if(!['trend','rsi-recovery','dca-weekly'].includes(cryptoStrategy))throw Error('Estratégia inválida');
  const c = { profile: input.profile, cryptoStrategy, allocations: {} };
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
  for (const id of ids) if (!isETF(id)) validateQuote(quotes[id], now);
  releaseSettlement(s, now);
  const slot = new Date(now).toISOString().slice(0, 13);
  if (s.lastTick && slot <= s.lastTick) return { state: s, duplicate: true };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (s.day !== day) { s.day = day; s.dayEquity = equity(s); }
  s.lastTick = slot;
  for (const id of ids) {
    const p = s.portfolio[id], q = quotes[id];
    if (isETF(id)) { if(q && Number.isFinite(q.price) && q.price > 0 && Date.parse(q.observedAt)<=now && now-Date.parse(q.observedAt)<7*86400000) { p.lastPrice=q.price; p.dailyHistory=q.history; } continue; }
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
    Object.assign(indicators, isETF(id) ? dailyIndicators(quotes[id]?.history, now) : technicalIndicators(p.observations));
    const before = { cash: s.cash, quantity: p.quantity, equity: equity(s), costBasis: p.costBasis ?? null };
    let quantity = 0, fee = 0, realizedPnl = null, estimatedTax = 0, executionPrice = price;
    const rates = costs(id);
    if (action !== 'AGUARDAR') {
      const order = fill(id, action, price, amount, p, now);
      ({quantity,fee,realizedPnl,estimatedTax,executionPrice}=order);
      if (action === 'COMPRAR') {
        if(quantity<=0){action='AGUARDAR';reason='Saldo ou limite insuficiente para uma cota inteira';}
        else {s.cash+=order.cashChange;p.costBasis=p.quantity===0?-order.cashChange:p.costBasis==null?null:p.costBasis-order.cashChange;p.quantity+=quantity;if(c.cryptoStrategy==='dca-weekly'&&id==='bitcoin')p.lastDcaAt=new Date(now).toISOString();p.acquiredDate=localDate(now);}
      } else {
        if(isETF(id))s.unsettled.push({amount:order.cashChange,date:settlementDate(now),asset:id});else s.cash+=order.cashChange;
        p.quantity=0;p.costBasis=0;
      }
    }
    decisions.push({ id: randomUUID(), at: new Date(now).toISOString(), asset: id, action, reason, quantity, fee, executionPrice, price, realizedPnl, estimatedTax,
      parameters: { engine: policy.id === 'baseline' ? isETF(id)?'etf-daily-6-24-v1':c.cryptoStrategy==='dca-weekly'?'btc-weekly-dca-v1':c.cryptoStrategy==='rsi-recovery'?'rsi-recovery-v1':'moving-average-6-24-v2' : `shadow-${policy.id}-v1`, config: structuredClone(c), ...rates, timeframe: isETF(id) ? 'daily' : 'hourly', settlement: isETF(id) ? 'D+2' : 'immediate', signalThreshold: .002, forecast: policy.predictions?.[id] ?? null },
      indicators, quote: { ...quotes[id], history: undefined, source: quotes[id]?.source ?? 'coingecko' }, before,
      after: { cash: s.cash, quantity: p.quantity, equity: equity(s), costBasis: p.costBasis ?? null },
      risk: { initialCapital: s.initialCapital, dayEquity: s.dayEquity, stop, paused: s.paused } });
  }
  // Sell before buying so allocation is deterministic and cash is never overdrawn.
  const buy = [];
  for (const id of ids) {
    const p = s.portfolio[id], recent = p.observations.slice(-24);
    const blocked = isETF(id) ? etfBlock(quotes[id], now) : null;
    const technical = isETF(id) ? dailyIndicators(quotes[id]?.history, now) : technicalIndicators(p.observations);
    if (blocked) trade(id, 'AGUARDAR', `${blocked}${stop ? '; saída por limite pendente de mercado disponível' : ''}`);
    else if (stop) trade(id, p.quantity > 0 ? 'VENDER' : 'AGUARDAR', stop);
    else if (s.paused) trade(id, 'AGUARDAR', 'Pausado; posição continua exposta');
    else if (!isETF(id) && policy.id==='baseline' && c.cryptoStrategy==='dca-weekly') {
      if(id!=='bitcoin')trade(id,'AGUARDAR','DCA semanal compra somente BTC; outros ativos ficam sem novas entradas por esta estratégia');
      else if(p.lastDcaAt && now-Date.parse(p.lastDcaAt)<7*86400000)trade(id,'AGUARDAR',`DCA: próximo aporte a partir de ${new Date(Date.parse(p.lastDcaAt)+7*86400000).toISOString()}`);
      else buy.push(id);
    }
    else if (!technical.continuous) trade(id, 'AGUARDAR', isETF(id) ? 'Histórico insuficiente: 24 pregões concluídos' : 'Aquecimento: 24 observações horárias consecutivas');
    else {
      const mean = a => a.reduce((sum, x) => sum + x.price, 0) / a.length;
      const ratio = technical.fastMean / technical.slowMean;
      const rsi = technical.rsi14;
      const forecast = policy.predictions?.[id];
      const priorRSI=technicalIndicators(previous.portfolio[id]?.observations??[]).rsi14;
      const recovery=policy.id==='baseline'&&!isETF(id)&&c.cryptoStrategy==='rsi-recovery';
      const enter = recovery ? priorRSI!=null&&priorRSI<30&&rsi>=30&&p.observations.at(-1).price>p.observations.at(-2).price : policy.id === 'learned' ? forecast?.ready && forecast.probability > .6 : ratio > 1.002 && (policy.id !== 'rsi-confirmed' || rsi > 45 && rsi < 68);
      const exit = recovery ? rsi>70 || rsi<25 : policy.id === 'learned' ? forecast?.ready && forecast.probability < .4 : ratio < .998 || policy.id === 'rsi-confirmed' && rsi > 75;
      if (exit && p.quantity > 0) trade(id, 'VENDER', recovery ? `Saída RSI: ${rsi.toFixed(1)} fora da faixa de permanência 25–70` : policy.id === 'baseline' ? 'Média curta abaixo da longa' : 'Sinal de saída da estratégia experimental');
      else if (enter && p.quantity === 0) buy.push(id);
      else if (policy.id === 'learned' && !forecast?.ready) trade(id, 'AGUARDAR', 'Modelo experimental ainda sem 100 resultados de 6h para liberar entradas');
      else if(recovery)trade(id,'AGUARDAR',`RSI de recuperação: anterior ${priorRSI?.toFixed(1)??'indisponível'}, atual ${rsi?.toFixed(1)??'indisponível'}. Entrada exige cruzar 30 para cima com preço reagindo; saída acima de 70 ou abaixo de 25. Custos e limites continuam ativos.`);
      else trade(id, 'AGUARDAR', `Sem novo sinal: média de 6 ${isETF(id)?'pregões':'horas'} ${((ratio-1)*100).toFixed(2)}% em relação à média de 24; compra exige acima de +0,20%, saída abaixo de -0,20%. ${p.quantity>0?'Já existe posição neste ativo.':'Sem posição aberta.'}`);
    }
  }
  for (const id of buy) {
    const exposure = Object.values(s.portfolio).reduce((sum, p) => sum + p.quantity * (p.lastPrice ?? 0), 0);
    const amount = Math.min(s.cash, s.initialCapital * c.orderPct / 100, s.initialCapital * (c.allocations[id] ?? 0) / 100 - s.portfolio[id].quantity * s.portfolio[id].lastPrice, c.cryptoStrategy==='dca-weekly'&&id==='bitcoin' ? s.initialCapital*.01 : Infinity, c.cryptoStrategy==='dca-weekly'&&id==='bitcoin' ? s.initialCapital*.05-s.portfolio[id].quantity*s.portfolio[id].lastPrice : Infinity, s.initialCapital * c.exposurePct / 100 - exposure);
    if (amount >= .01) trade(id, 'COMPRAR', policy.id === 'baseline' ? !isETF(id)&&c.cryptoStrategy==='dca-weekly'?'DCA semanal: até 1% do capital por aporte, teto agregado de 5% em BTC':!isETF(id)&&c.cryptoStrategy==='rsi-recovery'?'RSI cruzou 30 para cima com reação de preço; hipótese de recuperação':'Tendência de alta; entrada limitada ao peso e exposição' : 'Entrada experimental limitada ao mesmo perfil de risco', amount);
    else trade(id, 'AGUARDAR', 'Sem saldo ou exposição disponível');
  }
  // Costs can themselves cross a loss threshold; enforce again in this cycle.
  if (!stop && (stop = stopReason(s, now))) {
    s.paused = true; s.reason = stop;
    for (const id of ids) if (s.portfolio[id].quantity > 0 && (!isETF(id) || !etfBlock(quotes[id], now))) trade(id, 'VENDER', stop);
  }
  if (!stop) s.reason = s.paused ? 'Pausado pelo usuário; limites continuam ativos' : 'Ciclo multiativo concluído';
  s.btc = s.portfolio.bitcoin?.quantity ?? 0;
  s.lastPrice = s.portfolio.bitcoin?.lastPrice ?? s.lastPrice;
  s.observations = s.portfolio.bitcoin?.observations ?? s.observations;
  const value = equity(s);
  s.events = [...s.events, ...decisions.map(d => ({ ...d, equity: value }))].slice(-200);
  return { state: s, duplicate: false };
}
