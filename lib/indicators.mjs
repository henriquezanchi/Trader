const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function indicators(observations) {
  const points = observations.filter(o => Number.isFinite(o.price) && o.price > 0 && Number.isFinite(Date.parse(o.at))).slice(-72);
  const prices = points.map(o => o.price), recent = points.slice(-24);
  const continuous = recent.length === 24 && recent.every((p, i) => !i || Date.parse(p.at) - Date.parse(recent[i - 1].at) <= 90 * 60000);
  const fastMean = prices.length >= 6 ? mean(prices.slice(-6)) : null;
  const slowMean = prices.length >= 24 ? mean(prices.slice(-24)) : null;
  let rsi14 = null;
  if (prices.length >= 15) {
    const diffs = prices.slice(1).map((p, i) => p - prices[i]);
    let gains = mean(diffs.slice(0, 14).map(d => Math.max(0, d))), losses = mean(diffs.slice(0, 14).map(d => Math.max(0, -d)));
    for (const d of diffs.slice(14)) { gains = (gains * 13 + Math.max(0, d)) / 14; losses = (losses * 13 + Math.max(0, -d)) / 14; }
    rsi14 = !gains && !losses ? 50 : !losses ? 100 : 100 - 100 / (1 + gains / losses);
  }
  const returns = prices.slice(-24).slice(1).map((p, i) => Math.log(p / prices.slice(-24)[i]));
  const volatilityPct = returns.length >= 14 ? Math.sqrt(mean(returns.map(r => (r - mean(returns)) ** 2))) * 100 : null;
  const last = points.at(-1);
  const previous = hours => {
    if (!last) return null;
    const target = Date.parse(last.at) - hours * 3600000;
    const eligible = points.filter(p => p !== last && Math.abs(Date.parse(p.at) - target) <= 15 * 60000);
    eligible.sort((a, b) => Math.abs(Date.parse(a.at) - target) - Math.abs(Date.parse(b.at) - target));
    return eligible[0] ? (last.price / eligible[0].price - 1) * 100 : null;
  };
  const ema = (values, period) => values.reduce((prev, p, i) => i ? prev + 2 / (period + 1) * (p - prev) : p, 0);
  const macd = prices.length >= 35 ? ema(prices, 12) - ema(prices, 26) : null;
  return { fastMean, slowMean, trendBps: fastMean && slowMean ? (fastMean / slowMean - 1) * 10000 : null, rsi14, volatilityPct, return1hPct: previous(1), return6hPct: previous(6), macd, samples: points.length, continuous };
}

export const FEATURE_NAMES = ['bias', 'trend', 'rsi', 'volatility', 'return6h', 'newsScore', 'newsCoverage', 'newsMissing', 'volume', 'volumeMissing', 'bitcoin', 'ethereum'];
export function featureVector(asset, technical, news, volume24h) {
  return [1, clamp((technical.trendBps ?? 0) / 100, -3, 3), ((technical.rsi14 ?? 50) - 50) / 50,
    clamp((technical.volatilityPct ?? 0) / 5, 0, 3), clamp((technical.return6hPct ?? 0) / 5, -3, 3),
    news.available ? news.score : 0, Math.min(news.count, 5) / 5, news.available ? 0 : 1,
    volume24h > 0 ? clamp(Math.log10(volume24h) / 12, 0, 2) : 0, volume24h > 0 ? 0 : 1,
    asset === 'bitcoin' ? 1 : 0, asset === 'ethereum' ? 1 : 0];
}
