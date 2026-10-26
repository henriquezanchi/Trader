import { armEntryEligible,exitProgress,resolveExitPlan } from './trend-exit.mjs';
import { fill,isETF } from './markets.mjs';
import { isPool } from './discovery.mjs';
import { digest } from './prediction-protocol.mjs';
import { EXPLORATION_ARMS,enabledExplorationArms } from './exploration.mjs';
export const ENTRY_POLICY=Object.freeze({id:'paper-entry-value-v1',explorationPct:20,minFit:20,minValidation:10,maxFit:40,maxValidation:20,maxAgeDays:30,baselineCashPct:0});
export const adaptiveEntries=s=>s.config?.simulationExploration===true&&s.config?.learningPolicy===ENTRY_POLICY.id;
const keyFor=(context,arm)=>context.scenario+'|'+arm;
const avg=rows=>rows.reduce((s,r)=>s+r.netPct,0)/rows.length;
function stats(rows,now){
 const known=(rows??[]).filter(r=>Date.parse(r.at)<=now&&Date.parse(r.at)>=now-ENTRY_POLICY.maxAgeDays*86400000&&Number.isFinite(r.netPct)),wins=known.filter(r=>r.netPct>0),losses=known.filter(r=>r.netPct<0),stress=known.filter(r=>Number.isFinite(r.stressPct));
 return {n:known.length,probabilityPositive:known.length?wins.length/known.length:null,averageGainPct:wins.length?avg(wins):null,averageLossPct:losses.length?-avg(losses):null,expectedNetPct:known.length?avg(known):null,stressN:stress.length,expectedStressNetPct:stress.length?stress.reduce((s,r)=>s+r.stressPct,0)/stress.length:null,withoutBestNetPct:known.length>1?(known.reduce((n,r)=>n+r.netPct,0)-Math.max(...known.map(r=>r.netPct)))/(known.length-1):null,withoutBestStressPct:stress.length>1?(stress.reduce((n,r)=>n+r.stressPct,0)-Math.max(...stress.map(r=>r.stressPct)))/(stress.length-1):null};
}
export function entryEvidence(state,context,now=Date.now()){
 const candidates=enabledExplorationArms(state).map(arm=>{const key=keyFor(context,arm.id),rows=state.learning?.entryEvidence?.[key],eligibility=armEntryEligible(state,context,arm,now);return {arm:{...arm,...(eligibility.eligible?resolveExitPlan(arm,eligibility.signal):{})},key,...eligibility,fit:stats(rows?.fit,now),validation:stats(rows?.validation,now)};});
 const trained=candidates.filter(c=>c.eligible&&c.fit.n>=ENTRY_POLICY.minFit).sort((a,b)=>b.fit.expectedNetPct-a.fit.expectedNetPct||a.arm.id.localeCompare(b.arm.id));
 const candidate=trained[0];
 const qualified=!!candidate&&candidate.fit.expectedNetPct>0&&candidate.fit.stressN>=ENTRY_POLICY.minFit&&candidate.fit.expectedStressNetPct>0&&candidate.validation.n>=ENTRY_POLICY.minValidation&&candidate.validation.expectedNetPct>0&&candidate.validation.stressN>=ENTRY_POLICY.minValidation&&candidate.validation.expectedStressNetPct>0&&candidate.fit.withoutBestNetPct>0&&candidate.fit.withoutBestStressPct>0&&candidate.validation.withoutBestNetPct>0&&candidate.validation.withoutBestStressPct>0;
 return {qualified,candidate:candidate??null,candidates,baselineCashPct:0,note:'Média líquida observada; validação reservada na entrada e excluída do ajuste. Sem garantia de lucro ou independência das amostras.'};
}
export function entryInformation(state,id,context,now=Date.now()){
 const evidence=entryEvidence(state,context,now),n=evidence.candidates.reduce((s,c)=>s+c.fit.n,0);
 const current=state.intelligence?.latestDirectionalForecasts?.[id]?.[1],challenger=state.intelligence?.scenarioLive?.pending?.filter(p=>p.asset===id&&p.horizon===1&&Date.parse(p.knownAt)<=now&&Date.parse(p.targetAt)>now).sort((a,b)=>Date.parse(b.knownAt)-Date.parse(a.knownAt))[0];
 const prior=current&&Date.parse(current.knownAt)<=now&&Date.parse(current.targetAt)>now?current:null;
 const disagreement=prior&&challenger&&Number.isFinite(prior.probability)&&Number.isFinite(challenger.probability)?Math.abs(prior.probability-challenger.probability):0;
 return {fitCases:n,disagreement,referenceForecastId:prior?.id??null,challengerForecastId:challenger?.id??null,challengerProtocol:challenger?(challenger.protocolId??'scenario-comparison-v1'):null,priority:evidence.qualified?1000000+evidence.candidate.fit.expectedNetPct:1/(1+n)+.25*disagreement,note:'Prioridade heurística de informação; não é probabilidade de ganho.'};
}
export function valueEntryPlan(state,id,quote,plan,now=Date.now()){
 if(!adaptiveEntries(state)||plan.entryBlocked)return plan;
 const evidence=entryEvidence(state,plan.context,now),exploit=evidence.qualified&&(state.config.learningExplorationPct??20)<100,definition=exploit?evidence.candidate.arm:EXPLORATION_ARMS.find(a=>a.id===plan.explorationArm),arm={...definition,...resolveExitPlan(definition,armEntryEligible(state,plan.context,definition,now).signal,{snapshot:true})},bucket=exploit?'exploit':'explore';
 const forecast=state.intelligence?.executionLive?.pending?.filter(p=>p.asset===id&&p.horizon===arm.maxMinutes&&Date.parse(p.knownAt)<=now&&Date.parse(p.targetAt)>now).sort((a,b)=>Date.parse(b.knownAt)-Date.parse(a.knownAt))[0];
 const phase=parseInt(digest({asset:id,slot:Math.floor(now/120000),policy:ENTRY_POLICY.id}).slice(0,8),16)%5===0?'validation':'fit';
 return {...plan,...arm,explorationArm:arm.id,entryBucket:bucket,entryPolicy:ENTRY_POLICY.id,evidence:{...plan.evidence,entryDecision:{policy:ENTRY_POLICY.id,bucket,phase,key:keyFor(plan.context,arm.id),shortForecast:forecast?{id:forecast.id,probabilityUp:forecast.probability,horizonMinutes:forecast.horizon,knownAt:forecast.knownAt,targetAt:forecast.targetAt,modelHash:forecast.modelHash}:null,baselineCashPct:0,evidence,information:entryInformation(state,id,plan.context,now),issuedAt:new Date(now).toISOString()},reason:bucket==='exploit'?`Aproveitar evidência: ${evidence.candidate.fit.n} casos de ajuste e ${evidence.candidate.validation.n} reservados, médias líquidas positivas após custos normais e estressados; alternativa ${arm.label}`:`Teste controlado: comparar compra com caixa (0% no período); sem vantagem líquida confirmada, usar somente a parcela de exploração. Alternativa ${arm.label}`}};
}
export function entryBudget(state,plan,equity,opportunities){
 const share=(state.config.learningExplorationPct??ENTRY_POLICY.explorationPct)/100,bucket=plan.entryBucket;
 const used=Object.values(state.fast?.positions??{}).filter(p=>p.quantity>0&&p.plan?.entryBucket===bucket).reduce((n,p)=>n+p.costBasis,0);
 const remaining=Math.max(0,equity*(bucket==='explore'?share:1-share)-used),ticket=Math.max(isPool(plan.context.asset)?5:1,equity*(bucket==='explore'?share:1-share)/Math.max(1,opportunities));
 return Math.max(0,Math.min(state.cash,remaining,ticket));
}
export function learnEntry(learning,entry,event,netPct,now){
 const decision=entry.evidence?.entryDecision;if(decision?.policy!==ENTRY_POLICY.id||!['fit','validation'].includes(decision.phase))return;
 const token=entry.id+':'+event.id;learning.entryScoredIds??=[];if(learning.entryScoredIds.includes(token))return;
 const rows=(learning.entryEvidence??={})[decision.key]??={fit:[],validation:[]};
 const exitPrice=event.price??event.quote?.price,entryPrice=entry.referencePrice;
 const marketPnl=Number.isFinite(entryPrice)&&Number.isFinite(exitPrice)?entry.quantity*(exitPrice-entryPrice):null;
 const costs=marketPnl==null?null:Math.max(0,marketPnl-event.realizedPnl),stressPct=costs==null?null:netPct-costs/entry.costBasis*100;
 rows[decision.phase]=[...rows[decision.phase],{at:new Date(now).toISOString(),netPct,stressPct}].slice(-(decision.phase==='fit'?ENTRY_POLICY.maxFit:ENTRY_POLICY.maxValidation));
 rows.updatedAt=new Date(now).toISOString();learning.entryScoredIds=[...learning.entryScoredIds,token].slice(-500);
 const keys=Object.keys(learning.entryEvidence);if(keys.length>150)for(const key of keys.sort((a,b)=>Date.parse(learning.entryEvidence[a].updatedAt)-Date.parse(learning.entryEvidence[b].updatedAt)).slice(0,keys.length-150))delete learning.entryEvidence[key];
}
export function advanceEntryReferences(state,quotes,now=Date.now()){
 if(!adaptiveEntries(state))return {created:[],outcomes:[]};
 const book=state.learning?.entryReferences??{pending:[],stats:{},created:0};state.learning??={assets:{},families:{},summaries:[],closed:0};state.learning.entryReferences=book;
 const waiting=[],outcomes=[],created=[],seen=new Set();
 for(const p of book.pending){
  if(seen.has(p.id))continue;seen.add(p.id);
  const q=quotes[p.asset],at=Date.parse(q?.observedAt),target=Date.parse(p.targetAt),valid=Number.isFinite(q?.price)&&q.price>0&&Number.isFinite(at)&&at<=now&&now-at<=120000&&at>Date.parse(p.priceAt)&&(q.source??(isPool(p.asset)?'geckoterminal-indicative':'coingecko'))===p.source&&(!isPool(p.asset)||Number.isFinite(q.liquidityBRL)&&q.liquidityBRL>0);
  const finish=(result)=>{outcomes.push({...p,...result});const s=book.stats[p.family+'|'+p.arm]??={known:0,missing:0,betterThanCash:0,sumNetPct:0};if(result.status==='scored'){s.known++;s.betterThanCash+=Number(result.netPct>0);s.sumNetPct+=result.netPct;}else s.missing++;};
  if(now>target+300000){finish({status:'missing-price',evaluatedAt:new Date(now).toISOString()});continue;}
  if(!valid){waiting.push(p);continue;}
  const exit=fill(p.asset,'VENDER',q.price,0,{quantity:p.quantity,costBasis:p.budget,liquidityBRL:q.liquidityBRL},now),netPct=exit.realizedPnl/p.budget*100;
  if(!Number.isFinite(netPct)){finish({status:'missing-price',evaluatedAt:new Date(now).toISOString(),reason:'Resultado de execução não finito'});continue;}
  const progress=exitProgress(p,p.exitTracking??{notBefore:p.knownAt,lastObservedAt:p.priceAt},netPct,q.observedAt);p.exitTracking=progress.tracking;
  if(at<target&&!progress.reason){waiting.push(p);continue;}
  finish({status:'scored',netPct,cashReturnPct:0,betterThanCash:netPct>0,actualObservedAt:q.observedAt,actualPrice:q.price,evaluatedAt:new Date(now).toISOString(),exitReason:progress.reason?(p.exitMode==='trailing'?'trailing':'target'):'time'});
 }
 const open=new Set(waiting.map(p=>p.asset+':'+p.arm)),ids=Object.keys(quotes).filter(id=>!isETF(id));
 for(const id of ids){const q=quotes[id],at=Date.parse(q?.observedAt);if(!Number.isFinite(q?.price)||q.price<=0||!Number.isFinite(at)||at>now||now-at>120000||isPool(id)&&!(Number.isFinite(q.liquidityBRL)&&q.liquidityBRL>0))continue;
  for(const arm of EXPLORATION_ARMS){if(open.has(id+':'+arm.id)||!armEntryEligible(state,{asset:id},arm,now).eligible)continue;
   const budget=isPool(id)?5:10,buy=fill(id,'COMPRAR',q.price,budget,{liquidityBRL:q.liquidityBRL},now);if(!(buy.quantity>0))continue;
   const sizing=resolveExitPlan(arm,armEntryEligible(state,{asset:id},arm,now).signal),resolved={...arm,...sizing};
   const p={id:`reference:${Math.floor(now/120000)}:${id}:${arm.id}`,asset:id,arm:arm.id,family:isPool(id)?'new-solana-pool':['bitcoin','ethereum'].includes(id)?'major-crypto':'liquid-altcoin',knownAt:new Date(now).toISOString(),priceAt:q.observedAt,price:q.price,budget,quantity:buy.quantity,targetAt:new Date(now+arm.maxMinutes*60000).toISOString(),takeProfitPct:resolved.takeProfitPct,exitMode:resolved.exitMode,trailingDrawdownPct:resolved.trailingDrawdownPct,exitSizing:resolved.exitSizing,source:q.source??(isPool(id)?'geckoterminal-indicative':'coingecko'),kind:'counterfactual-no-wallet',cashReturnPct:0};created.push(p);
  }
 }
 book.pending=[...waiting,...created].slice(-500);book.created+=created.length;book.updatedAt=new Date(now).toISOString();
 return {created,outcomes};
}
