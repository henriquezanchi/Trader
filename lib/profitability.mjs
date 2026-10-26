import { netRoundTrip } from './forecast-economics.mjs';
export const PROFIT_RULES = Object.freeze({
  id: 'net-profit-validation-v1', minKnown: 20, minBuys: 10, minCoverage: .95,
  minProfitFactor: 1.2, stressCostMultiplier: 2, baselineCashPct: 0,
  scope: 'Research validation only; never a promise of profit or a new portfolio risk limit',
});
export function profitabilityEvidence(rows, asset, { baselineRows = null } = {}) {
  const issued = rows.filter(r => r.probability >= .5);
  const known = rows.filter(r => r.status === 'scored' && Number.isFinite(r.rawPct));
  const bought = issued.filter(r => r.status === 'scored' && Number.isFinite(r.rawPct));
  const baselineMap = baselineRows ? new Map(baselineRows.map(r=>[r.at,r])) : null;
  const baseline = known.map(r=>baselineMap?.get(r.at)??(baselineMap?null:r)).filter(r=>r?.status==='scored'&&Number.isFinite(r.rawPct));
  const net = bought.map(r => netRoundTrip(r.rawPct, asset));
  const stress = bought.map(r => netRoundTrip(r.rawPct, asset, PROFIT_RULES.stressCostMultiplier));
  const mean = x => x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
  const withoutBest = x => x.length > 1 ? (x.reduce((a, b) => a + b, 0) - Math.max(...x)) / (x.length - 1) : null;
  const wins = net.filter(n => n > 0), losses = net.filter(n => n < 0);
  const gains = wins.reduce((a, b) => a + b, 0), loss = -losses.reduce((a, b) => a + b, 0);
  const factor = loss > 0 ? gains / loss : null;
  const sumNet = net.reduce((a, b) => a + b, 0), sumStress = stress.reduce((a, b) => a + b, 0);
  const evidence = { rule: PROFIT_RULES.id, known: known.length, buys: bought.length,
    coverage: rows.length ? known.length / rows.length : null,
    buyCoverage: issued.length ? bought.length / issued.length : null,
    netWinRate: net.length ? wins.length / net.length : null,
    averageWinPct: mean(wins), averageLossPct: losses.length ? -mean(losses) : null,
    expectancyNetPct: mean(net), expectancyStressPct: mean(stress), profitFactor: factor,
    withoutBestNetPct: withoutBest(net), withoutBestStressPct: withoutBest(stress),
    policyNetPerOpportunityPct: known.length ? sumNet / known.length : null,
    policyStressPerOpportunityPct: known.length ? sumStress / known.length : null,
    alwaysBuyNetPerOpportunityPct: mean(baseline.map(r => netRoundTrip(r.rawPct, asset))),
    baselineCoverage: known.length ? baseline.length/known.length : null,
    cashNetPct: 0, reasons: [], qualified: false };
  const r = evidence.reasons;
  if (known.length < PROFIT_RULES.minKnown || bought.length < PROFIT_RULES.minBuys) r.push('Amostra insuficiente: mínimo de 20 oportunidades e 10 compras avaliadas');
  if (!(evidence.coverage >= PROFIT_RULES.minCoverage) || !(evidence.buyCoverage >= PROFIT_RULES.minCoverage)) r.push('Cobertura inferior a 95%');
  if (!(evidence.expectancyNetPct > 0) || !(evidence.expectancyStressPct > 0)) r.push('Expectativa líquida não é positiva com custos normais e dobrados');
  if (!(evidence.withoutBestNetPct > 0) || !(evidence.withoutBestStressPct > 0)) r.push('Retorno depende da melhor operação ou continua negativo sem ela');
  // An all-win sample has no finite profit factor; require the other evidence, not an invented infinity.
  if (loss > 0 && factor < PROFIT_RULES.minProfitFactor || !wins.length) r.push('Ganhos líquidos não superam as perdas na proporção mínima de 1,2');
  if (baselineMap && !(evidence.baselineCoverage>=PROFIT_RULES.minCoverage)) r.push('Referência comparável incompleta');
  if (!(evidence.policyNetPerOpportunityPct > Math.max(0, evidence.alwaysBuyNetPerOpportunityPct ?? 0))) r.push('Sem vantagem por oportunidade sobre caixa e comprar sempre');
  evidence.qualified = !r.length;
  return evidence;
}
