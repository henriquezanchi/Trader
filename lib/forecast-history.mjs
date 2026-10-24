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
 const cutoff=points[Math.floor(points.length*.7)].at,report={asset:id,source:'Yahoo Finance · candles horários concluídos',importedAt:new Date(now).toISOString(),dataStart:points[0].at,dataEnd:points.at(-1).at,cutoff,points:points.length,hash:createHash('sha256').update(JSON.stringify(points)).digest('hex').slice(0,20),metrics:{},trainingCounts:{},model:'chronological-direction-v1',news:'Manchetes históricas não disponíveis: feature marcada como ausente, sem usar notícias futuras'};
 const banks={};
 for(const h of HORIZONS){
  const model=emptyDirection(),samples=[];
  for(let i=23;i+h<points.length;i++){
   const window=points.slice(Math.max(0,i-71),i+1),technical=indicators(window),end=points[i+h];
   if(!technical.continuous||Math.abs(Date.parse(end.at)-Date.parse(points[i].at)-h*3600000)>15*60000)continue;
   const rawPct=(end.price/points[i].price-1)*100;if(rawPct===0)continue;
   samples.push({at:points[i].at,targetAt:end.at,rawPct,vector:featureVector(id,technical,{available:false,count:0,score:0},null)});
  }
  const train=samples.filter(s=>s.targetAt<cutoff),test=samples.filter(s=>s.at>=cutoff);
  if(train.length<30||test.length<10)throw Error('Poucos exemplos fora da amostra para o horizonte '+h);
  for(const s of train)updateModel(model,{...s,probability:probability(model,s.vector)},s.rawPct);
  const positiveTrain=train.filter(s=>s.rawPct>0).length,baselineUp=positiveTrain>=train.length/2;
  let correct=0,brierSum=0,positive=0,negative=0,tp=0,tn=0,baselineCorrect=0;
  for(const s of test){const p=probability(model,s.vector),actual=s.rawPct>0,predicted=p>=.5;correct+=Number(predicted===actual);brierSum+=(p-Number(actual))**2;baselineCorrect+=Number(baselineUp===actual);if(actual){positive++;if(predicted)tp++;}else{negative++;if(!predicted)tn++;}}
  report.metrics[h]={samples:test.length,correct,accuracy:correct/test.length,balancedAccuracy:positive&&negative?(tp/positive+tn/negative)/2:null,brier:brierSum/test.length,baselineAccuracy:baselineCorrect/test.length,positiveCases:positive,negativeCases:negative,outOfSample:true};
  report.trainingCounts[h]=train.length;
  report.metrics[h].evaluationModelHash=createHash('sha256').update(JSON.stringify(model.weights)).digest('hex').slice(0,16);
  const deployed=emptyDirection();for(const sample of samples)updateModel(deployed,{...sample,probability:probability(deployed,sample.vector)},sample.rawPct);
  banks[h]={...emptyDirection(),weights:deployed.weights,trained:deployed.trained,historyHash:report.hash};
  report.metrics[h].deploymentRefitAfterEvaluation=true;
 }
 return {report,banks,points};
}
export function parseCoinGeckoHistory(body,now=Date.now()){
 if(!Array.isArray(body?.prices))throw Error('Histórico horário inválido');const slots=new Map();
 for(const [time,price] of body.prices){if(!Number.isFinite(time)||time>now||!Number.isFinite(price)||price<=0||price>=1e9)continue;const slot=Math.floor(time/3600000),old=slots.get(slot);if(!old||time>Date.parse(old.at))slots.set(slot,{at:new Date(time).toISOString(),observedAt:new Date(time).toISOString(),price,historical:true,source:'coingecko-hourly-observation'});}
 const points=[...slots.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-750);if(points.length<120)throw Error('Pouco histórico horário');return points;
}
export async function historicalDirection(id,fetcher=fetch,now=Date.now()){
 if(!Object.hasOwn(HISTORY_SYMBOLS,id))throw Error('Ativo sem fonte histórica configurada');
 const failures=[];
 try{
  const headers=process.env.COINGECKO_DEMO_API_KEY?{'x-cg-demo-api-key':process.env.COINGECKO_DEMO_API_KEY}:{};
  const res=await fetcher(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=brl&days=30`,{signal:AbortSignal.timeout(6500),headers});
  if(!res.ok)throw Error('CoinGecko HTTP '+res.status);
  const result=fitHistoricalDirection(parseCoinGeckoHistory(await res.json(),now),id,now);result.report.source='CoinGecko · observações históricas horárias em BRL';result.report.observationToleranceMinutes=15;return result;
 }catch(error){failures.push(error.name==='TimeoutError'?'CoinGecko tempo limite':error.message);}
 try{
  const res=await fetcher('https://query1.finance.yahoo.com/v8/finance/chart/'+HISTORY_SYMBOLS[id]+'?range=1mo&interval=60m',{signal:AbortSignal.timeout(6500),headers:{Accept:'application/json'}});if(!res.ok)throw Error('Yahoo HTTP '+res.status);return fitHistoricalDirection(parseHourlyHistory(await res.json(),id,now),id,now);
 }catch(error){failures.push(error.name==='TimeoutError'?'Yahoo tempo limite':error.message);}
 throw Error('Histórico ainda indisponível: '+failures.join('; '));
}

export function applyHistoricalDirection(previous,result,now=Date.now()){
 const s=structuredClone(previous),{report,banks,points}=result,id=report.asset;
 s.intelligence??={version:MODEL_VERSION,models:Object.fromEntries(HORIZONS.map(h=>[h,emptyDirection()])),pending:[],recentCohorts:[],metrics:Object.fromEntries(HORIZONS.map(h=>[h,{trained:0,scored:0,missed:0,brier:null,accuracy:null}]))};
 const r=s.intelligence;r.directionByAsset??={};r.history??={};
 if(r.history[id]?.hash===report.hash)return {state:previous,duplicate:true};
 const old=r.directionByAsset[id]??{};
 r.directionByAsset[id]=Object.fromEntries(HORIZONS.map(h=>[h,{...banks[h],scored:old[h]?.scored??0,correct:old[h]?.correct??0,brierSum:old[h]?.brierSum??0,netReturnSum:old[h]?.netReturnSum??0,missed:old[h]?.missed??0}]));r.history[id]=report;
 const p=s.portfolio?.[id];if(p&&!indicators(p.observations??[]).continuous){
  const merged=new Map(points.slice(-24).map(p=>[p.at.slice(0,13),p]));for(const point of p.observations??[])if(Date.parse(point.at)>now-24*3600000&&Date.parse(point.at)<=now)merged.set(point.at.slice(0,13),point);
  p.observations=[...merged.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-72);
 }
 s.events=[...s.events,{id:randomUUID(),at:new Date(now).toISOString(),asset:id,mode:'research',action:'TREINAR',reason:'Histórico público importado; treino e teste separados no tempo, com expurgo de alvos que cruzam o corte. Nenhuma ordem retroativa.',fee:0,equity:equity(s),parameters:{engine:'historical-direction-v1',cutoff:report.cutoff,featureNames:FEATURE_NAMES},indicators:{outOfSample:report.metrics},quote:{source:report.source,dataEnd:report.dataEnd}}].slice(-200);
 return {state:s,duplicate:false};
}
