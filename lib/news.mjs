import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

export const NEWS_SOURCES = Object.freeze([
  { id: 'google-news', name: 'Google Notícias · agregador', url: 'https://news.google.com/rss/search?q=bitcoin+OR+ethereum+OR+solana+OR+BNB+OR+XRP+OR+cardano+OR+chainlink+OR+avalanche+OR+polkadot+OR+litecoin&hl=pt-BR&gl=BR&ceid=BR:pt-419' },
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
]);
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, processEntities: false, parseTagValue: false });
const list = v => v == null ? [] : Array.isArray(v) ? v : [v];
const text = v => String(typeof v === 'object' ? v?.['#text'] ?? '' : v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
function sentiment(title) {
  const positive = (title.match(/\b(aprova\w*|approved|approval|rally|surge|adoção|adoption|parceria|partnership|recuperação)\b/gi) ?? []).length;
  const negative = (title.match(/\b(hack\w*|exploit\w*|fraude|fraud|crash|outage|proibição|lawsuit|queda|ataque|liquidações)\b/gi) ?? []).length;
  return Math.max(-1, Math.min(1, (positive - negative) / 2));
}
export function parseNews(xml, source, now = Date.now()) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 262144 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Feed inválido');
  const data = parser.parse(xml), items = [...list(data.rss?.channel?.item), ...list(data.feed?.entry)];
  return items.flatMap(item => {
    const title = text(item.title).slice(0, 300), published = Date.parse(text(item.pubDate ?? item.published ?? item.updated ?? item.date));
    const link = list(item.link).map(v => typeof v === 'object' ? v['@_href'] ?? v['#text'] : v).find(Boolean);
    let url;
    try { url = new URL(link); } catch { return []; }
    if (!title || !Number.isFinite(published) || published > now || now - published > 24 * 3600000 || url.protocol !== 'https:' || url.username || url.password) return [];
    const assetPatterns={bitcoin:/\bbitcoin\b|\bbtc\b/i,ethereum:/\bethereum\b|\beth\b/i,solana:/\bsolana\b|\bSOL\b/,binancecoin:/\bBNB\b|\bbinance coin\b/i,ripple:/\bXRP\b|\bripple\b/i,cardano:/\bcardano\b|\bADA\b/,chainlink:/\bchainlink\b|\bLINK\b/,'avalanche-2':/\bavalanche\b|\bAVAX\b/i,polkadot:/\bpolkadot\b|\bDOT\b/,litecoin:/\blitecoin\b|\bLTC\b/i};
    const assets=Object.keys(assetPatterns).filter(id=>assetPatterns[id].test(title));
    if (!assets.length && !/\bfed\b|inflação|interest rates|taxa de juros|\bcpi\b/i.test(title)) return [];
    return [{ id: createHash('sha256').update(url.href).digest('hex').slice(0, 24), title, url: url.href, source: source.name,
      sourceId: source.id, publisher: text(item.source).slice(0, 100) || source.name,
      publishedAt: new Date(published).toISOString(), firstSeenAt: new Date(now).toISOString(), assets,
      score: sentiment(title), method: 'headline-lexicon-v1' }];
  }).slice(0, 24);
}

async function boundedText(response) {
  const chunks = []; let size = 0;
  if (!response.body?.getReader) {
    const value = await response.text(); if (Buffer.byteLength(value) > 262144) throw new Error('Feed muito grande'); return value;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 262144) throw new Error('Feed muito grande'); chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function collectNews(previous, fetcher = fetch, now = Date.now()) {
  if (previous?.fetchedAt && now >= Date.parse(previous.fetchedAt) && now - Date.parse(previous.fetchedAt) < 55 * 60000) return previous;
  const old = new Map((previous?.items ?? []).map(item => [item.id, item]));
  const outcomes = await Promise.all(NEWS_SOURCES.map(async source => {
    try {
      const response = await fetcher(source.url, { signal: AbortSignal.timeout(3000), redirect: 'error', headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
      if (!response.ok) return { source: source.name, status: `HTTP ${response.status}`, items: [] };
      return { source: source.name, status: 'ok', items: parseNews(await boundedText(response), source, now) };
    } catch { return { source: source.name, status: 'indisponível', items: [] }; }
  }));
  const merged = new Map([...old.entries()]);
  for (const result of outcomes) for (const item of result.items) merged.set(item.id, { ...item, firstSeenAt: old.get(item.id)?.firstSeenAt ?? item.firstSeenAt });
  const items = [...merged.values()].filter(item => Date.parse(item.publishedAt) <= now && now - Date.parse(item.publishedAt) <= 24 * 3600000).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 24);
  return { fetchedAt: new Date(now).toISOString(), sources: outcomes.map(({ source, status }) => ({ source, status })), items };
}

export function newsFor(asset, news, now = Date.now()) {
  const available = Boolean(news?.sources?.some(s => s.status === 'ok') && now >= Date.parse(news.fetchedAt) && now - Date.parse(news.fetchedAt) <= 90 * 60000);
  const items = (news?.items ?? []).filter(item => (!item.assets.length || item.assets.includes(asset)) && Date.parse(item.firstSeenAt) <= now && Date.parse(item.publishedAt) <= now && now - Date.parse(item.publishedAt) <= 24 * 3600000);
  return { available, count: items.length, score: items.length ? items.reduce((a, b) => a + b.score, 0) / items.length : 0, ids: items.map(i => i.id), method: 'headline-lexicon-v1' };
}
