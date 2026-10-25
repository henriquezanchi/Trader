import { exploring } from './exploration.mjs';
import { learningPlan, recordEntry, recordExit } from './learning.mjs';
import { blendFor } from './blend.mjs';
import { isETF, costs, fill, etfBlock, dailyIndicators, releaseSettlement, settlementDate, localDate } from './markets.mjs';
import { validateQuote, equity } from './engine.mjs';
import { randomUUID } from 'node:crypto';
import { indicators as technicalIndicators } from './indicators.mjs';

export const ASSETS = Object.freeze([
  {id:'smal11',symbol:'SMAL11',name:'ETF Small Caps Brasil',market:'b3',risk:'Muito alto',potential:'Ações de empresas menores; menor liquidez e maior volatilidade'},
  {id:'divo11',symbol:'DIVO11',name:'ETF Dividendos Brasil',market:'b3',risk:'Alto',potential:'Ações com foco em dividendos; renda e valorização não garantidas'},
  {id:'gold11',symbol:'GOLD11',name:'ETF Ouro',market:'b3',risk:'Alto',potential:'Exposição a ouro e câmbio; pode cair mesmo em períodos de crise'},
  {id:'xfix11',symbol:'XFIX11',name:'ETF de fundos imobiliários',market:'b3',risk:'Alto',potential:'Exposição a FIIs; sensível a juros e ao mercado imobiliário'},
  {id:'binancecoin',symbol:'BNB',name:'BNB',risk:'Muito alto',potential:'Risco da rede, de plataforma e regulatório'},
  {id:'ripple',symbol:'XRP',name:'XRP',risk:'Muito alto',potential:'Volatilidade e riscos de adoção e regulação'},
  {id:'cardano',symbol:'ADA',name:'Cardano',risk:'Muito alto',potential:'Risco de rede, concorrência e adoção'},
  {id:'chainlink',symbol:'LINK',name:'Chainlink',risk:'Muito alto',potential:'Risco tecnológico e da demanda por oráculos'},
  {id:'avalanche-2',symbol:'AVAX',name:'Avalanche',risk:'Muito alto',potential:'Rede concorrente de contratos inteligentes; oscilações intensas'},
  {id:'polkadot',symbol:'DOT',name:'Polkadot',risk:'Muito alto',potential:'Riscos de adoção, oferta e concorrência'},
  {id:'litecoin',symbol:'LTC',name:'Litecoin',risk:'Muito alto',potential:'Volatilidade e incerteza de demanda'},
  { id: 'bova11', symbol: 'BOVA11', name: 'ETF Ibovespa', market:'b3', risk:'Alto', potential:'Ações brasileiras; cotas inteiras; sujeito a perdas' },
  { id: 'ivvb11', symbol: 'IVVB11', name: 'ETF S&P 500 em reais', market:'b3', risk:'Alto', potential:'Ações dos EUA e variação cambial; cotas inteiras' },
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', risk: 'Alto', potential: 'Volatilidade elevada; sem previsão de retorno' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', risk: 'Muito alto', potential: 'Maior incerteza tecnológica e de mercado' },
  { id: 'solana', symbol: 'SOL', name: 'Solana', risk: 'Muito alto', potential: 'Oscilações intensas, com risco de grandes perdas' },
]);
export const PROFILES = Object.freeze({
  'diversificado-conservador': {label:'Menor exposição · experimental',allocations:{bova11:8,bitcoin:1,ethereum:1},exposurePct:10,orderPct:10,dailyLossPct:.5,totalLossPct:3,targetPct:3,days:90},
  'diversificado-moderado': {label:'Diversificado moderado · experimental',allocations:{bova11:20,ivvb11:45,bitcoin:5,ethereum:3,solana:2},exposurePct:75,orderPct:45,dailyLossPct:1,totalLossPct:5,targetPct:5,days:90},
  'diversificado-agressivo': {label:'Diversificado arrojado · experimental',allocations:{bova11:15,ivvb11:45,bitcoin:8,ethereum:10,solana:5,binancecoin:3,ripple:3,cardano:2,chainlink:3,'avalanche-2':3,polkadot:1.5,litecoin:1.5},exposurePct:100,orderPct:50,dailyLossPct:2,totalLossPct:10,targetPct:10,days:90},
  conservador: { label: 'Conservador relativo a cripto', allocations: { bitcoin: 6, ethereum: 4 }, exposurePct: 10, orderPct: 5, dailyLossPct: 0.5, totalLossPct: 2, targetPct: 2, days: 90 },
  moderado: { label: 'Moderado relativo a cripto', allocations: { bitcoin: 15, ethereum: 8, solana: 2 }, exposurePct: 25, orderPct: 10, dailyLossPct: 1, totalLossPct: 5, targetPct: 5, days: 90 },
  agressivo: { label: 'Arrojado / agressivo', allocations: { bitcoin: 25, ethereum: 15, solana: 10 }, exposurePct: 50, orderPct: 20, dailyLossPct: 2, totalLossPct: 10, targetPct: 10, days: 90 },
});
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(PROFILES, input.profile)) throw new Error('Perfil inválido');
  const cryptoStrategy=input.cryptoStrategy??'trend';
  if(!['trend','rsi-recovery','dca-weekly','hybrid','active'].includes(cryptoStrategy))throw Error('Estratégia inválida');
  const discoveryPct=input.discoveryPct??(input.profile.includes('agressivo')?15:input.profile.includes('conservador')?0:5);
  if(!Number.isFinite(discoveryPct)||discoveryPct<0||discoveryPct>20)throw Error('Limite de novos pools inválido');
  if(input.simulationExploration!==undefined&&typeof input.simulationExploration!=='boolean')throw Error('Modo de simulação inválido');
  const c = { profile: input.profile, cryptoStrategy, discoveryPct, simulationExploration:input.simulationExploration??false, allocations: {} };
  const learningPolicy=input.learningPolicy??'legacy';if(!['legacy','paper-entry-value-v1'].includes(learningPolicy))throw Error('Política de aprendizado inválida');
  const learningExplorationPct=input.learningExplorationPct??20;if(!Number.isFinite(learningExplorationPct)||learningExplorationPct<1||learningExplorationPct>100)throw Error('Parcela de exploração inválida');
  c.learningPolicy=learningPolicy;c.learningExplorationPct=learningExplorationPct;
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
  const config = validateConfig({...input,simulationExploration:input?.simulationExploration??previous.config?.simulationExploration,learningPolicy:input?.learningPolicy??previous.config?.learningPolicy,learningExplorationPct:input?.learningExplorationPct??previous.config?.learningExplorationPct});
  const s = structuredClone(previous);
  for(const [id,p] of Object.entries(s.fast?.positions??{}))if(p.quantity>0&&!Object.hasOwn(config.allocations,id))throw Error('Encerre a posição curta antes de remover o ativo');
  if (!s.portfolio) {
    s.portfolio = { bitcoin: { quantity: s.btc, lastPrice: s.lastPrice, observations: s.observations } };
  }
  for (const [id, holding] of Object.entries(s.portfolio)) {
    if (!Object.hasOwn(config.allocations, id) && holding.quantity > 0) throw new Error('Não remova um ativo com posição aberta; encerre a posição virtual primeiro');
  }
  for (const id of Object.keys(config.allocations)) s.portfolio[id] ??= { quantity: 0, lastPrice: null, observations: [] };
  for(const p of Object.values(s.fast?.positions??{}))if(p.quantity>0&&!p.plan)p.plan={stopPct:s.fast.params?.stopPct??1.2,takeProfitPct:s.fast.params?.takeProfitPct??.5,maxMinutes:s.fast.params?.maxMinutes??180};
  s.config = config;
  s.reason = 'Carteira configurada; inicie a simulação quando estiver pronto';
  return s;
}

export function stopReason(s, now = Date.now()) {
  if(exploring(s))return null;
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
  if (!policy.riskOnly && s.lastTick && slot <= s.lastTick) return { state: s, duplicate: true };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  if (s.day !== day) { s.day = day; s.dayEquity = equity(s); }
  if(!policy.riskOnly)s.lastTick = slot;
  for (const id of ids) {
    const p = s.portfolio[id], q = quotes[id];
    if (isETF(id)) { if(q && Number.isFinite(q.price) && q.price > 0 && Date.parse(q.observedAt)<=now && now-Date.parse(q.observedAt)<7*86400000) { p.lastPrice=q.price; p.dailyHistory=q.history; } continue; }
    p.lastPrice = q.price;
    if(!policy.riskOnly)p.observations = [...p.observations, { at: new Date(now).toISOString(), ...q }].slice(-72);
  }
  for(const [id,p] of Object.entries(s.fast?.positions??{}))if(quotes[id]?.price)p.lastPrice=quotes[id].price;
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
    const learningEntry=p.learningEntry;
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
    const event={ id: randomUUID(), at: new Date(now).toISOString(), asset: id, mode:policy.id==='baseline'?'core':'research', action, reason, quantity, fee, executionPrice, price, realizedPnl, estimatedTax,
      parameters: { engine: policy.id === 'baseline' ? isETF(id)?'etf-daily-6-24-v1':c.cryptoStrategy==='dca-weekly'?'btc-weekly-dca-v1':c.cryptoStrategy==='rsi-recovery'?'rsi-recovery-v1':'moving-average-6-24-v2' : `shadow-${policy.id}-v1`, config: structuredClone(c), ...rates, positionPlan:p.plan??null,timeframe: isETF(id) ? 'daily' : 'hourly', settlement: isETF(id) ? 'D+2' : 'immediate', signalThreshold: .002, forecast: policy.predictions?.[id] ?? null },
      indicators, quote: { ...quotes[id], history: undefined, source: quotes[id]?.source ?? 'coingecko' }, before,
      after: { cash: s.cash, quantity: p.quantity, equity: equity(s), costBasis: p.costBasis ?? null },
      risk: { initialCapital: s.initialCapital, dayEquity: s.dayEquity, stop, paused: s.paused } };
    if(action==='COMPRAR'){const plan=learningPlan(s,id,quotes[id],{stopPct:2,takeProfitPct:4,maxMinutes:c.days*1440},now);p.plan={stopPct:plan.stopPct,takeProfitPct:plan.takeProfitPct,maxMinutes:plan.maxMinutes};event.parameters.positionPlan=p.plan;event.learning=recordEntry(s,p,id,quotes[id],plan,event,now);}
    if(action==='VENDER'){event.saleProceeds=realizedPnl==null?null:realizedPnl+before.costBasis;event.learning=recordExit(s,learningEntry,event,now);delete p.learningEntry;delete p.plan;}
    decisions.push(event);
  }
  // Sell before buying so allocation is deterministic and cash is never overdrawn.
  const buy = [];
  for (const id of ids) {
    const p = s.portfolio[id], recent = p.observations.slice(-24);
    const blocked = isETF(id) ? etfBlock(quotes[id], now) : null;
    const technical = isETF(id) ? dailyIndicators(quotes[id]?.history, now) : technicalIndicators(p.observations);
    const exitValue=p.quantity>0&&p.costBasis>0&&p.lastPrice>0?fill(id,'VENDER',p.lastPrice,0,p,now).cashChange/p.costBasis*100-100:null;
    if (blocked) trade(id, 'AGUARDAR', `${blocked}${stop ? '; saída por limite pendente de mercado disponível' : ''}`);
    else if (stop) trade(id, p.quantity > 0 ? 'VENDER' : 'AGUARDAR', stop);
    else if(p.plan&&exitValue!=null&&(exitValue>=p.plan.takeProfitPct||exitValue<=-p.plan.stopPct))trade(id,'VENDER',`Plano da posição: resultado líquido ${exitValue.toFixed(2)}%, alvo +${p.plan.takeProfitPct}%, perda de referência -${p.plan.stopPct}%`);
    else if(policy.riskOnly)trade(id,'AGUARDAR','Verificação imediata de risco, sem nova entrada de cenário');
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
    const exposure = equity(s)-s.cash-(s.unsettled??[]).reduce((sum,x)=>sum+x.amount,0);
    const amount = Math.min(s.cash, s.initialCapital * c.orderPct / 100, s.initialCapital * (c.allocations[id] ?? 0) / 100 * (['hybrid','active'].includes(c.cryptoStrategy)&&!isETF(id)?blendFor(c).coreShare:1) - s.portfolio[id].quantity * s.portfolio[id].lastPrice, s.initialCapital*(c.allocations[id]??0)/100-s.portfolio[id].quantity*s.portfolio[id].lastPrice-(s.fast?.positions[id]?.quantity??0)*(s.fast?.positions[id]?.lastPrice??0), c.cryptoStrategy==='dca-weekly'&&id==='bitcoin' ? s.initialCapital*.01 : Infinity, c.cryptoStrategy==='dca-weekly'&&id==='bitcoin' ? s.initialCapital*.05-s.portfolio[id].quantity*s.portfolio[id].lastPrice : Infinity, s.initialCapital * c.exposurePct / 100 - exposure);
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
