import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../lib/engine.mjs';
import { configurePortfolio, PROFILES } from '../lib/portfolio.mjs';
import { applyHistoricalDirection, fitHistoricalDirection } from '../lib/forecast-history.mjs';
import { advanceDirections } from '../lib/directions.mjs';
import { probability } from '../lib/research.mjs';
import { directionInput, digest, newScore, scoreOutcome, scoreView, PREDICTION_PROTOCOL } from '../lib/prediction-protocol.mjs';
import { directionEvidence, contextFor, learningPlan } from '../lib/learning.mjs';
const now=Date.parse('2026-10-24T16:00:00Z');
const history=()=>Array.from({length:400},(_,i)=>({at:new Date(now-(399-i)*3600000).toISOString(),price:100+i*.02+Math.sin(i/6)*2,historical:true}));
function state(){let s=initialState(1000);s.paused=true;s=configurePortfolio(s,{profile:'agressivo',...PROFILES.agressivo,allocations:{bitcoin:20},cryptoStrategy:'active'});return applyHistoricalDirection(s,fitHistoricalDirection(history(),'bitcoin',now),now).state;}
const quotes=(at=now,price=110)=>({bitcoin:{price,observedAt:new Date(at).toISOString(),volume24h:1e9}});
test('preço anterior ao horizonte não é avaliação; preço posterior válido é aceito',()=>{
 const first=advanceDirections(state(),quotes(),now),p=first.intelligence.directionPending.find(p=>p.horizon===1);
 const early=advanceDirections(first,quotes(now+3600000-1000,111),now+3600000+1000);assert.ok(early.intelligence.directionPending.some(v=>v.id===p.id));assert.equal(early.intelligence.directionByAsset.bitcoin[1].scored,0);
 const later=advanceDirections(early,quotes(now+3600000+120000,111),now+3600000+120000);assert.equal(later.intelligence.directionEvaluation.metrics[1].primary.valid,1);assert.ok(later.intelligence.directionOutcomes.find(v=>v.id===p.id).delaySeconds>=0);
});
test('fonte diferente, futuro ou janela expirada não ganham acertos; cobertura contabiliza falta',()=>{
 const first=advanceDirections(state(),quotes(),now),p=first.intelligence.directionPending.find(p=>p.horizon===1);
 const future=advanceDirections(first,quotes(now+3600000+2000,111),now+3600000+1000);assert.equal(future.intelligence.directionByAsset.bitcoin[1].scored,0);
 const changed=advanceDirections(first,{bitcoin:{...quotes(now+3600000).bitcoin,source:'other'}},now+3600000);assert.equal(changed.intelligence.directionByAsset.bitcoin[1].scored,0);
 const missing=advanceDirections(first,{},now+3600000+11*60000);assert.equal(missing.intelligence.directionEvaluation.metrics[1].primary.missing,1);assert.equal(missing.intelligence.directionEvaluation.metrics[1].primary.coverage,0);assert.ok(missing.intelligence.directionOutcomes.some(v=>v.id===p.id&&v.status==='missing-price'));
});
test('snapshot reproduz a probabilidade e deduplica observações da mesma hora sem aceitar futuro',()=>{
 const s=state(),q=quotes().bitcoin,input=directionInput('bitcoin',s.portfolio.bitcoin.observations,q,now);assert.equal(new Set(input.points.map(p=>p.at.slice(0,13))).size,input.points.length);
 const extra=directionInput('bitcoin',[...s.portfolio.bitcoin.observations,{at:new Date(now+1000).toISOString(),price:999999}],q,now);assert.equal(extra.hash,input.hash);
 const first=advanceDirections(s,quotes(),now),p=first.intelligence.directionPending[0];assert.equal(probability(p.modelSnapshot,p.vector),p.probability);assert.equal(digest(p.modelSnapshot),p.modelHash);assert.equal(p.protocolId,PREDICTION_PROTOCOL.id);assert.equal(p.inputHash,input.hash);
});
test('principal de 6h não mistura previsões sobrepostas; legado fica preservado',()=>{
 const s=state();s.intelligence.directionMetrics={1:{scored:10,correct:3,accuracy:.3}};
 const a=advanceDirections(s,quotes(),now),b=advanceDirections(a,quotes(now+3600000),now+3600000);
 assert.equal(b.intelligence.directionEvaluation.metrics[6].all.issued,2);assert.equal(b.intelligence.directionEvaluation.metrics[6].primary.issued,1);assert.equal(b.intelligence.directionEvaluation.legacy.metrics[1].accuracy,.3);
});
test('empates não viram acerto e previsões confiantes erradas perdem para 50%',()=>{
 const stats=newScore();stats.issued=3;scoreOutcome(stats,{probability:.9,baselines:{momentumUp:false}},{status:'scored',rawPct:-1});scoreOutcome(stats,{probability:.1,baselines:{momentumUp:true}},{status:'scored',rawPct:1});scoreOutcome(stats,{probability:.9},{status:'scored',rawPct:0});const view=scoreView(stats);
 assert.equal(view.valid,3);assert.equal(view.flat,1);assert.equal(view.accuracy,0);assert.ok(view.brierSkill<0);assert.equal(view.momentumAccuracy,2/3);assert.equal(view.calibration[9].n,1);assert.equal(view.calibration[9].observedUpRate,0);assert.ok(Number.isFinite(view.logLoss));
});
test('decisão referencia previsão registrada, sem recalcular outra probabilidade escondida',()=>{
 const first=advanceDirections(state(),quotes(),now),p=first.intelligence.latestDirectionalForecasts.bitcoin[1];first.intelligence.directionByAsset.bitcoin[1].weights.fill(-20);
 const evidence=directionEvidence(first,'bitcoin',quotes().bitcoin);assert.equal(evidence.probabilityUp,p.probability);assert.equal(evidence.forecastId,p.id);assert.equal(evidence.validated,false);
});
test('histórico tem teste sem sobreposição e quatro janelas temporais, sem alvos de treino cruzados',()=>{
 const result=fitHistoricalDirection(history(),'bitcoin',now);for(const h of [1,6,24]){assert.equal(result.report.walkForward[h].length,4);assert.ok(result.report.protocolMetrics[h].valid<=result.report.metrics[h].samples);for(const fold of result.report.walkForward[h])assert.ok(fold.trainThrough<fold.testFrom);}
});
test('família com perdas consistentes sofre bloqueio temporário mensurável, não aumento de risco',()=>{
 const s=state(),id='solana:'+'A'.repeat(32),q={price:1},context=contextFor(id,s,q,now);s.learning={assets:{},families:{[context.scenario]:{n:23,wins:2,sumNetPct:-150,sumR:-15,lastAt:new Date(now).toISOString()}}};const plan=learningPlan(s,id,q,{stopPct:8,takeProfitPct:16},now);assert.ok(Date.parse(plan.blockedUntil)>now);assert.ok(plan.evidence.familyAverageNetPct<0);assert.equal(learningPlan(s,id,q,{stopPct:8,takeProfitPct:16},now+7*3600000).blockedUntil,null);
});

test('um ID repetido não duplica avaliações nem treino',()=>{
 const first=advanceDirections(state(),quotes(),now),p=first.intelligence.directionPending.find(p=>p.horizon===1);first.intelligence.directionPending.push(structuredClone(p));const next=advanceDirections(first,quotes(now+3600000,111),now+3600000);assert.equal(next.intelligence.directionEvaluation.metrics[1].primary.valid,1);assert.equal(next.intelligence.directionByAsset.bitcoin[1].scored,1);
});

test('hash canônico resiste à reordenação JSONB e replay detecta adulteração',async()=>{
 const {auditForecast}=await import('../lib/prediction-protocol.mjs');const first=advanceDirections(state(),quotes(),now),p=first.intelligence.directionPending[0];const reversed=Object.fromEntries(Object.entries(p.modelSnapshot).reverse());assert.equal(digest(reversed),p.modelHash);assert.equal(auditForecast({...p,modelSnapshot:reversed}).valid,true);
 const changed=structuredClone(p);changed.vector[0]+=1;assert.equal(auditForecast(changed).valid,false);
 const result=advanceDirections({...first,intelligence:{...first.intelligence,directionPending:[changed]}},quotes(now+3600000),now+3600000);assert.equal(result.intelligence.directionOutcomes.at(-1).status,'invalid-forecast');assert.equal(result.intelligence.directionByAsset.bitcoin[1].scored,0);
});

test('histórico impreciso não usa ponto anterior ao alvo como resultado',()=>{
 const data=history().map((p,i)=>({...p,at:new Date(Date.parse(p.at)+(i%2?60000:0)).toISOString()}));const result=fitHistoricalDirection(data,'bitcoin',now+60000);assert.ok(result.report.protocolMetrics[1].missing>0);assert.ok(result.report.protocolMetrics[1].coverage<1);for(const fold of result.report.walkForward[1])assert.ok(fold.trainThrough<fold.testFrom);
});

test('importação respeita pausa do provedor e usa fonte alternativa identificada',async()=>{
 const {historicalDirection}=await import('../lib/forecast-history.mjs');const requested=[];const data={Response:'Success',Data:{Data:history().map(p=>({time:Date.parse(p.at)/1000-3600,close:p.price}))}};
 const result=await historicalDirection('bitcoin',async url=>{requested.push(url);return {ok:true,json:async()=>data};},now,{coinGeckoNotBefore:new Date(now+120000).toISOString()});assert.ok(requested.every(url=>!url.includes('coingecko')));assert.match(result.report.source,/CryptoCompare/);assert.ok(result.report.coinGeckoNotBefore);
});

test('Retry-After em data HTTP é respeitado, mesmo com sucesso na fonte alternativa',async()=>{
 const {historicalDirection}=await import('../lib/forecast-history.mjs');const retry=new Date(now+300000).toUTCString(),data={Response:'Success',Data:{Data:history().map(p=>({time:Date.parse(p.at)/1000-3600,close:p.price}))}};
 const result=await historicalDirection('bitcoin',async url=>url.includes('coingecko')?{ok:false,status:429,headers:{get:()=>retry}}:{ok:true,json:async()=>data},now);assert.equal(Date.parse(result.report.coinGeckoNotBefore),now+300000);
});
