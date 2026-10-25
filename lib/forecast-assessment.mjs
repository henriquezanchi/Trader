// Fixed triage rules, not a statistical significance test or proof of profit.
export const READINESS_POLICY=Object.freeze({id:'forecast-readiness-v1',minLive:100,minEachDirection:20,minCoverage:.95,minBrierSkill:.02,minBalancedAccuracy:.55,minAccuracyLead:.03,minHistory:100,minFolds:3,minFoldCases:10,minWinningFoldFraction:.75,maxHistoryAgeDays:7});
const finite=(...values)=>values.every(Number.isFinite);
export function assessLive(m){
 const p=READINESS_POLICY,reasons=[];
 if(!m||!finite(m.valid,m.tp,m.fn,m.tn,m.fp,m.coverage,m.brierSkill,m.balancedAccuracy,m.accuracy,m.alwaysUpAccuracy,m.momentumAccuracy))return {ready:false,reasons:['Métricas auditáveis completas ainda indisponíveis']};
 if(m.valid<p.minLive)reasons.push(`Amostra ao vivo: ${m.valid}/${p.minLive} avaliações válidas`);
 if(m.tp+m.fn<p.minEachDirection||m.tn+m.fp<p.minEachDirection)reasons.push('Poucos casos de alta ou de baixa');
 if(m.coverage<p.minCoverage)reasons.push('Cobertura inferior a 95%');
 if(m.brierSkill<=p.minBrierSkill)reasons.push('Probabilidades sem melhora mínima sobre a referência de 50%');
 if(m.balancedAccuracy<p.minBalancedAccuracy)reasons.push('Acerto balanceado inferior a 55%');
 if(m.accuracy<=Math.max(m.alwaysUpAccuracy,m.momentumAccuracy)+p.minAccuracyLead)reasons.push('Vantagem inferior ou igual a 3 pontos percentuais sobre as regras simples');
 return {ready:!reasons.length,reasons};
}
export function assessHistory(report,horizon,now=Date.now()){
 const p=READINESS_POLICY,reasons=[],m=report?.protocolMetrics?.[horizon];
 if(report?.protocolId!=='direction-audit-v2'||!m)return {ready:false,reasons:['Histórico sem revalidação pelo protocolo atual'],windows:0,winningWindows:0};
 const end=Date.parse(report.dataEnd);
 if(!Number.isFinite(end)||end>now||now-end>p.maxHistoryAgeDays*86400000)reasons.push('Histórico ausente, futuro ou com mais de sete dias desde a última observação');
 if(!finite(m.valid,m.coverage,m.accuracy,m.alwaysUpAccuracy,m.momentumAccuracy,m.brierSkill)||m.valid<p.minHistory||m.coverage<p.minCoverage)reasons.push('Teste histórico sem amostra ou cobertura mínima');
 if(!finite(m.accuracy,m.alwaysUpAccuracy,m.momentumAccuracy,m.brierSkill)||m.accuracy<=Math.max(m.alwaysUpAccuracy,m.momentumAccuracy)+p.minAccuracyLead||m.brierSkill<=p.minBrierSkill)reasons.push('Teste histórico sem vantagem mínima sobre as referências');
 const folds=report.walkForward?.[horizon]??[];
 const qualified=folds.filter(f=>{const v=f.metrics;return v&&finite(v.valid,v.coverage,v.tp,v.fn,v.tn,v.fp,v.accuracy,v.alwaysUpAccuracy,v.momentumAccuracy,v.brierSkill)&&v.valid>=p.minFoldCases&&v.coverage>=p.minCoverage&&v.tp+v.fn>0&&v.tn+v.fp>0;});
 const winning=qualified.filter(f=>f.metrics.accuracy>Math.max(f.metrics.alwaysUpAccuracy,f.metrics.momentumAccuracy)&&f.metrics.brierSkill>0);
 if(qualified.length<p.minFolds||winning.length/qualified.length<p.minWinningFoldFraction)reasons.push('Vantagem não se repete em pelo menos 75% das janelas elegíveis, com mínimo de três janelas');
 return {ready:!reasons.length,reasons,windows:qualified.length,winningWindows:winning.length};
}
export function forecastReadiness(state,id,horizon=1,now=Date.now()){
 const live=assessLive(state.intelligence?.directionEvaluation?.metrics?.[horizon]?.assets?.[id]);
 const history=assessHistory(state.intelligence?.history?.[id],horizon,now);
 return {asset:id,horizon:Number(horizon),policy:READINESS_POLICY.id,ready:live.ready&&history.ready,live,history,note:'Triagem empírica de previsão direcional. Não demonstra lucro líquido, independência das amostras ou significância estatística.'};
}
