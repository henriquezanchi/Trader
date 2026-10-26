import { normalizeExecutionPoints } from './execution-study.mjs';
import { digest } from './prediction-protocol.mjs';

// Explicit ISO availability and observation times; no automatic FX conversion or candle interpolation.
export function importMinuteCSV(text, { asset, source, currency, now = Date.now() } = {}) {
  if (!['bitcoin','ethereum','solana','binancecoin','ripple','cardano','chainlink','avalanche-2','polkadot','litecoin'].includes(asset)) throw Error('Ativo inválido');
  if (currency !== 'BRL') throw Error('O histórico deve estar em BRL; conversão cambial não é presumida');
  if (typeof source !== 'string' || source.trim().length < 3 || source.length > 160) throw Error('Informe a origem do histórico');
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw Error('CSV excede 32 MiB');
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 241 || lines.length > 250001 || text.includes('"')) throw Error('CSV deve ter 240 a 250000 linhas, sem campos entre aspas');
  const header = lines.shift().split(','), required = ['available_at','observed_at','price_brl'];
  if (!required.every(k => header.includes(k)) || new Set(header).size !== header.length) throw Error('Colunas obrigatórias: available_at,observed_at,price_brl');
  const seen = new Map(), points = []; let volumes = 0;
  for (const [i, line] of lines.entries()) {
    const values = line.split(',');
    if (values.length !== header.length) throw Error(`Número de campos inválido na linha ${i + 2}`);
    const row = Object.fromEntries(header.map((k, j) => [k, values[j]]));
    const explicitTime = s => /T.*(?:Z|[+-]\d\d:\d\d)$/.test(s ?? '');
    const at = Date.parse(row.available_at), observed = Date.parse(row.observed_at), price = Number(row.price_brl);
    if (!explicitTime(row.available_at) || !explicitTime(row.observed_at) || !Number.isFinite(at) || !Number.isFinite(observed) || at > now || observed > at || at - observed > 120000 || !Number.isFinite(price) || price <= 0 || row.asset && row.asset !== asset || row.source && row.source !== source.trim()) throw Error(`Tempo, ativo ou preço inválido na linha ${i + 2}`);
    if (row.volume !== undefined && row.volume !== '') {
      if (!Number.isFinite(Number(row.volume)) || Number(row.volume) < 0) throw Error(`Volume inválido na linha ${i + 2}`);
      volumes++;
    }
    if (seen.has(observed) && seen.get(observed) !== price) throw Error(`Preço conflitante para o mesmo instante na linha ${i + 2}`);
    seen.set(observed, price);
    points.push({ at: new Date(at).toISOString(), observedAt: new Date(observed).toISOString(), price, source: source.trim() });
  }
  const normalized = normalizeExecutionPoints(points), deltas = normalized.slice(1).map((p, i) => Date.parse(p.at) - Date.parse(normalized[i].at)).sort((a, b) => a - b);
  if (normalized.length < 240 || deltas[Math.floor(deltas.length / 2)] > 120000) throw Error('Histórico não tem resolução de um ou dois minutos; dados horários não serão interpolados');
  // One actual quote per two-minute bucket. Retain its original times, never create a bucket price.
  const buckets = new Map();
  for (const p of normalized) buckets.set(Math.floor(Date.parse(p.at) / 120000), p);
  const observations = [...buckets.values()];
  if (observations.length < 240) throw Error('Poucas observações após agrupar os dois minutos');
  return { observations, manifest: { asset, source: source.trim(), currency, importedAt: new Date(now).toISOString(),
    fileHash: digest(text), inputRows: lines.length, observations: observations.length,
    volumeRowsDeclared: volumes, volumeUsedByModel: false, timestampPolicy: 'explicit quote/candle availability; no interpolation',
    trust: 'user-declared historical source; not a prospective observation' } };
}
