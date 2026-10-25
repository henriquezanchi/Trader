import { fitExpectedReturn, expectedNet, expectedStressNet, returnError, RETURN_PROTOCOL } from './expected-return.mjs';
import { economicAudit, ECONOMIC_PROTOCOL } from './forecast-economics.mjs';
import { PREDICTION_PROTOCOL, directionInput, newScore, scoreOutcome, scoreView, digest } from './prediction-protocol.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { indicators, featureVector, FEATURE_NAMES } from './indicators.mjs';
import { probability, updateModel, HORIZONS, MODEL_VERSION } from './research.mjs';
import { equity } from './engine.mjs';
export const HISTORY_SYMBOLS={bitcoin:'BTC-BRL',ethereum:'ETH-BRL',solana:'SOL-BRL',binancecoin:'BNB-BRL',ripple:'XRP-BRL',cardano:'ADA-BRL',chainlink:'LINK-BRL','avalanche-2':'AVAX-BRL',polkadot:'DOT-BRL',litecoin:'LTC-BRL'};
export const emptyDirection=()=>({weights:FEATURE_NAMES.map(()=>0),trained:0,scored:0,brierSum:0,correct:0,netReturnSum:0,missed:0});
export function parseHourlyHistory(body,id,now=Date.now()){
 const r=body?.chart?.result?.[0];if(r?.meta?.symbol!==HISTORY_SYMBOLS[id]||r.meta.currency!=='BRL')throw Error('Histórico com ativo ou moeda incorretos');
 const closes=r.indicators?.quote?.[0]?.close??[],map=new Map();
 for(let i=0;i<(r.timestamp??[]).length;i++){const t=r.timestamp[i]*1000+3600000,p=closes[i];if(Number.isFinite(t)&&t<=now&&Number.isFinite(p)&&p>0&&p<1e9)map.set(t,{at:new Date(t).toISOString(),observedAt:new Date(t).toISOString(),price:p,historical:true,source:'yahoo-hourly-completed'});}
 const points=[...map.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-750);if(points.length<120)throw Error('Histórico insuficiente para separar treinamento e teste');return points;
}
export function fitHistoricalDirection(points,id,now=Date.now()){
 const cutoff=points[Math.floor(points.length*.7)].at,report={asset:id,source:'Yahoo Finance · candles horários concluídos',importedAt:new Date(now).toISOString(),dataStart:points[0].at,dataEnd:points.at(-1).at,cutoff,points:points.length,hash:digest(points).slice(0,20),metrics:{},trainingCounts:{},model:'chronological-direction-v2',news:'Manchetes históricas não disponíveis: feature marcada como ausente, sem usar notícias futuras'};
 const banks={};
 for(const h of HORIZONS){
  const model=emptyDirection(),samples=[];
  for(let i=23;i<points.length;i++){
   const at=Date.parse(points[i].at),target=at+h*3600000;if(target>Date.parse(points.at(-1).at))break;
   const window=points.slice(Math.max(0,i-71),i+1),input=directionInput(id,window,{price:points[i].price,observedAt:points[i].at},at);if(!input.ready)continue;
   let endIndex=i+1;while(endIndex<points.length&&Date.parse(points[endIndex].at)<target)endIndex++;
   const end=points[endIndex],valid=end&&Date.parse(end.at)<=target+PREDICTION_PROTOCOL.maxEvaluationDelayMs;
   const known=valid?Date.parse(end.at):target+PREDICTION_PROTOCOL.expiryDelayMs;if(known>Date.parse(points.at(-1).at))continue;
   samples.push({at:points[i].at,targetAt:new Date(target).toISOString(),labelKnownAt:new Date(known).toISOString(),status:valid?'scored':'missing-price',rawPct:valid?(end.price/points[i].price-1)*100:null,vector:input.vector,momentumUp:input.momentumUp});
  }
  const economicTrain=samples.filter(s=>s.labelKnownAt<cutoff),returnModel=fitExpectedReturn(economicTrain,id);
  const train=samples.filter(s=>s.labelKnownAt<cutoff&&s.status==='scored'&&s.rawPct!==0),test=samples.filter(s=>s.at>=cutoff);
  if(train.length<30||test.length<10)throw Error('Poucos exemplos fora da amostra para o horizonte '+h);
  for(const s of train)updateModel(model,{...s,probability:probability(model,s.vector)},s.rawPct);
  const positiveTrain=train.filter(s=>s.rawPct>0).length,baselineUp=positiveTrain>=train.length/2;
  let correct=0,brierSum=0,positive=0,negative=0,tp=0,tn=0,baselineCorrect=0;
  for(const s of test.filter(s=>s.status==='scored'&&s.rawPct!==0)){const p=probability(model,s.vector),actual=s.rawPct>0,predicted=p>=.5;correct+=Number(predicted===actual);brierSum+=(p-Number(actual))**2;baselineCorrect+=Number(baselineUp===actual);if(actual){positive++;if(predicted)tp++;}else{negative++;if(!predicted)tn++;}}
  const binaryN=positive+negative;report.metrics[h]={samples:binaryN,excludedFlat:test.length-binaryN,correct,accuracy:binaryN?correct/binaryN:null,balancedAccuracy:positive&&negative?(tp/positive+tn/negative)/2:null,brier:binaryN?brierSum/binaryN:null,baselineAccuracy:binaryN?baselineCorrect/binaryN:null,positiveCases:positive,negativeCases:negative,outOfSample:true};
  report.trainingCounts[h]=train.length;
  report.metrics[h].evaluationModelHash=createHash('sha256').update(JSON.stringify(model.weights)).digest('hex').slice(0,16);
  const deployed=emptyDirection();for(const sample of samples.filter(s=>s.status==='scored'&&s.rawPct!==0))updateModel(deployed,{...sample,probability:probability(deployed,sample.vector)},sample.rawPct);
  banks[h]={...emptyDirection(),weights:deployed.weights,trained:deployed.trained,historyHash:report.hash};
  report.metrics[h].deploymentRefitAfterEvaluation=true;
  const evaluate=(fitted,items,netModel)=>{const stats=newScore(),economicSamples=[];let lastTarget=-Infinity;for(const sample of items){if(Date.parse(sample.at)<lastTarget)continue;lastTarget=Date.parse(sample.labelKnownAt);const predicted=probability(fitted,sample.vector);const estimated=netModel?expectedNet(netModel,sample.vector):null;economicSamples.push({...sample,probability:predicted,expectedNetPct:estimated,expectedStressNetPct:expectedStressNet(estimated,id)});stats.issued++;scoreOutcome(stats,{probability:predicted,baselines:{momentumUp:sample.momentumUp}},{status:sample.status,rawPct:sample.rawPct});}const economics=economicAudit(economicSamples,id,netModel?RETURN_PROTOCOL:null);if(netModel)economics.returnForecast={protocol:RETURN_PROTOCOL,model:netModel,modelHash:digest(netModel),errors:returnError(economicSamples,netModel,id)};return {...scoreView(stats),economics};};
  report.protocolId=PREDICTION_PROTOCOL.id;report.protocolMetrics??={};report.protocolMetrics[h]=evaluate(model,test,returnModel);
  const folds=[];
  for(let k=0;k<4;k++){
   const trainEnd=points[Math.floor(points.length*(.5+k*.125))].at,testEnd=k===3?Infinity:Date.parse(points[Math.floor(points.length*(.625+k*.125))].at);
   const training=samples.filter(s=>s.labelKnownAt<trainEnd&&s.status==='scored'&&s.rawPct!==0),testing=samples.filter(s=>s.at>=trainEnd&&Date.parse(s.labelKnownAt)<=testEnd);
   if(training.length<30)continue;const candidate=emptyDirection();for(const sample of training)updateModel(candidate,{...sample,probability:probability(candidate,sample.vector)},sample.rawPct);
   folds.push({trainThrough:training.at(-1)?.labelKnownAt,testFrom:trainEnd,testThrough:Number.isFinite(testEnd)?new Date(testEnd).toISOString():report.dataEnd,modelHash:createHash('sha256').update(JSON.stringify(candidate.weights)).digest('hex').slice(0,20),metrics:evaluate(candidate,testing,fitExpectedReturn(samples.filter(s=>s.labelKnownAt<trainEnd),id))});
  }
  report.walkForward??={};report.walkForward[h]=folds;

 }
 return {report,banks,points};
}
export function parseCoinGeckoHistory(body,now=Date.now()){
 if(!Array.isArray(body?.prices))throw Error('Histórico horário inválido');const slots=new Map();
 for(const [time,price] of body.prices){if(!Number.isFinite(time)||time>now||!Number.isFinite(price)||price<=0||price>=1e9)continue;const slot=Math.floor(time/3600000),old=slots.get(slot);if(!old||time>Date.parse(old.at))slots.set(slot,{at:new Date(time).toISOString(),observedAt:new Date(time).toISOString(),price,historical:true,source:'coingecko-hourly-observation'});}
 const points=[...slots.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-750);if(points.length<120)throw Error('Pouco histórico horário');return points;
}
export function parseCompareHistory(body,now=Date.now()){
 if(body?.Response==='Error'||!Array.isArray(body?.Data?.Data))throw Error('CryptoCompare sem histórico horário válido');
 const points=body.Data.Data.flatMap(p=>{const at=p.time*1000+3600000;return Number.isFinite(at)&&at<=now&&Number.isFinite(p.close)&&p.close>0&&p.close<1e9?[{at:new Date(at).toISOString(),observedAt:new Date(at).toISOString(),price:p.close,historical:true,source:'cryptocompare-cccagg-hourly-close'}]:[];}).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-750);
 if(points.length<120)throw Error('CryptoCompare com poucos candles concluídos');return points;
}
export async function historicalDirection(id,fetcher=fetch,now=Date.now(),policy={}){
 if(!Object.hasOwn(HISTORY_SYMBOLS,id))throw Error('Ativo sem fonte histórica configurada');const failures=[];let notBefore=policy.coinGeckoNotBefore;
 if(!(Date.parse(notBefore)>now))try{
  const headers=process.env.COINGECKO_DEMO_API_KEY?{'x-cg-demo-api-key':process.env.COINGECKO_DEMO_API_KEY}:{};
  const res=await fetcher(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=brl&days=30`,{signal:AbortSignal.timeout(6500),headers});
  if(!res.ok){if(res.status===429){const retry=res.headers?.get?.('retry-after'),numeric=Number(retry),seconds=Number.isFinite(numeric)?numeric:(Date.parse(retry)-now)/1000;notBefore=new Date(now+Math.max(120,Number.isFinite(seconds)?seconds:120)*1000).toISOString();}throw Error('CoinGecko HTTP '+res.status);}
  const result=fitHistoricalDirection(parseCoinGeckoHistory(await res.json(),now),id,now);result.report.source='CoinGecko · observações históricas horárias em BRL';result.report.observationToleranceMinutes=5;result.report.evaluationSide='at-or-after-target';return result;
 }catch(error){failures.push(error.name==='TimeoutError'?'CoinGecko tempo limite':error.message);}
 else failures.push('CoinGecko em pausa até '+notBefore);
 try{
  const symbol=HISTORY_SYMBOLS[id].split('-')[0],res=await fetcher(`https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=BRL&limit=720&aggregate=1`,{signal:AbortSignal.timeout(5000),headers:{Accept:'application/json'}});
  if(!res.ok)throw Error('CryptoCompare HTTP '+res.status);const result=fitHistoricalDirection(parseCompareHistory(await res.json(),now),id,now);result.report.source='CryptoCompare CCCAGG · candles horários encerrados em BRL';if(notBefore)result.report.coinGeckoNotBefore=notBefore;return result;
 }catch(error){failures.push(error.name==='TimeoutError'?'CryptoCompare tempo limite':error.message);}
 try{
  const res=await fetcher('https://query1.finance.yahoo.com/v8/finance/chart/'+HISTORY_SYMBOLS[id]+'?range=1mo&interval=60m',{signal:AbortSignal.timeout(6500),headers:{Accept:'application/json'}});if(!res.ok)throw Error('Yahoo HTTP '+res.status);const result=fitHistoricalDirection(parseHourlyHistory(await res.json(),id,now),id,now);if(notBefore)result.report.coinGeckoNotBefore=notBefore;return result;
 }catch(error){failures.push(error.name==='TimeoutError'?'Yahoo tempo limite':error.message);}
 const error=Error('Histórico ainda indisponível: '+failures.join('; '));error.coinGeckoNotBefore=notBefore;throw error;
}

export function applyHistoricalDirection(previous,result,now=Date.now()){
 const s=structuredClone(previous),{report,banks,points}=result,id=report.asset;
 s.intelligence??={version:MODEL_VERSION,models:Object.fromEntries(HORIZONS.map(h=>[h,emptyDirection()])),pending:[],recentCohorts:[],metrics:Object.fromEntries(HORIZONS.map(h=>[h,{trained:0,scored:0,missed:0,brier:null,accuracy:null}]))};
 const r=s.intelligence;if(report.coinGeckoNotBefore)s.historySourcePolicy={coinGeckoNotBefore:report.coinGeckoNotBefore};r.directionByAsset??={};r.history??={};
 if(r.history[id]?.hash===report.hash&&r.history[id]?.protocolId===report.protocolId){
  if(r.history[id]?.protocolMetrics?.[1]?.economics?.protocol===ECONOMIC_PROTOCOL.id&&r.history[id]?.protocolMetrics?.[1]?.economics?.returnForecast?.protocol?.id===RETURN_PROTOCOL.id)return {state:previous,duplicate:true};
  // Enrich the audit of the same dataset without resetting online coefficients,
  // pending forecasts, financial state, or the original import timestamp.
  r.history[id]={...r.history[id],protocolMetrics:report.protocolMetrics,walkForward:report.walkForward,economicAuditedAt:new Date(now).toISOString()};
  s.researchDelta={asOf:new Date(now).toISOString(),kind:'historical-cost-audit',historyTraining:{protocol:PREDICTION_PROTOCOL,report:r.history[id],observations:points,models:r.directionByAsset[id]}};
  return {state:s,duplicate:false};
 }
 const old=r.directionByAsset[id]??{};
 r.directionByAsset[id]=Object.fromEntries(HORIZONS.map(h=>[h,{...banks[h],scored:old[h]?.scored??0,correct:old[h]?.correct??0,brierSum:old[h]?.brierSum??0,netReturnSum:old[h]?.netReturnSum??0,missed:old[h]?.missed??0}]));r.history[id]=report;
 const p=s.portfolio?.[id];if(p&&!indicators(p.observations??[]).continuous){
  const merged=new Map(points.slice(-24).map(p=>[p.at.slice(0,13),p]));for(const point of p.observations??[])if(Date.parse(point.at)>now-24*3600000&&Date.parse(point.at)<=now)merged.set(point.at.slice(0,13),point);
  p.observations=[...merged.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-72);
 }
 s.events=[...s.events,{id:randomUUID(),at:new Date(now).toISOString(),asset:id,mode:'research',action:'TREINAR',reason:'Histórico público importado; treino e teste separados no tempo, com expurgo de alvos que cruzam o corte. Nenhuma ordem retroativa.',fee:0,equity:equity(s),parameters:{engine:'historical-direction-v2',protocolId:report.protocolId,dataHash:report.hash,cutoff:report.cutoff,featureNames:FEATURE_NAMES},indicators:{outOfSample:report.metrics,protocolMetrics:report.protocolMetrics,walkForward:report.walkForward},quote:{source:report.source,dataEnd:report.dataEnd}}].slice(-200);
 s.researchDelta={asOf:new Date(now).toISOString(),kind:'historical-revalidation',historyTraining:{protocol:PREDICTION_PROTOCOL,report,observations:points,models:banks}};
 return {state:s,duplicate:false};
}

export async function commitHistoricalDirection(repo,result,now=Date.now()){
 for(let attempt=0;attempt<3;attempt++){
  const latest=await repo.read(),applied=applyHistoricalDirection(latest.state,result,now);
  if(applied.duplicate)return {state:latest.state,version:latest.version,duplicate:true};
  try{await repo.commit(latest.version,applied.state);return {state:applied.state,version:latest.version+1,duplicate:false};}
  catch(error){if(!error.message.includes('Outra execução')||attempt===2)throw error;}
 }
}

export async function rememberHistoryBackoff(repo,until){
 if(!until)return;
 for(let attempt=0;attempt<3;attempt++){const latest=await repo.read(),s=structuredClone(latest.state);s.historySourcePolicy={coinGeckoNotBefore:until};try{await repo.commit(latest.version,s);return;}catch(error){if(!error.message.includes('Outra execução')||attempt===2)throw error;}}
}
