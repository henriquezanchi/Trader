import { isETF } from './markets.mjs';
import { createHash } from 'node:crypto';
import { indicators, featureVector, FEATURE_NAMES } from './indicators.mjs';
import { collectNews, newsFor } from './news.mjs';
import { portfolioStep } from './portfolio.mjs';
import { equity, validateQuote } from './engine.mjs';

export const HORIZONS = [1, 6, 24];
export const MODEL_VERSION = 'online-logistic-v1';
const emptyModel = () => ({ weights: FEATURE_NAMES.map(() => 0), trained: 0, scored: 0, brierSum: 0, correct: 0, netReturnSum: 0, missed: 0 });
export function probability(model, vector) {
  const z = Math.max(-20, Math.min(20, vector.reduce((sum, x, i) => sum + x * (model.weights[i] ?? 0), 0)));
  return 1 / (1 + Math.exp(-z));
}
export function updateModel(model, sample, netReturnPct) {
  const y = netReturnPct > 0 ? 1 : 0;
  model.scored++; model.brierSum += (sample.probability - y) ** 2; model.correct += Number((sample.probability >= .5 ? 1 : 0) === y); model.netReturnSum += netReturnPct;
  const fitted = probability(model, sample.vector);
  model.weights = model.weights.map((w, i) => Math.max(-5, Math.min(5, w + .03 * ((y - fitted) * sample.vector[i] - .001 * w))));
  model.trained++;
}
const iso = now => new Date(now).toISOString();
const SHADOWS=['baseline','rsi-confirmed','learned','dca-weekly','rsi-recovery'];
const hashConfig = c => createHash('sha256').update(JSON.stringify({ comparisonVersion:2, ...c, allocations: Object.fromEntries(Object.entries(c.allocations).sort()) })).digest('hex').slice(0, 16);

function freshShadow(state, frame, now) {
  const portfolio = Object.fromEntries(Object.keys(state.config.allocations).map(id => [id, { quantity: 0, costBasis: 0, lastPrice: frame[id].price,
    observations: frame[id].observations.slice(0, -1).map(o => ({ ...o })) }]));
  return { initialCapital: 1000, cash: 1000, btc: 0, lastPrice: null, observations: [], events: [], portfolio,
    config: structuredClone(state.config), paused: false, startedAt: iso(now), reason: 'Pesquisa paralela em unidades normalizadas', lastTick: null, day: null, dayEquity: 1000 };
}

export function advanceResearch(previous, state, quotes, news, now = Date.now()) {
  const slot = iso(now).slice(0, 13);
  if (previous?.lastSlot && slot <= previous.lastSlot) return { research: previous, delta: null };
  const r = previous ? structuredClone(previous) : { version: MODEL_VERSION, models: Object.fromEntries(HORIZONS.map(h => [h, emptyModel()])), pending: [], recentCohorts: [] };
  r.directionModels??=Object.fromEntries(HORIZONS.map(h=>[h,emptyModel()]));r.directionByAsset??={};r.directionFlat??={};
  const frame = {}, features = {};
  for (const id of Object.keys(state.config.allocations).filter(id=>!isETF(id))) {
    validateQuote(quotes[id], now);
    const observations = [...(state.portfolio[id]?.observations ?? []).filter(o => o.historical || o.at.slice(0, 13) !== slot), { at: iso(now), ...quotes[id] }].slice(-72);
    frame[id] = { ...quotes[id], observations };
    const technical = indicators(observations), context = newsFor(id, news, now);
    features[id] = { technical, news: context, volume24h: quotes[id].volume24h ?? null, vector: featureVector(id, technical, context, quotes[id].volume24h) };
  }
  const outcomes = [], waiting = [];
  // Score the probability saved at prediction time, BEFORE training on this outcome.
  for (const p of r.pending) {
    if (Date.parse(p.targetAt) > now) { waiting.push(p); continue; }
    const candidates = (frame[p.asset]?.observations ?? []).filter(o => {
      const time = Date.parse(o.observedAt ?? o.at);
      return Date.parse(o.at)<=now&&time<=now&&time>Date.parse(p.priceAt)&&time>=Date.parse(p.targetAt)&&time<=Date.parse(p.targetAt)+5*60000&&(o.source??'coingecko')===(p.source??'coingecko');
    }).sort((a, b) => Math.abs(Date.parse(a.observedAt ?? a.at) - Date.parse(p.targetAt)) - Math.abs(Date.parse(b.observedAt ?? b.at) - Date.parse(p.targetAt)));
    const end = candidates[0];
    if (!end) {
      if (now <= Date.parse(p.targetAt) + 10 * 60000) waiting.push(p);
      else { r.models[p.horizon].missed++; outcomes.push({ id: p.id, asset: p.asset, horizon: p.horizon, status: 'missing-price', targetAt: p.targetAt }); }
      continue;
    }
    const netReturnPct = (end.price / p.price * .999 * .999 * .999 / 1.001 - 1) * 100;
    outcomes.push({ id: p.id, asset: p.asset, horizon: p.horizon, status: 'scored', predictionAt: p.knownAt, targetAt: p.targetAt,
      observedAt: end.observedAt ?? end.at, actualHours: (Date.parse(end.observedAt ?? end.at) - Date.parse(p.priceAt)) / 3600000,
      probability: p.probability, netReturnPct, positive: netReturnPct > 0, newsIds: p.newsIds });
    updateModel(r.models[p.horizon], p, netReturnPct);
    if(Number.isFinite(p.directionProbability)){
      const rawReturnPct=(end.price/p.price-1)*100;
      const d={probability:p.directionProbability,predicted:p.directionProbability>=.5?'SUBIR':'DESCER',actual:rawReturnPct===0?'ESTÁVEL':rawReturnPct>0?'SUBIU':'DESCEU',rawReturnPct,correct:rawReturnPct===0?null:(p.directionProbability>=.5)===(rawReturnPct>0),modelVersion:p.directionModelVersion};
      outcomes.at(-1).direction=d;
      if(rawReturnPct===0)r.directionFlat[p.horizon]=(r.directionFlat[p.horizon]??0)+1;
      // Legacy directional fields remain diagnostic; audited primary cohorts own directional training.
    }

  }
  const forecasts = {}, newSamples = [];
  for (const [asset, f] of Object.entries(features)) {
    forecasts[asset] = {};
    if (!f.technical.continuous) continue;
    for (const h of HORIZONS) {
      const m = r.models[h], predicted = probability(m, f.vector);
      const directional=r.directionByAsset[asset]?.[h]??r.directionModels[h],directionVector=featureVector(asset,f.technical,{available:false,count:0,score:0},null),directionProbability=probability(directional,directionVector);
      forecasts[asset][h] = { probability: predicted, ready: m.trained >= 100, trained: m.trained, model: MODEL_VERSION,directionProbability,directionTrained:directional.trained };

      const sample = { id: `${slot}:${asset}:${h}`, asset, horizon: h, knownAt: iso(now), priceAt: quotes[asset].observedAt,
        targetAt: iso(now + h * 3600000), source:quotes[asset].source??'coingecko', price: quotes[asset].price,
        probability: predicted, vector: f.vector, trainedAtPrediction: m.trained, newsIds: f.news.ids };
      newSamples.push(sample);
    }
  }
  const shadowConfig={...state.config,cryptoStrategy:'trend',allocations:Object.fromEntries(Object.entries(state.config.allocations).filter(([id])=>!isETF(id)))};
  const configKey = hashConfig(state.config);
  if (!r.cohort || r.cohort.configKey !== configKey) {
    if (r.cohort) r.recentCohorts = [...r.recentCohorts, { id: r.cohort.id, startedAt: r.cohort.startedAt, endedAt: iso(now), summaries: r.cohort.summaries }].slice(-5);
    r.cohort = { id: `${slot}:${configKey}`, configKey, startedAt: iso(now), cycles: 0, config: structuredClone(state.config),
      shadows: Object.fromEntries(SHADOWS.map(id => [id, freshShadow({...state,config:{...shadowConfig,cryptoStrategy:['dca-weekly','rsi-recovery'].includes(id)?id:'trend'}}, frame, now)])), peaks: {}, drawdowns: {}, trades: {} };
    r.cohort.benchmarkEntries = Object.fromEntries(Object.keys(frame).map(id => [id, { price: frame[id].price, weight: state.config.allocations[id] / 100 }]));
  }
  const c = r.cohort, summaries = [];
  for (const id of SHADOWS) {
    const predictions = Object.fromEntries(Object.keys(frame).map(asset => [asset, forecasts[asset][6] ?? { probability: .5, ready: false }]));
    const result = Object.keys(shadowConfig.allocations).length ? portfolioStep(c.shadows[id], quotes, now, { id:['dca-weekly','rsi-recovery'].includes(id)?'baseline':id, predictions }) : {state:c.shadows[id]};
    const changes = result.state.events;
    c.trades[id] = (c.trades[id] ?? 0) + changes.filter(e => ['COMPRAR', 'VENDER'].includes(e.action)).length;
    const value = equity(result.state); c.peaks[id] = Math.max(c.peaks[id] ?? 1000, value); c.drawdowns[id] = Math.max(c.drawdowns[id] ?? 0, (1 - value / c.peaks[id]) * 100);
    summaries.push({ id, equityUnits: value, returnPct: (value / 1000 - 1) * 100, maxDrawdownPct: c.drawdowns[id], trades: c.trades[id], paused: result.state.paused,
      decisions: changes.map(e => ({ asset: e.asset, action: e.action, reason: e.reason })),
      status: id === 'learned' && r.models[6].trained < 100 ? 'learning' : 'shadow-only' });
    result.state.events = [];
    for (const holding of Object.values(result.state.portfolio)) holding.observations = holding.observations.slice(-24);
    result.state.observations = [];
    c.shadows[id] = result.state;
  }
  c.cycles++;
  const cashWeight = 1 - Object.values(c.benchmarkEntries).reduce((s, e) => s + e.weight, 0);
  const benchmarkValue = 1000 * (cashWeight + Object.entries(c.benchmarkEntries).reduce((sum, [asset, e]) => sum + e.weight * quotes[asset].price / e.price * .999 / 1.001, 0));
  c.summaries = summaries;
  const baseline = summaries.find(s => s.id === 'baseline');
  const recommendations = summaries.filter(s => s.id !== 'baseline').map(s => ({ strategy: s.id,
    status: now - Date.parse(c.startedAt) >= 14 * 86400000 && r.models[6].scored >= 200 && s.trades >= 10 && s.returnPct > baseline.returnPct && s.maxDrawdownPct <= baseline.maxDrawdownPct ? 'review-candidate' : 'insufficient-evidence',
    reason: 'Sem promoção automática: comparar ao menos 14 dias, 200 resultados de 6h e 10 negociações, retorno e drawdown fora da amostra' }));
  r.pending = [...waiting, ...newSamples].slice(-500); r.lastSlot = slot; r.news = news; r.features = features; r.forecasts = forecasts;
  r.updatedAt = iso(now); r.recommendations = recommendations;
  r.metrics = Object.fromEntries(HORIZONS.map(h => { const m = r.models[h]; return [h, { trained: m.trained, scored: m.scored, missed: m.missed, brier: m.scored ? m.brierSum / m.scored : null, accuracy: m.scored ? m.correct / m.scored : null, averageNetReturnPct: m.scored ? m.netReturnSum / m.scored : null }]; }));
  r.directionMetrics=Object.fromEntries(HORIZONS.map(h=>{const banks=[r.directionModels[h],...Object.values(r.directionByAsset).map(b=>b[h]).filter(Boolean)],n=banks.reduce((v,b)=>v+b.scored,0),correct=banks.reduce((v,b)=>v+b.correct,0);return [h,{scored:n,correct,accuracy:n?correct/n:null,brier:n?banks.reduce((v,b)=>v+b.brierSum,0)/n:null,flatExcluded:r.directionFlat[h]??0}];}));
  const delta = { directionMetrics:r.directionMetrics,directionModelSnapshots:{global:r.directionModels,byAsset:r.directionByAsset}, asOf: iso(now), slot, modelVersion: MODEL_VERSION, featureNames: FEATURE_NAMES, features, forecasts,
    newPredictions: newSamples.map(({ vector, ...sample }) => sample), outcomes, metrics: r.metrics, news,
    experiment: { scope:'crypto-only', cohort: c.id, cycles: c.cycles, startedAt: c.startedAt, summaries, benchmark: { id: 'buy-hold-mix', equityUnits: benchmarkValue, returnPct: (benchmarkValue / 1000 - 1) * 100, note: 'Mix normalizado de 1000 unidades, sem stops; não é saldo do usuário' } }, recommendations };
  r.latest = delta;
  return { research: r, delta };
}

export async function enrichResearch(state, quotes, now = Date.now(), collector = collectNews) {
  if (!state.config || state.intelligence?.lastSlot >= iso(now).slice(0, 13)) return state;
  const news = await collector(state.intelligence?.news, fetch, now);
  const { research, delta } = advanceResearch(state.intelligence, state, quotes, news, now);
  const next = { ...state, intelligence: research, researchDelta: delta, researchError: null };
  if (delta) next.events = state.events.map(e => e.at === iso(now) ? { ...e, context: { technical: delta.features[e.asset]?.technical, news: delta.features[e.asset]?.news, forecasts: delta.forecasts[e.asset], influencedActiveDecision: false } } : e);
  return next;
}
