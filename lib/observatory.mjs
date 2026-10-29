import {createHash} from 'node:crypto';
import {parseNews} from './news.mjs';
import {fill,costs} from './markets.mjs';
export const OBS_PROTOCOL=Object.freeze({id:'public-tips-prospective-v1',stakeBRL:1000,entryGraceMinutes:30,exitGraceMinutes:10,maxRecommendations:500,selectionDays:14,confirmationDays:14,minSelection:20,minConfirmation:10,assets:['bitcoin','ethereum','solana','binancecoin','ripple','cardano','chainlink','avalanche-2','polkadot','litecoin'],horizons:[60,360,1440,10080]});
export const OBS_SOURCES=Object.freeze([
 {id:'coindesk',name:'CoinDesk',domain:'coindesk.com'}, {id:'cointelegraph',name:'Cointelegraph',domain:'cointelegraph.com'},
 {id:'decrypt',name:'Decrypt',domain:'decrypt.co'}, {id:'beincrypto',name:'BeInCrypto',domain:'beincrypto.com'}, {id:'criptofacil',name:'CriptoFácil',domain:'criptofacil.com'},
]);
const publisherKey=v=>String(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const iso=t=>new Date(t).toISOString();
const text=(v,min,max,label)=>{if(typeof v!=='string'||v.trim().length<min||v.length>max)throw Error(label+' inválido');return v.trim();};
export function validateTip(body,now=Date.now()){
 const source=OBS_SOURCES.find(s=>s.id===body.sourceId);if(!source)throw Error('Selecione uma fonte pré-definida');
 const author=text(body.author,2,100,'Autor ou entidade responsável'),excerpt=text(body.excerpt,20,2000,'Trecho original'),rationale=text(body.rationale,10,1000,'Critério de avaliação');
 let url;try{url=new URL(body.url);}catch{throw Error('URL inválida');}
 if(url.protocol!=='https:'||url.username||url.password||url.href.length>1500||!(url.hostname===source.domain||url.hostname.endsWith('.'+source.domain)||url.hostname==='news.google.com'))throw Error('Use o link HTTPS da fonte selecionada ou da candidata no Google Notícias');
 if(!OBS_PROTOCOL.assets.includes(body.asset)||!['COMPRAR','VENDER'].includes(body.direction)||!OBS_PROTOCOL.horizons.includes(Number(body.horizonMinutes)))throw Error('Ativo, direção ou prazo não suportado');
 const published=Date.parse(body.publishedAt);if(!Number.isFinite(published)||published>now||now-published>86400000)throw Error('A dica deve ter sido publicada nas últimas 24 horas; dicas antigas não recebem resultado retroativo');
 if(body.reviewed!==true||!['author','standardized'].includes(body.horizonBasis))throw Error('Confirme a leitura e informe se o prazo é do autor ou padronizado para o teste');
 url.hash='';const snapshot={protocol:OBS_PROTOCOL.id,sourceId:source.id,sourceName:source.name,author,url:url.href,publishedAt:iso(published),excerpt,rationale,asset:body.asset,direction:body.direction,horizonMinutes:Number(body.horizonMinutes),horizonBasis:body.horizonBasis,reviewed:true,verification:'user-reviewed-excerpt; publisher is not necessarily the author',costAssumptions:costs(body.asset),stakeBRL:OBS_PROTOCOL.stakeBRL};
 return {id:hash([source.id,url.href,author.toLowerCase(),body.asset,body.direction]),snapshot:{...snapshot,snapshotHash:hash(snapshot)}};
}
function validQuote(q,now,notBefore){const at=Date.parse(q?.observedAt);return Number.isFinite(q?.price)&&q.price>0&&Number.isFinite(at)&&at>=notBefore&&at<=now&&now-at<=120000&&(!q.source||q.source==='coingecko');}
export function advanceTip(row,quotes,now=Date.now()){
 const s=row.snapshot,p=row.evaluation??{status:'awaiting-entry'},registered=Date.parse(row.registered_at),q=quotes[s.asset];
 if(['scored','missing-entry','missing-exit'].includes(p.status))return null;
 if(p.status==='awaiting-entry'){
  if(now>registered+OBS_PROTOCOL.entryGraceMinutes*60000)return {status:'missing-entry',evaluatedAt:iso(now),reason:'Nenhuma cotação posterior ao registro dentro de 30 minutos; não inventar entrada'};
  if(!validQuote(q,now,registered))return null;
  const buy=fill(s.asset,'COMPRAR',q.price,OBS_PROTOCOL.stakeBRL,{},now);
  return {status:'tracking',entry:{price:q.price,observedAt:q.observedAt,collectedAt:iso(now),source:'coingecko',quantity:buy.quantity,fee:buy.fee,executionPrice:buy.executionPrice},targetAt:iso(Date.parse(q.observedAt)+s.horizonMinutes*60000),startedAt:iso(now)};
 }
 const target=Date.parse(p.targetAt);
 if(now>target+OBS_PROTOCOL.exitGraceMinutes*60000)return {...p,status:'missing-exit',evaluatedAt:iso(now),reason:'Sem cotação válida nos dez minutos após o prazo; manter ausência no denominador'};
 if(!validQuote(q,now,target)||now<target)return null;
 const sale=fill(s.asset,'VENDER',q.price,0,{quantity:p.entry.quantity,costBasis:OBS_PROTOCOL.stakeBRL},now),buyHoldPct=sale.realizedPnl/OBS_PROTOCOL.stakeBRL*100,rawPct=(q.price/p.entry.price-1)*100;
 // SELL means preserving cash instead of buying; never invent a short sale or an owned position.
 return {...p,status:'scored',evaluatedAt:iso(now),exit:{price:q.price,observedAt:q.observedAt,source:'coingecko',executionPrice:sale.executionPrice,fee:sale.fee},rawPct,buyHoldPct,cashPct:0,strategyPct:s.direction==='COMPRAR'?buyHoldPct:0,edgeVsBuyHoldPct:s.direction==='COMPRAR'?0:-buyHoldPct,directionCorrect:s.direction==='COMPRAR'?rawPct>0:rawPct<0,interpretation:s.direction==='VENDER'?'Evitar compra e permanecer em caixa; não é lucro de venda a descoberto':'Comprar no primeiro preço posterior ao registro e sair no prazo fixo'};
}
const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
export function observatoryReport(book,now=Date.now()){
 const rows=book.recommendations??[],cut=Date.parse(book.campaign.selection_ends),end=Date.parse(book.campaign.capture_ends),groups=new Map();
 for(const r of rows){const s=r.snapshot,key=s.sourceId+'|'+s.author.toLowerCase()+'|'+s.horizonBasis+'|'+s.horizonMinutes;if(!groups.has(key))groups.set(key,{key,source:s.sourceName,author:s.author,horizonMinutes:s.horizonMinutes,horizonBasis:s.horizonBasis,selection:[],confirmation:[]});groups.get(key)[r.phase].push(r);}
 const metrics=(a,selection)=>{
  const known=a.filter(r=>r.evaluation.status==='scored'&&(!selection||Date.parse(r.evaluation.evaluatedAt)<=cut)),net=known.map(r=>r.evaluation.strategyPct),positive=net.filter(n=>n>0),negative=net.filter(n=>n<0),sum=a=>a.reduce((s,n)=>s+n,0);
  let peak=0,cumulative=0,drawdown=0;for(const n of known.sort((a,b)=>Date.parse(a.evaluation.evaluatedAt)-Date.parse(b.evaluation.evaluatedAt)).map(r=>r.evaluation.strategyPct)){cumulative+=n;peak=Math.max(peak,cumulative);drawdown=Math.max(drawdown,peak-cumulative);}
  return {registered:a.length,evaluated:known.length,missing:a.filter(r=>r.evaluation.status.startsWith('missing')).length,coverage:a.length?known.length/a.length:null,accuracy:known.length?known.filter(r=>r.evaluation.directionCorrect).length/known.length:null,meanNetPct:avg(net),sumNormalizedNetPct:sum(net),meanBuyHoldPct:avg(known.map(r=>r.evaluation.buyHoldPct)),meanBotPct:avg(known.filter(r=>Number.isFinite(r.evaluation.botPct)).map(r=>r.evaluation.botPct)),botComparable:known.filter(r=>Number.isFinite(r.evaluation.botPct)).length,profitFactor:negative.length?sum(positive)/-sum(negative):null,worstPct:net.length?Math.min(...net):null,drawdownNormalizedPct:drawdown,note:'Tickets independentes de R$ 1.000; soma e drawdown não são retorno de uma carteira financiável. Dicas podem se sobrepor.'};
 };
 const sources=[...groups.values()].map(g=>{
  const selection=metrics(g.selection,true),confirmation=metrics(g.confirmation,false);
  const selected=now>=cut&&selection.evaluated>=OBS_PROTOCOL.minSelection&&selection.coverage>=.95&&selection.meanNetPct>0&&selection.meanNetPct>Math.max(0,selection.meanBuyHoldPct??0)&&(selection.profitFactor>=1.2||selection.profitFactor===null&&selection.worstPct>0);
  return {key:g.key,source:g.source,author:g.author,horizonMinutes:g.horizonMinutes,horizonBasis:g.horizonBasis,selection,confirmation,selected,confirmed:selected&&now>=end+10080*60000&&confirmation.evaluated>=OBS_PROTOCOL.minConfirmation&&confirmation.coverage>=.95&&confirmation.meanNetPct>0&&confirmation.meanNetPct>Math.max(0,confirmation.meanBuyHoldPct??0)&&(confirmation.profitFactor>=1.2||confirmation.profitFactor===null&&confirmation.worstPct>0)};
 }).sort((a,b)=>(b.selection.meanNetPct??-Infinity)-(a.selection.meanNetPct??-Infinity));
 return {...book,sources,protocol:OBS_PROTOCOL,registry:OBS_SOURCES,asOf:iso(now),notes:['Fontes editoriais não equivalem a gurus: o autor precisa ser identificado na dica.','Nenhuma dica movimenta a carteira ou altera o bot. Não existe aprovação automática para dinheiro real.','Seleção e confirmação têm datas fixas. Resultados de seleção conhecidos após o corte não elegem uma fonte.','Método de prazo fixo; não reproduz stops, alvos ou preço anunciado pelo autor.']};
}
export async function collectTipCandidates(fetcher=fetch,now=Date.now()){
 const sources=await Promise.all(OBS_SOURCES.map(async s=>{
  const url='https://news.google.com/rss/search?q='+encodeURIComponent(`site:${s.domain} (bitcoin OR ethereum OR solana OR XRP) (buy OR sell OR comprar OR vender) when:1d`)+'&hl=en-US&gl=US&ceid=US:en';
  try{const r=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('HTTP '+r.status);let xml='';const reader=r.body?.getReader?.();if(reader){const dec=new TextDecoder();let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>262144){await reader.cancel();throw Error('Feed excessivo');}xml+=dec.decode(part.value,{stream:true});}}else xml=await r.text();
   return {sourceId:s.id,status:'ok',items:parseNews(xml,{id:s.id,name:s.name},now).filter(x=>[publisherKey(s.name),publisherKey(s.domain),publisherKey(s.name)+'brasil'].includes(publisherKey(x.publisher))).map(x=>({id:hash([s.id,x.url]),sourceId:s.id,sourceName:s.name,title:x.title,url:x.url,publisher:x.publisher,publishedAt:x.publishedAt,firstSeenAt:iso(now),assets:x.assets,status:'candidate',note:'Manchete encontrada por busca; autoria, contexto e recomendação ainda não verificados'}))};
  }catch{return {sourceId:s.id,status:'unavailable',items:[]};}
 }));return {at:iso(now),sources:sources.map(({sourceId,status})=>({sourceId,status})),items:sources.flatMap(s=>s.items)};
}
export async function updateObservatory(repo,quotes,now=Date.now(),{collect=true,fetcher=fetch,getAdditionalQuotes}={}){
 let book=await repo.observatoryRead();const patches=[];
 const absent=[...new Set(book.recommendations.filter(r=>['awaiting-entry','tracking'].includes(r.evaluation.status)&&!quotes[r.snapshot.asset]).map(r=>r.snapshot.asset))];
 if(absent.length&&getAdditionalQuotes){try{quotes={...quotes,...await getAdditionalQuotes(absent)};}catch{/* Missing quotes remain pending or explicitly missing. */}}
 for(const r of book.recommendations){const evaluation=advanceTip(r,quotes,now);if(evaluation)patches.push({id:r.id,version:r.version,evaluation});}
 await repo.observatoryAdvance(patches);
 if(collect&&now<Date.parse(book.campaign.capture_ends)&&(!book.collection?.at||now-Date.parse(book.collection.at)>=55*60000)){
  const result=await collectTipCandidates(fetcher,now);await repo.observatoryCollect(result);
 }
 return patches.length;
}
