import { CONTEXT_VERSION,CONTEXT_NAMES,EXECUTION_CONTEXT_VERSION } from './market-context.mjs';
import { historicalSamples } from './historical-samples.mjs';
import { newScore,scoreOutcome,scoreView,digest } from './prediction-protocol.mjs';
import { netRoundTrip } from './forecast-economics.mjs';
export const STUDY_PROTOCOL=Object.freeze({id:'scenario-comparison-v2',goalAccuracy:.8,minGoalCases:200,minEachDirection:40,minCoverage:.95,minBuyCases:30,trainFraction:.5,validationFraction:.2,testFraction:.3,featureIndices:[1,2,3,4],contextFeatureVersion:CONTEXT_VERSION,batchEpochs:100,batchRate:.2,batchL2:.1,neighbors:15,regimePriorCases:20,selectiveConfidence:.7,realTradingEnabled:false});
export const CANDIDATES=['train-prior','always-up','always-down','momentum','trend','reversion','online-logistic','batch-logistic','neighbors','regime-frequency','batch-context','neighbors-context','ensemble-context'];
export const SCENARIOS=['up','down','flat'].flatMap(t=>['low','medium','high'].flatMap(v=>['oversold','neutral','overbought'].map(r=>`${t}|${v}|${r}`)));
const sigmoid=z=>1/(1+Math.exp(-Math.max(-20,Math.min(20,z))));
const compact=m=>Object.fromEntries(['valid','correct','missing','flat','accuracy','balancedAccuracy','brier','brierSkill','coverage','alwaysUpAccuracy','momentumAccuracy','tp','tn','fp','fn'].map(k=>[k,m[k]]));
function features(sample,id){if(id?.endsWith('-context')){if(sample.contextVector?.length!==CONTEXT_NAMES.length||!sample.contextVector.every(Number.isFinite))throw Error('Contexto de preço incompleto');return sample.contextVector;}return STUDY_PROTOCOL.featureIndices.map(i=>sample.vector[i]);}
export function fitCandidate(id,rows,contextVersion=CONTEXT_VERSION){
 const train=rows.filter(s=>s.status==='scored'&&s.rawPct!==0),n=train.length,prior=(train.filter(s=>s.rawPct>0).length+1)/(n+2);
 const model={id,trained:n,prior,lastTrainingLabelAt:train.at(-1)?.labelKnownAt??null};
 if(id.endsWith('-context')){model.contextFeatureVersion=contextVersion;model.contextNames=[...CONTEXT_NAMES];}
 if(!n)return model;
 if(id==='ensemble-context'){model.components=[fitCandidate('batch-context',rows,contextVersion),fitCandidate('neighbors-context',rows,contextVersion)];return model;}
 const xs=train.map(s=>features(s,id)),means=xs[0].map((_,j)=>xs.reduce((v,x)=>v+x[j],0)/n),scales=means.map((m,j)=>Math.sqrt(xs.reduce((v,x)=>v+(x[j]-m)**2,0)/n)||1);
 const scaled=xs.map(x=>x.map((v,j)=>(v-means[j])/scales[j]));
 if(id==='batch-logistic'||id==='batch-context'){
  model.means=means;model.scales=scales;model.weights=[Math.log(prior/(1-prior)),...Array(xs[0].length).fill(0)];
  for(let epoch=0;epoch<STUDY_PROTOCOL.batchEpochs;epoch++){
   const gradient=Array(model.weights.length).fill(0);
   scaled.forEach((x,i)=>{const v=[1,...x],p=sigmoid(v.reduce((s,f,j)=>s+f*model.weights[j],0)),error=Number(train[i].rawPct>0)-p;v.forEach((f,j)=>gradient[j]+=error*f/n);});
   model.weights=model.weights.map((w,j)=>w+STUDY_PROTOCOL.batchRate*(gradient[j]-(j?STUDY_PROTOCOL.batchL2*w:0)));
  }
 }else if(id==='online-logistic'){
  model.weights=Array(rows[0]?.vector.length??12).fill(0);
  for(const s of train){const p=sigmoid(s.vector.reduce((v,x,j)=>v+x*model.weights[j],0));model.weights=model.weights.map((w,j)=>Math.max(-5,Math.min(5,w+.03*((Number(s.rawPct>0)-p)*s.vector[j]-.001*w))));}
 }else if(id==='neighbors'||id==='neighbors-context'){model.means=means;model.scales=scales;model.examples=scaled.map((x,i)=>({x,up:Number(train[i].rawPct>0)}));}
 else if(id==='regime-frequency'){model.regimes={};for(const s of train){const r=model.regimes[s.scenario]??={n:0,up:0};r.n++;r.up+=Number(s.rawPct>0);}}
 return model;
}
export function candidateProbability(model,s){
 if(model.contextFeatureVersion&&![CONTEXT_VERSION,EXECUTION_CONTEXT_VERSION].includes(model.contextFeatureVersion))throw Error('Versão de contexto incompatível');
 const x=features(s,model.id);
 switch(model.id){
 case 'always-up':return .6;
 case 'always-down':return .4;
 case 'momentum':return s.momentumUp?.6:.4;
 case 'trend':return x[0]>=0?.6:.4;
 case 'reversion':return x[1]<-.4?.6:x[1]>.4?.4:x[3]<0?.6:.4;
 case 'online-logistic':return sigmoid(s.vector.reduce((v,f,j)=>v+f*(model.weights?.[j]??0),0));
 case 'ensemble-context':return model.components?.length?model.components.reduce((n,m)=>n+candidateProbability(m,s),0)/model.components.length:model.prior;
 case 'batch-context':
 case 'batch-logistic':return sigmoid(model.weights?.reduce((v,w,j)=>v+w*(j?(x[j-1]-model.means[j-1])/model.scales[j-1]:1),0)??0);
 case 'neighbors-context':
 case 'neighbors':{
  if(!model.examples?.length)return model.prior;
  const scaled=x.map((v,j)=>(v-model.means[j])/model.scales[j]),neighbors=model.examples.map(e=>({up:e.up,d:e.x.reduce((v,f,j)=>v+(f-scaled[j])**2,0)})).sort((a,b)=>a.d-b.d).slice(0,STUDY_PROTOCOL.neighbors);
  return (neighbors.reduce((v,e)=>v+e.up,0)+1)/(neighbors.length+2);
 }
 case 'regime-frequency':{const r=model.regimes?.[s.scenario]??{n:0,up:0};return (r.up+model.prior*STUDY_PROTOCOL.regimePriorCases)/(r.n+STUDY_PROTOCOL.regimePriorCases);}
 default:return model.prior;
 }
}
function nonOverlapping(rows){let next=-Infinity;return rows.filter(s=>{if(Date.parse(s.at)<next)return false;next=Date.parse(s.labelKnownAt);return true;});}
export function evaluateCandidate(model,rows,id){
 const stats=newScore(),regimes={},selective=newScore();let selected=0,buyN=0,buyIssued=0,net=0,stress=0;
 for(const s of nonOverlapping(rows)){
  const p=candidateProbability(model,s),prediction={probability:p,baselines:{momentumUp:s.momentumUp}};stats.issued++;scoreOutcome(stats,prediction,s);
  const r=regimes[s.scenario]??=newScore();r.issued++;scoreOutcome(r,prediction,s);
  if(Math.max(p,1-p)>=STUDY_PROTOCOL.selectiveConfidence){selected++;selective.issued++;scoreOutcome(selective,prediction,s);}
  if(p>=.5)buyIssued++;
  if(p>=.5&&s.status==='scored'){buyN++;net+=netRoundTrip(s.rawPct,id);stress+=netRoundTrip(s.rawPct,id,2);}
 }
 const m=scoreView(stats);
 return {metrics:compact(m),selective:{...compact(scoreView(selective)),participation:stats.issued?selected/stats.issued:null},economics:{buyCases:buyN,buyIssued,buyCoverage:buyIssued?buyN/buyIssued:null,meanNetPct:buyN?net/buyN:null,meanStressNetPct:buyN?stress/buyN:null,cashReturnPct:0},scenarios:SCENARIOS.map(key=>({scenario:key,...compact(scoreView(regimes[key]??newScore()))}))};
}
export function goalEvidence(m,economics,{prospective=false}={}){
 const p=STUDY_PROTOCOL,reasons=[];
 if(!m||!['valid','accuracy','tp','tn','fp','fn','coverage','brierSkill','alwaysUpAccuracy','momentumAccuracy'].every(k=>Number.isFinite(m[k])))return {target:.8,demonstrated:false,reasons:['Métricas completas ainda indisponíveis'],realTradingEnabled:false};
 if(!m||m.valid<p.minGoalCases)reasons.push('Menos de 200 resultados válidos');
 if(!m||m.accuracy<p.goalAccuracy)reasons.push('Acerto inferior a 80%');
 if(!m||m.tp+m.fn<p.minEachDirection||m.tn+m.fp<p.minEachDirection)reasons.push('Poucos casos de alta ou baixa');
 if(!m||m.coverage<p.minCoverage)reasons.push('Cobertura inferior a 95%');
 if(!m||!(m.brierSkill>0)||m.accuracy<=Math.max(m.alwaysUpAccuracy,(m.tn+m.fp)/m.valid,m.momentumAccuracy)+.03)reasons.push('Sem vantagem mínima de probabilidade e acerto sobre prever sempre alta, sempre queda e seguir o último movimento');
 if(!economics||economics.buyCases<p.minBuyCases||!(economics.buyCoverage>=.95)||!(economics.meanNetPct>0)||!(economics.meanStressNetPct>0))reasons.push('Retorno líquido positivo sob custos normais e dobrados ainda não demonstrado em 30 compras');
 if(!prospective)reasons.push('Falta confirmação prospectiva em previsões registradas antes do resultado');
 return {target:.8,demonstrated:!reasons.length,reasons,realTradingEnabled:false};
}
export function runScenarioStudy(points,id,{source='Dataset arquivado',now=Date.now(),protocol=STUDY_PROTOCOL,horizons=[1,6,24],sampleBuilder=historicalSamples}={}){
 if(points.length<120)throw Error('Histórico insuficiente');
 if(!points.every((p,i)=>Number.isFinite(p.price)&&p.price>0&&Number.isFinite(Date.parse(p.at))&&Date.parse(p.at)<=now&&(!i||Date.parse(p.at)>Date.parse(points[i-1].at))))throw Error('Dataset inválido, futuro ou fora de ordem');
 const validationFrom=points[Math.floor(points.length*.5)].at,testFrom=points[Math.floor(points.length*.7)].at;
 const report={protocol,asset:id,source,datasetHash:digest(points),dataStart:points[0].at,dataEnd:points.at(-1).at,createdAt:new Date(now).toISOString(),validationFrom,testFrom,candidates:CANDIDATES,scenarioCount:SCENARIOS.length,horizons:{},limitations:['Histórico já examinado por versões anteriores; teste comparativo não é um período de mercado inédito.','Ativos e períodos podem ser correlacionados; muitas comparações aumentam a chance de resultados fortuitos.','Notícias históricas, volume, livro de ordens, ETFs e novos pools não são testados por este dataset horário.','Cenários sem observações ficam sem resultado, não são considerados aprovados.']},models={};
 for(const h of horizons){
  const samples=sampleBuilder(points,id,h),training=samples.filter(s=>s.labelKnownAt<validationFrom),validation=samples.filter(s=>s.at>=validationFrom&&s.labelKnownAt<testFrom),retrain=samples.filter(s=>s.labelKnownAt<testFrom),testing=samples.filter(s=>s.at>=testFrom);
  const validations=CANDIDATES.map(candidate=>{const model=fitCandidate(candidate,training,protocol.contextFeatureVersion);return {candidate,modelHash:digest(model),evaluation:evaluateCandidate(model,validation,id)};});
  const eligible=validations.filter(v=>v.evaluation.metrics.valid>=20&&v.evaluation.metrics.coverage>=.95&&v.evaluation.metrics.brier!=null);
  eligible.sort((a,b)=>a.evaluation.metrics.brier-b.evaluation.metrics.brier||a.candidate.localeCompare(b.candidate));
  const chosen=eligible[0]?.candidate??'train-prior';
  const comparisons=CANDIDATES.map(candidate=>{const model=fitCandidate(candidate,retrain,protocol.contextFeatureVersion);return {candidate,validation:validations.find(v=>v.candidate===candidate).evaluation,modelHash:digest(model),lastTrainingLabelAt:model.lastTrainingLabelAt,test:evaluateCandidate(model,testing,id)};});
  const winner=comparisons.find(v=>v.candidate===chosen),deployment=fitCandidate(chosen,samples,protocol.contextFeatureVersion);
  models[h]={...deployment,hash:digest(deployment),datasetHash:report.datasetHash,selectedBefore:testFrom};
  report.horizons[h]={chosen,deploymentRefitAfterEvaluation:true,deploymentModelHash:models[h].hash,selectionEligible:eligible.length>0,selection:eligible.length?'Menor Brier na validação; nenhuma escolha pelo resultado do teste':'Referência provisória do treino; amostra de validação insuficiente para escolher um método',comparisons,championTest:winner.test,learningPriorities:winner.test.scenarios.filter(s=>s.valid>=5).map(s=>({scenario:s.scenario,cases:s.valid,errors:s.valid-s.correct,accuracy:s.accuracy})).sort((a,b)=>b.errors-a.errors).slice(0,3),goal:goalEvidence(winner.test.metrics,winner.test.economics)};
 }
 report.summary={asset:id,protocol:protocol.id,horizonUnit:protocol.horizonUnit??'hours',datasetHash:report.datasetHash,source,candidateCount:CANDIDATES.length,dataStart:report.dataStart,dataEnd:report.dataEnd,createdAt:report.createdAt,horizons:Object.fromEntries(Object.entries(report.horizons).map(([h,v])=>[h,{chosen:v.chosen,selectionEligible:v.selectionEligible,metrics:v.championTest.metrics,economics:v.championTest.economics,goal:v.goal,scenariosObserved:v.championTest.scenarios.filter(s=>s.valid>0).length}]))};
 return {report,models};
}
