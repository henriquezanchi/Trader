import { validateConfig, portfolioStep } from './portfolio.mjs';
import { getQuotes } from './services.mjs';

export function hourlyHistory(points, now = Date.now()) {
  if (!Array.isArray(points)) throw new Error('Histórico de mercado ausente');
  const hour = 3600000, slots = new Map();
  for (const point of points) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[1] <= 0 || point[1] > 1e9 || point[0] > now - 30 * 60000 || point[0] < now - 26 * hour) continue;
    const slot = Math.floor(point[0] / hour);
    const previous = slots.get(slot);
    if (!previous || point[0] > previous[0]) slots.set(slot, point);
  }
  // Source samples need not align to the wall-clock hour of the current quote.
  // Keep real timestamps, never fabricate an interpolated price or future observation.
  const selected = [...slots.values()].sort((a, b) => a[0] - b[0]).slice(-23);
  if (selected.length !== 23) throw new Error('Histórico horário incompleto; nenhuma operação executada');
  const history = selected.map(point => { const at = new Date(point[0]).toISOString(); return { at, observedAt: at, price: point[1], historical: true, source: 'coingecko-market-chart' }; });
  if (history.some((x, i) => i && (Date.parse(x.at) - Date.parse(history[i - 1].at) > 90 * 60000 || Date.parse(x.at) - Date.parse(history[i - 1].at) < 30 * 60000)) || now - Date.parse(history.at(-1).at) > 90 * 60000) throw new Error('Histórico não é contínuo até a cotação atual');
  return history;
}

export async function historyFor(ids, fetcher = fetch, now = Date.now()) {
  const headers = process.env.COINGECKO_DEMO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_DEMO_API_KEY } : {};
  const entries = await Promise.all(ids.map(async id => {
    const response = await fetcher(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=brl&days=2`, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Histórico de mercado indisponível; tente novamente mais tarde');
    const data = await response.json();
    return [id, hourlyHistory(data.prices, now)];
  }));
  return Object.fromEntries(entries);
}

export async function bootstrapTick(repo, fetcher = fetch, now = Date.now()) {
  const { version, state } = await repo.read();
  if (!state.config || !state.portfolio) throw new Error('Configure a carteira antes de preparar o histórico');
  if (state.paused) throw new Error('Inicie a simulação antes de preparar o histórico');
  if (state.bootstrap) throw new Error('O histórico inicial já foi preparado; use Executar ciclo');
  if (Object.values(state.portfolio).some(p => p.quantity > 0)) throw new Error('Preparação inicial indisponível com posição aberta');
  validateConfig(state.config);
  if (state.lastTick && new Date(now).toISOString().slice(0, 13) <= state.lastTick) throw new Error('Esta hora já foi processada; prepare o histórico na próxima hora');
  const ids = Object.keys(state.config.allocations);
  const histories = await historyFor(ids, fetcher, now);
  const quotes = await getQuotes(ids, fetcher, now);
  const seeded = structuredClone(state);
  for (const id of ids) {
    seeded.portfolio[id].observations = histories[id];
  }
  seeded.bootstrap = { at: new Date(now).toISOString(), source: 'coingecko-market-chart', historicalSamples: 23, replayedTrades: 0,
    priorObservations: Object.fromEntries(ids.map(id => [id, state.portfolio[id].observations])) };
  const result = portfolioStep(seeded, quotes, now);
  await repo.commit(version, result.state);
  return { ...result, version: version + 1 };
}
