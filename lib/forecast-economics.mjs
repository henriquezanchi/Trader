import { costs, isETF } from './markets.mjs';
import { isPool } from './discovery.mjs';
export const ECONOMIC_PROTOCOL=Object.freeze({id:'hourly-direction-cost-audit-v2',thresholds:[.5,.6],costStressMultiplier:2,position:'long-only, fixed-horizon exit, non-overlapping observations',scope:'diagnostic only; no intraperiod stops, taxes, order book or portfolio limits'});
export function netRoundTrip(rawPct,id,multiplier=1){
 if(isETF(id)||isPool(id))throw Error('Auditoria de previsão econômica restrita a criptoativos estabelecidos');
 if(!Number.isFinite(rawPct)||rawPct<=-100||!Number.isFinite(multiplier)||multiplier<=0)throw Error('Retorno ou custo inválido');
 const c=costs(id),fee=c.feeRate*multiplier,slip=c.slippageRate*multiplier;
 if(fee>=1||slip>=1)throw Error('Custo inválido');
 return ((1-fee)**2*(1-slip)/(1+slip)*(1+rawPct/100)-1)*100;
}
export function economicAudit(samples,id,returnPolicy=null){
 const rules=[{id:'model-up',threshold:.5},{id:'model-confident',threshold:.6},{id:'always-buy',threshold:null},...(returnPolicy?[{id:'expected-net',minExpectedNetPct:returnPolicy.minExpectedNetPct,stressRequired:true}]:[])];
 const policies=rules.map(rule=>{
  const selected=samples.filter(s=>rule.id==='expected-net'?Number.isFinite(s.expectedNetPct)&&s.expectedNetPct>rule.minExpectedNetPct&&Number.isFinite(s.expectedStressNetPct)&&s.expectedStressNetPct>0:rule.threshold===null||Number.isFinite(s.probability)&&s.probability>=rule.threshold);
  const known=selected.filter(s=>s.status==='scored'&&Number.isFinite(s.rawPct)&&s.rawPct> -100);
  let netSum=0,stressSum=0,grossSum=0,wins=0,directionalHits=0,gains=0,losses=0;
  for(const s of known){const net=netRoundTrip(s.rawPct,id),stress=netRoundTrip(s.rawPct,id,2);netSum+=net;stressSum+=stress;grossSum+=s.rawPct;wins+=Number(net>0);directionalHits+=Number(s.rawPct>0);if(net>0)gains+=net;else losses-=net;}
  return {...rule,eligible:samples.length,selected:selected.length,known:known.length,missing:selected.length-known.length,coverage:selected.length?known.length/selected.length:null,participation:samples.length?selected.length/samples.length:null,
   directionalHitRate:known.length?directionalHits/known.length:null,netWinRate:known.length?wins/known.length:null,
   meanRawPct:known.length?grossSum/known.length:null,meanNetPct:known.length?netSum/known.length:null,meanStressNetPct:known.length?stressSum/known.length:null,
   costDragPct:known.length?(grossSum-netSum)/known.length:null,profitFactor:losses>0?gains/losses:null,
   note:'Médias por operação hipotética com resultado conhecido; não são retorno da carteira nem expectativa garantida. Ausentes não são classificados como ganhos ou perdas.'};
 });
 return {protocol:ECONOMIC_PROTOCOL.id,costs:costs(id),breakEvenRawPct:((1+costs(id).slippageRate)/((1-costs(id).feeRate)**2*(1-costs(id).slippageRate))-1)*100,policies};
}
