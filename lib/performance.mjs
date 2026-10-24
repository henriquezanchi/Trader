import { randomUUID } from 'node:crypto';
import { equity } from './engine.mjs';
import { localDate, businessDay } from './markets.mjs';
export function upgradeCapital(previous, now=Date.now()) {
 if(previous.capitalUpgrade?.target===1000)return previous;
 if(!Number.isFinite(previous.initialCapital)||previous.initialCapital<=0||previous.initialCapital>1000)throw Error('Capital incompatível com o aporte virtual');
 const s=structuredClone(previous), before=equity(s), amount=1000-s.initialCapital;
 s.capitalUpgrade={at:new Date(now).toISOString(),target:1000,amount,previousCapital:s.initialCapital,equityBefore:before,resultBefore:before-s.initialCapital};
 s.cash+=amount;s.initialCapital=1000;if(s.dayEquity!=null)s.dayEquity+=amount;
 s.performance={startedAt:new Date(now).toISOString(),startingEquity:equity(s),peak:equity(s),maxDrawdownPct:0,cdi:{rates:[]},samples:[]};
 s.events=[...s.events,{id:randomUUID(),at:new Date(now).toISOString(),action:'APORTE',reason:'Aporte virtual para elevar o capital contribuído a R$ 1.000; não é lucro',amount,fee:0,equity:equity(s),parameters:{kind:'virtual-capital',previousCapital:previous.initialCapital,target:1000},before:{cash:previous.cash,equity:before},after:{cash:s.cash,equity:equity(s)}}].slice(-200);
 return s;
}
export function parseCDI(rows, now) {
 if(!Array.isArray(rows))throw Error('CDI inválido');const map=new Map();
 for(const row of rows){const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(row.data??'');const rate=Number(String(row.valor).replace(',','.'));if(!match||!Number.isFinite(rate)||rate<0||rate>1)continue;const date=`${match[3]}-${match[2]}-${match[1]}`;if(!Number.isFinite(Date.parse(date))||date>localDate(now))continue;map.set(date,{date,ratePct:rate});}
 const rates=[...map.values()].sort((a,b)=>a.date.localeCompare(b.date));if(!rates.length)throw Error('CDI sem observações válidas');return rates;
}
export async function updatePerformance(previous, fetcher=fetch, now=Date.now()) {
 if(!previous.performance)return previous;const s={...previous,performance:structuredClone(previous.performance)},p=s.performance;
 if(p.cdi.attemptDate!==localDate(now) || p.cdi.status!=='ok' && now-Date.parse(p.cdi.attemptAt??0)>3600000){
  try{
    const from=new Date(Date.parse(p.startedAt)-7*86400000),to=new Date(now);
    const br=d=>`${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${d.getUTCFullYear()}`;
    const url=new URL('https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados');url.searchParams.set('formato','json');url.searchParams.set('dataInicial',br(from));url.searchParams.set('dataFinal',br(to));
    const response=await fetcher(url.href,{signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}});
    if(!response.ok){const error=Error('BCB HTTP '+response.status);error.name='ProviderHTTPError';throw error;}
    const rates=parseCDI(await response.json(),now),merged=new Map([...p.cdi.rates,...rates].map(r=>[r.date,r]));p.cdi.rates=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date));p.cdi.status='ok';p.cdi.error=null;p.cdi.updatedAt=new Date(now).toISOString();
  }catch(error){p.cdi.status='indisponível';p.cdi.error=error.name==='ProviderHTTPError'?error.message:error.name==='TimeoutError'?'Tempo limite da fonte BCB':'Fonte BCB sem resposta válida';}
  p.cdi.attemptDate=localDate(now);p.cdi.attemptAt=new Date(now).toISOString();
 }
 const value=equity(s);p.peak=Math.max(p.peak,value);p.maxDrawdownPct=Math.max(p.maxDrawdownPct,(1-value/p.peak)*100);
 // Contributions start accruing on the following published business day; never project rates.
 const eligible=p.cdi.rates.filter(r=>r.date>localDate(Date.parse(p.startedAt))&&r.date<localDate(now));
 const factor=eligible.reduce((v,r)=>v*(1+r.ratePct/100),1);p.cdi.equity=1000*factor;p.cdi.days=eligible.length;p.cdi.through=eligible.at(-1)?.date??null;
 const known=new Set(eligible.map(r=>r.date));let complete=true;for(let t=Date.parse(localDate(Date.parse(p.startedAt))+'T12:00:00Z')+86400000;t<now&&localDate(t)<localDate(now);t+=86400000){const date=localDate(t);if(businessDay(date)&&!known.has(date))complete=false;}p.cdi.complete=complete;
 p.netPnl=value-s.initialCapital;p.returnSinceUpgradePct=(value/p.startingEquity-1)*100;p.versusCDI=complete?value-p.cdi.equity:null;
 p.elapsedDays=(now-Date.parse(p.startedAt))/86400000;p.conclusion=p.elapsedDays<30?'Amostra insuficiente: acompanhar ao menos 30 dias; ganhos de simulação não validam lucro real':!complete?'Dados de CDI incompletos: comparação ainda indisponível':p.netPnl>0&&p.versusCDI>0?'Resultado positivo no período simulado; conferir risco, custos e consistência antes de decidir':'Ainda sem evidência de vantagem líquida sobre a referência';
 const slot=new Date(now).toISOString().slice(0,13);p.samples=[...p.samples.filter(x=>x.slot!==slot),{slot,equity:value,cdi:p.cdi.equity}].slice(-1000);p.updatedAt=new Date(now).toISOString();return s;
}
