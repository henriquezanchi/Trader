import { normalizeExecutionPoints } from './execution-study.mjs';
import { trendSignal,exitProgress,entryRuleEvidence,resolveExitPlan,ADAPTIVE_EXIT_POLICY } from './trend-exit.mjs';
import { netRoundTrip,economicAudit } from './forecast-economics.mjs';
import { PROFIT_RULES,profitabilityEvidence } from './profitability.mjs';
import { digest } from './prediction-protocol.mjs';

export const TREND_PROTOCOL=Object.freeze({id:'trend-exit-comparison-v1',horizonUnit:'minutes',horizons:[6,20,60,240,1440],folds:5,
 minObservations:240,maxGapMs:300000,maxEvaluationDelayMs:120000,expiryDelayMs:360000,
 reference:'always-fixed: no entry filter, net target 0.5% (1% for 1 day), same maximum horizon',
 profitRules:PROFIT_RULES,training:'fixed causal entry/exit rules; parameters selected using only earlier completed windows',
 testAssignment:'entry-time; completed outcomes may cross a fold boundary',researchOnly:true,realTradingEnabled:false});
export const TREND_CANDIDATES=['always','trend','breakout'].flatMap(entryRule=>['fixed','trailing'].map(exitMode=>({id:entryRule+'-'+exitMode,entryRule,exitMode})));
const iso=t=>new Date(t).toISOString();
export const horizonExitPlan=minutes=>({maxMinutes:minutes,takeProfitPct:minutes===1440?1:.5,trailingDrawdownPct:minutes===1440?.6:.3});
function windows(points,h){
 const rows=[];let next=-Infinity;
 for(let i=23;i<points.length;i++){
  const p=points[i],at=Date.parse(p.at),target=at+h*60000;if(at<next)continue;
  const signal=trendSignal(points.slice(i-23,i+1),at);if(!signal.ready)continue;
  if(target>Date.parse(points.at(-1).at))break;
  let j=i+1;while(j<points.length&&Date.parse(points[j].observedAt)<target)j++;
  const end=points[j],label=end&&Date.parse(end.observedAt)<=target+TREND_PROTOCOL.maxEvaluationDelayMs?Date.parse(end.at):target+TREND_PROTOCOL.expiryDelayMs;
  if(label>Date.parse(points.at(-1).at))continue;
  const path=end?points.slice(i+1,j+1).filter(v=>Date.parse(v.observedAt)>at):[],continuous=path.length>0&&path.every((v,k)=>Date.parse(v.at)-Date.parse(k?path[k-1].at:p.at)<=TREND_PROTOCOL.maxGapMs&&Date.parse(v.observedAt)-Date.parse(k?path[k-1].observedAt:p.observedAt)<=TREND_PROTOCOL.maxGapMs);
  const valid=!!end&&Date.parse(end.observedAt)<=target+TREND_PROTOCOL.maxEvaluationDelayMs&&continuous;
  rows.push({at:p.at,targetAt:iso(target),labelKnownAt:iso(label),entryPrice:p.price,signal,status:valid?'scored':'missing-price',path:valid?path:[],missingReason:valid?null:'Caminho incompleto, lacuna maior que cinco minutos ou preço ausente após o prazo'});next=label;
 }
 return rows;
}
export function simulateTrendExit(path,entryPrice,asset,plan,targetAt){
 let tracking;const deadline=Date.parse(targetAt);
 for(const p of path){
  const rawPct=(p.price/entryPrice-1)*100,netPct=netRoundTrip(rawPct,asset),progress=exitProgress(plan,tracking,netPct,p.observedAt);tracking=progress.tracking;
  if(progress.reason||Date.parse(p.observedAt)>=deadline)return {rawPct,netPct,stressNetPct:netRoundTrip(rawPct,asset,2),exitAt:p.at,exitPriceAt:p.observedAt,exitPrice:p.price,tracking,
   exitReason:progress.reason??`Prazo máximo de ${plan.maxMinutes} minutos; saída no preço realmente observado`};
 }
 return null;
}
function policyRow(window,candidate,asset,h){
 const entry=entryRuleEvidence(window.signal,candidate,asset),buy=entry.eligible;
 const plan={...horizonExitPlan(h),...candidate};Object.assign(plan,resolveExitPlan(plan,window.signal));
 const base={at:window.at,targetAt:window.targetAt,labelKnownAt:window.labelKnownAt,status:window.status,
  probability:buy?1:0,candidate:candidate.id,signal:window.signal,decision:buy?'COMPRAR':'CAIXA',
  entryReason:candidate.entryRule==='always'?'Referência sem filtro de entrada':entry.reason,exitPlan:{takeProfitPct:plan.takeProfitPct,trailingDrawdownPct:plan.trailingDrawdownPct,exitMode:plan.exitMode,exitSizing:plan.exitSizing},
  entryPrice:window.entryPrice,rawPct:null};
 if(window.status!=='scored')return {...base,missingReason:window.missingReason};
 const result=simulateTrendExit(window.path,window.entryPrice,asset,plan,window.targetAt);
 return result?{...base,...result}:{...base,status:'missing-price',missingReason:'Sem preço executável para concluir o caminho'};
}
function assessment(rows,asset,baseline){
 const profit=profitabilityEvidence(rows,asset,{baselineRows:baseline}),known=rows.filter(r=>r.status==='scored'),bought=known.filter(r=>r.probability>=.5),cash=known.filter(r=>r.probability<.5);
 const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
 return {valid:known.length,missing:rows.length-known.length,buyCases:bought.length,cashCases:cash.length,
  netWinRate:profit.netWinRate,meanNetPct:profit.expectancyNetPct,meanStressNetPct:profit.expectancyStressPct,
  policyMeanNetPerOpportunityPct:profit.policyNetPerOpportunityPct,policyStressPerOpportunityPct:profit.policyStressPerOpportunityPct,
  avoidedLossMeanPct:mean(cash.map(r=>Math.max(0,-r.netPct))),missedGainMeanPct:mean(cash.map(r=>Math.max(0,r.netPct))),
  meanHoldingMinutes:mean(bought.map(r=>(Date.parse(r.exitAt)-Date.parse(r.at))/60000)),profit};
}
export function runTrendStudy(raw,asset,{now=Date.now(),source='Auditoria CoinGecko · cotações reais',manifest=null,protocol=TREND_PROTOCOL,candidates=TREND_CANDIDATES}={}){
 if(new Set(raw.filter(p=>Date.parse(p.at)<=now).map(p=>p.source??'coingecko')).size>1)throw Error('Não misturar provedores');
 const points=normalizeExecutionPoints(raw).filter(p=>Date.parse(p.at)<=now);
 if(points.length<protocol.minObservations)throw Error('Histórico insuficiente: mínimo de 240 cotações');
 const report={asset,protocol:protocol,source,manifest,observations:points.length,dataStart:points[0].at,dataEnd:points.at(-1).at,
  datasetHash:digest({points,protocol:protocol,manifest:manifest?{...manifest,importedAt:undefined}:null}),createdAt:iso(now),executionCosts:economicAudit([],asset),horizons:{},limitations:[
   'Regras determinísticas de tendência e rompimento; não são probabilidades de previsão nem uma promessa de rentabilidade.',
   'Validação usa somente janelas anteriores já concluídas. Cinco testes por instante de entrada na segunda metade do histórico; saídas podem ocorrer na janela seguinte sem entrar antecipadamente na validação. Resultados históricos não aumentam o índice de acerto prospectivo.',
   'Entrada usa 24 cotações anteriores. Sem volume histórico, livro de ordens ou notícias nesta comparação.',
   'Mesmo calendário de oportunidades para todas as candidatas em cada prazo; após sair antes do prazo, o valor fica em caixa até a próxima janela.',
   'Picos e saídas usam somente cotações observadas; não há preenchimento no preço do gatilho. Uma lacuna maior que cinco minutos invalida o caminho inteiro para todas as candidatas.',
   'Retornos por operação de mesmo valor, sem compor carteira ou assumir reinvestimento imediato. Prazos diferentes têm oportunidades e tempos de exposição diferentes.',
   'A referência de alvo fixo reproduz a regra de saída, não todo o motor adaptativo e seus limites de carteira. A saída móvel pode realizar prejuízo após uma queda brusca.',
  ]};
 const atFraction=f=>points[Math.min(points.length-1,Math.floor(points.length*f))].at;
 for(const h of protocol.horizons){
  const common=windows(points,h),policies=Object.fromEntries(candidates.map(c=>[c.id,common.map(w=>policyRow(w,c,asset,h))]));
  const folds=[],selected=[],references=[];
  for(let index=0;index<5;index++){
   const from=atFraction((5+index)/10),until=index===4?iso(Date.parse(points.at(-1).at)+1):atFraction((6+index)/10);
   const validationRows=Object.fromEntries(Object.entries(policies).map(([id,rows])=>[id,rows.filter(r=>r.labelKnownAt<from)]));
   const validation=Object.entries(validationRows).map(([candidate,rows])=>({candidate,...assessment(rows,asset,validationRows['always-fixed'])}));
   const eligible=validation.filter(v=>v.profit.qualified).sort((a,b)=>b.policyStressPerOpportunityPct-a.policyStressPerOpportunityPct||a.candidate.localeCompare(b.candidate));
   const chosen=eligible[0]?.candidate??'always-fixed',testRows=policies[chosen].filter(r=>r.at>=from&&r.at<until),baseline=policies['always-fixed'].filter(r=>r.at>=from&&r.at<until);
   const validationResult=validation.find(v=>v.candidate===chosen),profitQualified=!!eligible.length;
   selected.push(...testRows.map(r=>({...r,foldIndex:index+1,profitQualifiedAtEntry:profitQualified,validationProfit:validationResult.profit,selectionBefore:from})));references.push(...baseline);
   folds.push({index:index+1,testFrom:from,testUntil:until,chosen,profitQualified,validation:validationResult,comparisons:validation,
    test:assessment(testRows,asset,baseline),reference:assessment(baseline,asset,baseline)});
  }
  const comparisonRows=Object.fromEntries(candidates.map(c=>[c.id,folds.flatMap(f=>policies[c.id].filter(r=>r.at>=f.testFrom&&r.at<f.testUntil))]));
  const result=assessment(selected,asset,references),reference=assessment(references,asset,references);
  const decisions=selected.map(({signal,validationProfit,...r})=>({...r,signal:{ready:signal.ready,trend:signal.trend,breakout:signal.breakout,pullback:signal.pullback,observedRangePct:signal.observedRangePct,variationRatePct:signal.variationRatePct,pullbackPct:signal.pullbackPct,lastChangePct:signal.lastChangePct,ema8:signal.ema8,ema21:signal.ema21,returnPct:signal.returnPct,priorHigh:signal.priorHigh,inputHash:signal.inputHash},
   reason:`${r.entryReason}. ${r.profitQualifiedAtEntry?'Escolhida por lucro líquido na validação anterior':'Referência provisória: nenhuma candidata passou as regras de lucro na validação anterior'}. ${r.decision==='CAIXA'?'Comparação hipotética de uma compra recusada':r.exitReason??r.missingReason}`,
   validationExpectedNetPct:validationProfit.expectancyNetPct,validationExpectedStressPct:validationProfit.expectancyStressPct}));
  report.horizons[h]={...result,reference,folds,profitQualifiedFolds:folds.filter(f=>f.profitQualified).length,
   comparisons:candidates.map(c=>({candidate:c.id,...assessment(comparisonRows[c.id],asset,references)})),decisions};
 }
 report.summary={asset,protocol:protocol.id,horizonUnit:'minutes',candidateCount:candidates.length,source,dataStart:report.dataStart,dataEnd:report.dataEnd,observations:points.length,datasetHash:report.datasetHash,
  horizons:Object.fromEntries(Object.entries(report.horizons).map(([h,v])=>[h,{valid:v.valid,buyCases:v.buyCases,netWinRate:v.netWinRate,meanNetPct:v.meanNetPct,meanStressNetPct:v.meanStressNetPct,profitQualifiedFolds:v.profitQualifiedFolds,referenceMeanNetPct:v.reference.meanNetPct}]))};
 return {report,models:{},observations:points};
}

export const ADAPTIVE_TREND_PROTOCOL=Object.freeze({...TREND_PROTOCOL,id:'trend-exit-comparison-v2',adaptiveExitPolicy:ADAPTIVE_EXIT_POLICY,
 notes:'Pullback and cost-range filters are hypotheses; price-only volatility scaling is not ATR or a return forecast.'});
export const ADAPTIVE_TREND_CANDIDATES=Object.freeze([...TREND_CANDIDATES,
 {id:'trend-adaptive',entryRule:'trend',exitMode:'trailing',adaptiveExit:true},
 {id:'pullback-fixed',entryRule:'pullback',exitMode:'fixed'},
 {id:'pullback-trailing',entryRule:'pullback',exitMode:'trailing'},
 {id:'pullback-adaptive',entryRule:'pullback',exitMode:'trailing',adaptiveExit:true},
 {id:'pullback-cost-adaptive',entryRule:'pullback',exitMode:'trailing',adaptiveExit:true,costAware:true},
]);
export function runAdaptiveTrendStudy(raw,asset,options={}){
 const result=runTrendStudy(raw,asset,{...options,protocol:ADAPTIVE_TREND_PROTOCOL,candidates:ADAPTIVE_TREND_CANDIDATES});
 result.report.limitations.push('Recuos e dimensionamento por variação observada são regras novas. A escala usa raiz do tempo, sem OHLC/ATR, volume, spread real ou garantia de que movimentos passados se repitam.');
 return result;
}
