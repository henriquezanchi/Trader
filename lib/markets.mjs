import { isPool } from './discovery.mjs';
// Public indicative data. No broker credentials or live order submission.
import { indicators } from './indicators.mjs';
export const ETF_IDS = ['bova11', 'ivvb11', 'smal11', 'divo11', 'gold11', 'xfix11'];
export const isETF = id => ETF_IDS.includes(id);
export const localDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(now));
// Conservative overlap of B3 continuous trading hours; auctions excluded.
const holidays = new Set(['2026-01-01','2026-02-16','2026-02-17','2026-02-18','2026-04-03','2026-04-21','2026-05-01','2026-06-04','2026-09-07','2026-10-12','2026-11-02','2026-11-20','2026-12-24','2026-12-25','2026-12-31','2027-01-01','2027-02-08','2027-02-09','2027-02-10','2027-03-26','2027-04-21','2027-05-01','2027-05-27','2027-09-07','2027-10-12','2027-11-02','2027-11-15','2027-11-20','2027-12-24','2027-12-25','2027-12-31']);
export function businessDay(date) { const day = new Date(date+'T12:00:00Z').getUTCDay(); return [2026,2027].includes(Number(date.slice(0,4))) && day!==0 && day!==6 && !holidays.has(date); }
export function marketOpen(now) { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(p=>[p.type,p.value])); const min=Number(parts.hour)*60+Number(parts.minute); return businessDay(localDate(now)) && min>=605 && min<1005; }
export function settlementDate(now) { let d=localDate(now), n=0; for(let i=0;i<20;i++){d=new Date(Date.parse(d+'T12:00:00Z')+86400000).toISOString().slice(0,10);if(businessDay(d)&&++n===2)return d;}throw new Error('Calendário B3 indisponível para liquidação'); }
export function releaseSettlement(s, now) { const pending=[]; for(const item of s.unsettled??[]) { if(item.date<=localDate(now))s.cash+=item.amount;else pending.push(item); }s.unsettled=pending; }
export function etfBlock(q,now) {
 if(!marketOpen(now)) return 'Fora da janela simulada da B3 (10h05–16h45 de Brasília em dias de pregão; calendário 2026–2027)';
 if(!q || q.unavailable || !Number.isFinite(q.price)||q.price<=0) return q?.error??'Cotação do ETF indisponível';
 const age=now-Date.parse(q.observedAt);if(!Number.isFinite(age)||age<0||age>20*60000||localDate(Date.parse(q.observedAt))!==localDate(now))return 'Cotação do ETF atrasada mais de 20 minutos ou de outro pregão';
 return null;
}
export function dailyIndicators(history,now) {
 const today=localDate(now), points=(history??[]).filter(p=>Number.isFinite(p.price)&&p.price>0&&Number.isFinite(Date.parse(p.at))&&localDate(Date.parse(p.at))<today).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).filter((p,i,a)=>!i||localDate(Date.parse(p.at))!==localDate(Date.parse(a[i-1].at))).slice(-72);
 const result=indicators(points), recent=points.slice(-24);
 return {...result,continuous:recent.length===24&&recent.every((p,i)=>!i||Date.parse(p.at)-Date.parse(recent[i-1].at)<=7*86400000),timeframe:'pregões diários concluídos',return1hPct:null,return6hPct:null};
}
export function costs(id) { return isPool(id)?{feeRate:.003,slippageRate:.01,transferTaxRate:.01,networkFeeBRL:.15,impactModel:'constant-product-reserve-v1',executionVerified:false,lot:null}:isETF(id)?{feeRate:.0003,slippageRate:.0005,brokerage:0,lot:1}:{feeRate:.001,slippageRate:.001,brokerage:0,lot:null}; }
export function fill(id, action, price, budget, holding, now) {
 const c=costs(id);
 if(isPool(id)){
  const side=Math.max(.000001,(holding.liquidityBRL??0)/2),notional=action==='COMPRAR'?budget:holding.quantity*price;
  if(action==='COMPRAR'){
   const available=Math.max(0,budget-c.networkFeeBRL),netIn=available*(1-c.feeRate),executionPrice=price*(1+netIn/side)/(1-c.slippageRate),quantity=netIn*(1-c.transferTaxRate)/executionPrice;
   return {...c,quantity,fee:c.networkFeeBRL+available*c.feeRate+netIn*c.transferTaxRate,executionPrice,realizedPnl:null,estimatedTax:0,impactPct:netIn/side*100,cashChange:-budget};
  }
  const gross=side*(notional/(side+notional))*(1-c.slippageRate),executionPrice=holding.quantity>0?gross/holding.quantity:price,credit=Math.max(0,gross*(1-c.feeRate)*(1-c.transferTaxRate)-c.networkFeeBRL);
  return {...c,quantity:holding.quantity,fee:gross-credit,executionPrice,realizedPnl:holding.costBasis==null?null:credit-holding.costBasis,estimatedTax:0,impactPct:notional/(side+notional)*100,cashChange:credit};
 }
 const executionPrice=price*(action==='COMPRAR'?1+c.slippageRate:1-c.slippageRate);
 const quantity=action==='VENDER'?holding.quantity:isETF(id)?Math.floor(budget/(executionPrice*(1+c.feeRate))):(budget*(1-c.feeRate))/executionPrice;
 const gross=quantity*executionPrice, fee=action==='COMPRAR'&&!isETF(id)?budget*c.feeRate:gross*c.feeRate;
 const debit=gross+fee;
 const realizedPnl=action==='VENDER'&&holding.costBasis!=null?gross-fee-holding.costBasis:null;
 const taxRate=isETF(id)&&action==='VENDER'?(holding.acquiredDate===localDate(now)?.20:.15):0;
 const estimatedTax=taxRate*Math.max(0,realizedPnl??0);
 return {...c,quantity,fee,executionPrice,realizedPnl,taxRate,estimatedTax,cashChange:action==='COMPRAR'?isETF(id)?-debit:-budget:gross-fee-estimatedTax};
}
export function parseETF(data,id,now) {
 const r=data?.chart?.result?.[0],m=r?.meta;
 if(m?.symbol!==id.toUpperCase()+'.SA'||m.currency!=='BRL'||!Number.isFinite(m.regularMarketPrice)||m.regularMarketPrice<=0||!Number.isFinite(m.regularMarketTime)||m.regularMarketTime*1000>now)throw new Error('Resposta de mercado inválida');
 const closes=r.indicators?.quote?.[0]?.close??[], history=(r.timestamp??[]).flatMap((t,i)=>Number.isFinite(t)&&Number.isFinite(closes[i])&&closes[i]>0&&t*1000<=now?[{at:new Date(t*1000).toISOString(),price:closes[i]}]:[]);
 return {price:m.regularMarketPrice,observedAt:new Date(m.regularMarketTime*1000).toISOString(),source:'yahoo-finance-indicative',delayMinutes:20,history};
}
export async function getETFs(ids,fetcher=fetch,now=Date.now()) {
 return Object.fromEntries(await Promise.all(ids.map(async id=>{
 try { const res=await fetcher(`https://query1.finance.yahoo.com/v8/finance/chart/${id.toUpperCase()}.SA?range=3mo&interval=1d`,{signal:AbortSignal.timeout(6500),headers:{Accept:'application/json'}});if(!res.ok)throw Error();return [id,parseETF(await res.json(),id,now)]; }
 catch{return [id,{unavailable:true,error:'Fonte indicativa do ETF indisponível; nenhuma ordem executada'}];}
 })));
}
