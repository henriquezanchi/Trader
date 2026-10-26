import { PROFIT_RULES, profitabilityEvidence } from './profitability.mjs';
import { EXECUTION_PROTOCOL, executionSamples, normalizeExecutionPoints } from './execution-study.mjs';
import { CANDIDATES, fitCandidate, candidateProbability, evaluateCandidate, goalEvidence } from './scenario-study.mjs';
import { newScore, scoreOutcome, scoreView, digest } from './prediction-protocol.mjs';
import { netRoundTrip,economicAudit } from './forecast-economics.mjs';

export const WALK_PROTOCOL = Object.freeze({
  ...EXECUTION_PROTOCOL, id: 'execution-walk-forward-v1', folds: 5,
  initialTrainingFraction: .4, validationFraction: .1, testFraction: .1,
  maxTrainCases: 1000, maxValidationCases: 200, maxTestCases: 200,
  minValidationCases: 20, minRegimeCases: 10, minRegimeBrierGain: .01,
  selection: 'net-profit validation rules first, ranked by stress return per opportunity; Brier fallback for research; purged labels',
  researchOnly: true, profitabilityRules: PROFIT_RULES, costReportVersion: 'round-trip-break-even-v1',
});
const iso = t => new Date(t).toISOString();
// Sampling depends only on position in time, never on a return or a model prediction.
function bounded(rows, cap) {
  if (rows.length <= cap) return rows;
  return Array.from({ length: cap }, (_, i) => rows[Math.floor(i * rows.length / cap)]);
}
function eligible(v, min = WALK_PROTOCOL.minValidationCases) {
  return v.metrics.valid >= min && v.metrics.coverage >= .95 && Number.isFinite(v.metrics.brier);
}
function select(rows) {
  return [...rows].sort((a, b) => a.evaluation.metrics.brier - b.evaluation.metrics.brier || a.candidate.localeCompare(b.candidate))[0];
}
function routeModel(chosen, routes, models) {
  if (!Object.keys(routes).length) return models[chosen];
  const base = models[chosen];
  return { id: 'regime-router-context', trained: base.trained, lastTrainingLabelAt: base.lastTrainingLabelAt,
    contextFeatureVersion: WALK_PROTOCOL.contextFeatureVersion, defaultModel: base,
    regimes: Object.fromEntries(Object.entries(routes).map(([key, id]) => [key, models[id]])) };
}
function predictions(model, rows) {
  return rows.map(s => ({ ...s, probability: candidateProbability(model, s), modelHash: digest(model) }));
}
function assess(rows, asset) {
  const stats = newScore(); let buys = 0, buyIssued = 0, net = 0, stress = 0;
  let allBuy = 0, allStress = 0, known = 0, avoidedLoss = 0, missedGain = 0, rejected = 0;
  for (const r of rows) {
    stats.issued++;
    scoreOutcome(stats, { probability: r.probability, baselines: { momentumUp: r.momentumUp } }, r);
    const buy = r.probability >= .5;
    if (buy) buyIssued++;
    if (r.status !== 'scored') continue;
    const n = netRoundTrip(r.rawPct, asset), s = netRoundTrip(r.rawPct, asset, 2);
    known++; allBuy += n; allStress += s;
    if (buy) { buys++; net += n; stress += s; }
    else { rejected++; avoidedLoss += Math.max(0, -n); missedGain += Math.max(0, n); }
  }
  return { metrics: scoreView(stats), economics: {
    buyCases: buys, buyIssued, buyCoverage: buyIssued ? buys / buyIssued : null,
    meanNetPct: buys ? net / buys : null, meanStressNetPct: buys ? stress / buys : null,
    cashReturnPct: 0, knownOpportunities: known, rejectedKnown: rejected,
    policyMeanNetPerOpportunityPct: known ? net / known : null,
    policyMeanStressPerOpportunityPct: known ? stress / known : null,
    alwaysBuyMeanNetPct: known ? allBuy / known : null,
    alwaysBuyMeanStressPct: known ? allStress / known : null,
    avoidedLossMeanPct: rejected ? avoidedLoss / rejected : null,
    missedGainMeanPct: rejected ? missedGain / rejected : null,
    note: 'Operações hipotéticas de mesmo valor; médias por oportunidade, não retorno composto nem resultado da carteira.'
  } };
}
export function runWalkForward(raw, asset, { now = Date.now(), source = 'Auditoria CoinGecko · cotações reais', manifest = null } = {}) {
  if (new Set(raw.filter(p=>Date.parse(p.at)<=now).map(p=>p.source??'coingecko')).size>1) throw Error('Não misturar provedores no mesmo estudo');
  const points = normalizeExecutionPoints(raw).filter(p => Date.parse(p.at) <= now);
  if (points.length < 240) throw Error('São necessárias pelo menos 240 observações em minutos');
  if (new Set(points.map(p => p.source)).size !== 1) throw Error('Não misturar provedores no mesmo estudo');
  const gaps = points.slice(1).filter((p, i) => Date.parse(p.at) - Date.parse(points[i].at) > WALK_PROTOCOL.maxGapMs).length;
  const report = { protocol: WALK_PROTOCOL, asset, source, manifest,
    datasetHash: digest({ protocol: WALK_PROTOCOL, points, manifest:manifest?{...manifest,importedAt:undefined}:null }),
    dataStart: points[0].at, dataEnd: points.at(-1).at, createdAt: iso(now),
    observations: points.length, gaps, executionCosts:economicAudit([],asset), horizons: {}, limitations: [
      'Pesquisa histórica: dados já disponíveis; confirmação futura permanece separada.',
      'Janelas de teste não se sobrepõem dentro de cada ativo e prazo. Ativos e prazos podem ser correlacionados.',
      'Cada decisão usa somente preços conhecidos e rótulos concluídos antes do treino e da validação.',
      'Não há interpolação de preços. Ausências e períodos sem dados continuam contabilizados.',
      'Importações declaram a fonte; não comprovam a integridade do fornecedor. Não são misturadas com cotações ao vivo.',
      'Volume, spread, notícias e liquidez não entram nestes modelos enquanto não houver séries históricas verificadas.',
      'Amostras limitadas por posição temporal: até 1000 no treino e 200 na validação e teste de cada janela.',
      'Comprar e ficar em caixa são contrafactuais com taxas e deslizamento; não movimentam a carteira.',
    ] }, models = {};
  const pointAt = fraction => points[Math.min(points.length - 1, Math.floor(points.length * fraction))].at;
  for (const h of WALK_PROTOCOL.horizons) {
    const samples = executionSamples(points, asset, h), folds = [], routedRows = [], globalRows = [];
    const candidates = Object.fromEntries(CANDIDATES.map(c => [c, []])); let latest;
    for (let index = 0; index < WALK_PROTOCOL.folds; index++) {
      const validationFrom = pointAt((4 + index) / 10), testFrom = pointAt((5 + index) / 10);
      const testUntil = index === 4 ? iso(Date.parse(points.at(-1).at) + 1) : pointAt((6 + index) / 10);
      const train = bounded(samples.filter(s => s.labelKnownAt < validationFrom), WALK_PROTOCOL.maxTrainCases);
      const validation = bounded(samples.filter(s => s.at >= validationFrom && s.labelKnownAt < testFrom), WALK_PROTOCOL.maxValidationCases);
      const retrain = bounded(samples.filter(s => s.labelKnownAt < testFrom), WALK_PROTOCOL.maxTrainCases);
      const availableTest = samples.filter(s => s.at >= testFrom && s.labelKnownAt < testUntil);
      const testing = bounded(availableTest, WALK_PROTOCOL.maxTestCases);
      const trainingModels = Object.fromEntries(CANDIDATES.map(c => [c, fitCandidate(c, train, WALK_PROTOCOL.contextFeatureVersion)]));
      const validations = CANDIDATES.map(candidate => ({ candidate, evaluation: evaluateCandidate(trainingModels[candidate], validation, asset) }));
      const choices = validations.filter(v => eligible(v.evaluation) && trainingModels[v.candidate].trained >= WALK_PROTOCOL.minTrainingCases);
      const profitable = choices.map(v => ({ ...v, profit: profitabilityEvidence(predictions(trainingModels[v.candidate], validation), asset) })).filter(v => v.profit.qualified)
        .sort((a,b) => b.profit.policyStressPerOpportunityPct - a.profit.policyStressPerOpportunityPct || a.candidate.localeCompare(b.candidate));
      const chosen = profitable[0]?.candidate ?? select(choices)?.candidate ?? 'train-prior', routes = {};
      for (const scenario of new Set(validation.map(s => s.scenario))) {
        const rows = validation.filter(s => s.scenario === scenario);
        const base = evaluateCandidate(trainingModels[chosen], rows, asset);
        if (!choices.length || !eligible(base, WALK_PROTOCOL.minRegimeCases)) continue;
        const alternatives = CANDIDATES.map(candidate => ({ candidate, evaluation: evaluateCandidate(trainingModels[candidate], rows, asset) })).filter(v => eligible(v.evaluation, WALK_PROTOCOL.minRegimeCases));
        const best = select(alternatives.filter(v => profitabilityEvidence(predictions(trainingModels[v.candidate], rows), asset).qualified));
        if (best && best.evaluation.metrics.brier + WALK_PROTOCOL.minRegimeBrierGain < base.metrics.brier) routes[scenario] = best.candidate;
      }
      if (!profitabilityEvidence(predictions(routeModel(chosen,routes,trainingModels),validation),asset).qualified) for (const key of Object.keys(routes)) delete routes[key];
      const fitted = Object.fromEntries(CANDIDATES.map(c => [c, fitCandidate(c, retrain, WALK_PROTOCOL.contextFeatureVersion)]));
      const router = routeModel(chosen, routes, fitted);
      const profitValidation = profitabilityEvidence(predictions(routeModel(chosen,routes,trainingModels),validation),asset);
      const selected = predictions(router, testing).map(r => ({ ...r, foldIndex:index+1,
        candidate: routes[r.scenario]??chosen, profitQualifiedAtEntry: profitValidation.qualified,
        expectedNetAtEntry: profitValidation.expectancyNetPct, expectedStressAtEntry: profitValidation.expectancyStressPct }));
      routedRows.push(...selected); globalRows.push(...predictions(fitted[chosen], testing));
      for (const c of CANDIDATES) candidates[c].push(...predictions(fitted[c], testing));
      const outcome = assess(selected, asset);
      folds.push({ index: index + 1, validationFrom, testFrom, testUntil, chosen, routes,
        profitQualified: profitValidation.qualified, profitValidation,
        selectionEligible: choices.length > 0, trainingCases: train.length, validationCases: validation.length,
        availableTestCases: availableTest.length, sampledTestCases: testing.length,
        modelHash: digest(router), lastTrainingLabelAt: router.lastTrainingLabelAt,
        validation: validations.find(v => v.candidate === chosen).evaluation.metrics,
        ...outcome });
      latest = { chosen, routes, testFrom, selectionEligible: choices.length > 0 };
    }
    const finalTraining = bounded(samples.filter(s => s.labelKnownAt <= iso(now)), WALK_PROTOCOL.maxTrainCases);
    const refitted = Object.fromEntries([...new Set([latest.chosen, ...Object.values(latest.routes)])].map(c => [c, fitCandidate(c, finalTraining, WALK_PROTOCOL.contextFeatureVersion)]));
    const deployment = routeModel(latest.chosen, latest.routes, refitted);
    models[h] = { ...deployment, hash: digest(deployment), datasetHash: report.datasetHash, selectedBefore: latest.testFrom };
    const result = assess(routedRows, asset), globalResult = assess(globalRows, asset);
    const opportunities = routedRows.map(r => ({ at: r.at, targetAt: r.targetAt, labelKnownAt: r.labelKnownAt,
      scenario: r.scenario, modelHash: r.modelHash, probability: r.probability, foldIndex:r.foldIndex, candidate:r.candidate,
      profitQualifiedAtEntry:r.profitQualifiedAtEntry,expectedNetAtEntry:r.expectedNetAtEntry,expectedStressAtEntry:r.expectedStressAtEntry,
      decision: r.probability >= .5 ? 'COMPRAR' : 'CAIXA', status: r.status,
      buyNetPct: r.status === 'scored' ? netRoundTrip(r.rawPct, asset) : null,
      buyStressNetPct: r.status === 'scored' ? netRoundTrip(r.rawPct, asset, 2) : null,
      cashNetPct: 0, reason: `${r.probability>=.5?'Compra hipotética: probabilidade de alta de pelo menos 50%':'Caixa hipotético: probabilidade de alta inferior a 50%'}. ${r.profitQualifiedAtEntry?'Estratégia qualificada nas regras de lucro da validação anterior':'Somente pesquisa: lucro ainda não qualificado na validação anterior'}. Método ${r.candidate}, janela ${r.foldIndex}; resultado medido após o horizonte.` }));
    report.horizons[h] = { chosen: latest.chosen, selectionEligible: latest.selectionEligible,
      folds, ...result, global: globalResult, comparisons: CANDIDATES.map(candidate => ({ candidate, ...assess(candidates[candidate], asset) })),
      opportunities, eligibleFolds: folds.filter(f => f.selectionEligible).length,
      positiveFolds: folds.filter(f => f.economics.meanNetPct > 0 && f.economics.meanStressNetPct > 0).length,
      profitQualifiedFolds: folds.filter(f => f.profitQualified).length,
      goal: goalEvidence(result.metrics, result.economics), deploymentRefitAfterEvaluation: true };
  }
  report.summary = { asset, protocol: WALK_PROTOCOL.id, horizonUnit: 'minutes', datasetHash: report.datasetHash,
    source, dataStart: report.dataStart, dataEnd: report.dataEnd, candidateCount: CANDIDATES.length,
    observations: points.length, gaps, breakEvenRawPct:report.executionCosts.breakEvenRawPct, horizons: Object.fromEntries(Object.entries(report.horizons).map(([h, v]) => [h, {
      chosen: v.chosen, selectionEligible: v.selectionEligible, metrics: v.metrics, economics: v.economics,
      eligibleFolds: v.eligibleFolds, positiveFolds: v.positiveFolds, profitQualifiedFolds: v.profitQualifiedFolds, goal: v.goal,
      scenariosObserved: new Set(v.opportunities.map(o => o.scenario)).size,
    }])) };
  return { report, models, observations: points };
}
