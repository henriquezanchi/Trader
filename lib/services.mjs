import { advanceDirections } from './directions.mjs';
import { discover, poolQuotes, isPool } from './discovery.mjs';
import { randomUUID } from 'node:crypto';
import { fastStep } from './fast.mjs';
import { stopReason } from './portfolio.mjs';
import { updatePerformance } from './performance.mjs';
import { isETF, getETFs } from './markets.mjs';
import { initialState, step, validateQuote, equity } from './engine.mjs';
import { ASSETS, portfolioStep } from './portfolio.mjs';
import { enrichResearch } from './research.mjs';

export async function getQuotes(ids, fetcher = fetch, now = Date.now()) {
  if (!ids.length || ids.some(id => !ASSETS.some(a => a.id === id))) throw new Error('Ativo não suportado');
  const etfIds = ids.filter(isETF);
  if (etfIds.length) {
    const crypto = ids.filter(id => !isETF(id));
    const [a,b] = await Promise.all([crypto.length ? getQuotes(crypto,fetcher,now) : {}, getETFs(etfIds,fetcher,now)]);
    return {...a,...b};
  }
  const headers = process.env.COINGECKO_DEMO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_DEMO_API_KEY } : {};
  const res = await fetcher(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=brl&include_last_updated_at=true&include_24hr_vol=true`, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(res.status === 429 ? 'Limite de consultas da fonte de preços atingido; aguarde antes de tentar novamente' : `Fonte de preços indisponível (HTTP ${res.status}); nenhum ativo foi processado`);
  const data = await res.json(), quotes = {};
  for (const id of ids) {
    if (!Number.isFinite(data[id]?.last_updated_at)) throw new Error(`Cotação ausente: ${id}`);
    const q = { price: data[id].brl, observedAt: new Date(data[id].last_updated_at * 1000).toISOString(), volume24h: Number.isFinite(data[id].brl_24h_vol) && data[id].brl_24h_vol > 0 ? data[id].brl_24h_vol : null };
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
  async function request(path, options = {}, timeoutMs = 10000) {
    const res = await fetcher(`${url}/rest/v1/${path}`, { ...options, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      let code='';try{const body=await res.json();if(/^[A-Z0-9]{5}$/.test(body?.code))code=body.code;}catch{}
      throw new Error(`Falha no banco (HTTP ${res.status}${code?', código '+code:''}); operação ${path.replace('rpc/','')}`);
    }
    return res.json();
  }
  return {
    async trainingData(asset) { return request('rpc/trade_lab_training_data_read',{method:'POST',body:JSON.stringify({asset_id:asset})}); },
    async quality() { return request('rpc/trade_lab_quality_read',{method:'POST',body:'{}'}); },
    async research(beforeId = null) {
      return request('rpc/trade_lab_research_read', { method: 'POST', body: JSON.stringify({ before_id: beforeId }) });
    },
    async audit(beforeId = null) {
      return request('rpc/trade_lab_audit_read', { method: 'POST', body: JSON.stringify({ before_id: beforeId }) });
    },
    async read() {
      const row = await request('rpc/trade_lab_read', { method: 'POST', body: '{}' }, 20000);
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
      const success = await request('rpc/trade_lab_commit', { method: 'POST', body: JSON.stringify({ expected_version: version, next_payload: state }) }, 20000);
      if (!success) throw new Error('Outra execução alterou o estado. Atualize e tente novamente');
    }
  };
}

export async function getPortfolioQuotes(state,fetcher=fetch,now=Date.now()){
 const ids=[...new Set([...Object.keys(state.config?.allocations??{}),...Object.keys(state.portfolio??{}).filter(id=>state.portfolio[id].quantity>0),...Object.keys(state.fast?.positions??{}).filter(id=>state.fast.positions[id].quantity>0)])];
 const held=ids.filter(isPool),enabled=state.config?.cryptoStrategy==='active'&&state.config.discoveryPct>0;
 const [quotes,discovery]=await Promise.all([getQuotes(ids.filter(id=>!isPool(id)),fetcher,now),enabled||held.length?discover(state.discovery,held,fetcher,now):state.discovery]);
 return {quotes:{...quotes,...poolQuotes(discovery,now)},discovery};
}

export async function runTick(repo, quoteProvider, now = Date.now()) {
  const { version, state } = await repo.read();
  // Sem novo preço não há novo saldo, sinal ou negócio.
  const ids = state.config ? [...new Set([...Object.keys(state.config.allocations), ...Object.keys(state.portfolio).filter(id => state.portfolio[id].quantity > 0),...Object.keys(state.fast?.positions??{}).filter(id=>state.fast.positions[id].quantity>0)])] : [];
  let quotes,discovery=state.discovery;
  try { if(quoteProvider)quotes=await quoteProvider();else if(state.config){({quotes,discovery}=await getPortfolioQuotes(state,fetch,now));}else quotes=await getQuote(); }
  catch (error) {
    const slot=String(Math.floor(now/120000));
    if(state.dataStatus?.failureSlot!==slot){
      const reason='Fonte de preços indisponível ou sem cotação válida; nenhuma operação executada';
      const next={...state,dataStatus:{status:'unavailable',at:new Date(now).toISOString(),failureSlot:slot,message:reason},events:[...state.events,{id:randomUUID(),at:new Date(now).toISOString(),action:'AGUARDAR',mode:'data',reason,fee:0,equity:equity(state),parameters:{engine:'data-guard-v1',config:state.config??null},indicators:null,quote:null,before:{cash:state.cash,equity:equity(state)},after:{cash:state.cash,equity:equity(state)}}].slice(-200)};
      await repo.commit(version,next);
    }
    throw error;
  }
  const result = state.config ? portfolioStep({...state,discovery}, quotes, now) : step(state, quotes, now);
  const hourlyChanged=!result.duplicate;
  try { if(hourlyChanged)result.state=await enrichResearch(result.state,state.config?quotes:{},now); }
  catch {result.state={...result.state,researchError:{at:new Date(now).toISOString(),message:'Pesquisa indisponível neste ciclo; limites preservados'},researchDelta:{asOf:new Date(now).toISOString(),status:'error',message:'Pesquisa indisponível'}};}
  const directional=advanceDirections(result.state,quotes,now);if(directional!==result.state){result.state=directional;result.duplicate=false;}
  const short=fastStep(result.state,quotes,now);if(!short.duplicate){result.state=short.state;result.duplicate=false;}
  if(result.state.config&&stopReason(result.state,now)&&Object.values(result.state.portfolio??{}).some(p=>p.quantity>0)){
    result.state=portfolioStep(result.state,quotes,now,{id:'baseline',riskOnly:true}).state;result.duplicate=false;
  }
  if (!result.duplicate) {
    result.state.dataStatus={status:'ok',at:new Date(now).toISOString()};
    result.state = await updatePerformance(result.state);
    await repo.commit(version, result.state);
  }
  return { ...result, version: version + (result.duplicate ? 0 : 1) };
}
