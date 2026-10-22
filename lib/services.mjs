import { initialState, step, validateQuote } from './engine.mjs';
import { ASSETS, portfolioStep } from './portfolio.mjs';

export async function getQuotes(ids, fetcher = fetch, now = Date.now()) {
  if (!ids.length || ids.some(id => !ASSETS.some(a => a.id === id))) throw new Error('Ativo não suportado');
  const headers = process.env.COINGECKO_DEMO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_DEMO_API_KEY } : {};
  const res = await fetcher(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=brl&include_last_updated_at=true`, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Fonte de preços indisponível; nenhum ativo foi processado');
  const data = await res.json(), quotes = {};
  for (const id of ids) {
    if (!Number.isFinite(data[id]?.last_updated_at)) throw new Error(`Cotação ausente: ${id}`);
    const q = { price: data[id].brl, observedAt: new Date(data[id].last_updated_at * 1000).toISOString() };
    validateQuote(q, now); quotes[id] = q;
  }
  return quotes;
}

export async function getQuote(fetcher = fetch, now = Date.now()) {
  const headers = process.env.COINGECKO_DEMO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_DEMO_API_KEY } : {};
  const res = await fetcher('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl&include_last_updated_at=true', { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Fonte de preços indisponível; nenhuma operação registrada');
  const data = await res.json();
  const bitcoin = data?.bitcoin;
  const timestamp = bitcoin?.last_updated_at;
  if (!Number.isFinite(timestamp)) throw new Error('Horário da cotação ausente');
  const quote = { price: bitcoin.brl, observedAt: new Date(timestamp * 1000).toISOString() };
  validateQuote(quote, now);
  return quote;
}

export function repository(fetcher = fetch) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) throw new Error('Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no servidor');
  async function request(path, options = {}) {
    const res = await fetcher(`${url}/rest/v1/${path}`, { ...options, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('Falha no banco; confira a migração e as variáveis do servidor');
    return res.json();
  }
  return {
    async read() {
      const row = await request('rpc/trade_lab_read', { method: 'POST', body: '{}' });
      if (!row) throw new Error('Execute a migração SQL antes de iniciar');
      const state = row.payload ?? initialState();
      if (state.initialCapital == null) {
        const capital = Number(process.env.INITIAL_BALANCE_BRL);
        if (!Number.isFinite(capital) || capital <= 0) throw new Error('Configure INITIAL_BALANCE_BRL para a instalação existente; não reinicialize o saldo');
        state.initialCapital = capital;
      }
      return { version: row.version, state };
    },
    async commit(version, state) {
      const success = await request('rpc/trade_lab_commit', { method: 'POST', body: JSON.stringify({ expected_version: version, next_payload: state }) });
      if (!success) throw new Error('Outra execução alterou o estado. Atualize e tente novamente');
    }
  };
}

export async function runTick(repo, quoteProvider, now = Date.now()) {
  const { version, state } = await repo.read();
  // Sem novo preço não há novo saldo, sinal ou negócio.
  const ids = state.config ? [...new Set([...Object.keys(state.config.allocations), ...Object.keys(state.portfolio).filter(id => state.portfolio[id].quantity > 0)])] : [];
  const result = state.config
    ? portfolioStep(state, await (quoteProvider ?? (() => getQuotes(ids)))(), now)
    : step(state, await (quoteProvider ?? getQuote)(), now);
  if (!result.duplicate) await repo.commit(version, result.state);
  return { ...result, version: version + (result.duplicate ? 0 : 1) };
}
