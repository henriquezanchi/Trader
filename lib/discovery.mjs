// Discovery and held-position valuation share the virtual BRL wallet, never a real swap.
const BASE='https://api.geckoterminal.com/api/v2';
export const POOL_BATCH_SIZE=20,MAX_POOL_BATCHES=4;
const addressOK=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(value);
const number=value=>value===null||value===undefined||value===''?null:Number.isFinite(Number(value))?Number(value):null;
export const isPool=id=>typeof id==='string'&&id.startsWith('solana:');
function parsePool(row,now,old=null){
 const a=row?.attributes??{},address=a.address,priceUSD=number(a.base_token_price_usd),liquidityUSD=number(a.reserve_in_usd);
 const token=String(row?.relationships?.base_token?.data?.id??'').replace(/^solana_/,'');
 if(!addressOK(address)||!addressOK(token)||old?.token&&token!==old.token||!(priceUSD>=1e-15)||priceUSD>1e9||!(liquidityUSD>0))return null;
 let created=Date.parse(a.pool_created_at);if(!Number.isFinite(created)&&old)created=Date.parse(old.createdAt);
 if(created>now||!old&&!Number.isFinite(created))return null;
 const name=String(a.name??old?.name??'Token Solana').replace(/[\x00-\x1f]/g,' ').slice(0,60);
 return {id:'solana:'+address,address,token,name,symbol:name.split(' / ')[0].slice(0,18),market:'dex',risk:'Extremo',potential:'Pool recém-criado; pode ser token antigo. Venda, impostos e segurança não verificados',priceUSD,liquidityUSD,
  createdAt:Number.isFinite(created)?new Date(created).toISOString():null,collectedAt:new Date(now).toISOString(),volume5mUSD:number(a.volume_usd?.m5)??0,buys5m:number(a.transactions?.m5?.buys)??0,sells5m:number(a.transactions?.m5?.sells)??0};
}
export function parsePools(body,now=Date.now()){
 if(!Array.isArray(body?.data))throw Error('Fonte de pools inválida');
 return body.data.slice(0,30).map(row=>parsePool(row,now)).filter(Boolean);
}
async function json(url,fetcher){
 const res=await fetcher(url,{signal:AbortSignal.timeout(4500),headers:{Accept:'application/json'},redirect:'error'});
 if(!res.ok){const e=Error('Fonte pública HTTP '+res.status);e.status=res.status;throw e;}
 return res.json();
}
const fxValid=(fx,now)=>Number.isFinite(fx?.rate)&&fx.rate>=.1&&fx.rate<=100&&Number.isFinite(Date.parse(fx.observedAt))&&now-Date.parse(fx.observedAt)>=0&&now-Date.parse(fx.observedAt)<=600000;
const issue=error=>error?.status?'HTTP '+error.status:error?.name==='TimeoutError'?'Tempo limite':'Resposta inválida ou indisponível';
export async function discover(previous,heldIds=[],fetcher=fetch,now=Date.now(),{discoverNew=true}={}){
 const old=previous??{assets:{}},held=[...new Set(heldIds)].filter(id=>isPool(id)&&addressOK(id.slice(7))),errors=[];
 const result={...old,assets:{...old.assets},attemptAt:new Date(now).toISOString(),liveIds:[],entryIds:[],poolStatus:{},diagnostics:{batches:[]}};
 // Bound requests, rotate larger books, and never put the entire book into one URL.
 const offset=(old.heldCursor??0)%Math.max(1,held.length),ordered=[...held.slice(offset),...held.slice(0,offset)].slice(0,POOL_BATCH_SIZE*MAX_POOL_BATCHES);
 result.heldCursor=held.length?(offset+ordered.length)%held.length:0;
 for(const id of held)result.poolStatus[id]={status:'pending',checkedAt:result.attemptAt,lastQuoteAt:old.assets?.[id]?.collectedAt??null,reason:'Consulta ainda não concluída neste ciclo'};
 const batches=Array.from({length:Math.ceil(ordered.length/POOL_BATCH_SIZE)},(_,i)=>ordered.slice(i*POOL_BATCH_SIZE,(i+1)*POOL_BATCH_SIZE));
 const jobs=[
  discoverNew?json(BASE+'/networks/solana/new_pools',fetcher).then(body=>({kind:'new',body})):Promise.resolve({kind:'new',skipped:true}),
  json('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=brl%2Cusd&include_last_updated_at=true',fetcher).then(body=>({kind:'fx',body})),
  ...batches.map(ids=>json(BASE+'/networks/solana/pools/multi/'+ids.map(id=>encodeURIComponent(id.slice(7))).join(','),fetcher).then(body=>({kind:'held',ids,body}))),
 ];
 const settled=await Promise.allSettled(jobs),fresh=[];
 for(let i=0;i<settled.length;i++){
  const r=settled[i];
  if(r.status==='rejected'){
   const message=(i===0?'Descoberta de novos pools: ':i===1?'Câmbio: ':'Posições abertas: ')+issue(r.reason);errors.push(message);
   if(i>=2){const ids=batches[i-2];result.diagnostics.batches.push({count:ids.length,status:'failed',httpStatus:r.reason?.status??null,reason:message});for(const id of ids)result.poolStatus[id]={...result.poolStatus[id],status:'unavailable',reason:message};}
   else result.diagnostics[i===0?'discovery':'fx']={status:'failed',httpStatus:r.reason?.status??null,reason:message};
   continue;
  }
  const {kind,body,ids,skipped}=r.value;
  if(kind==='fx'){
   const fx=body?.['usd-coin'],rate=fx?.brl/fx?.usd,stamp=fx?.last_updated_at;
   const stampMs=stamp*1000;
   const next=Number.isFinite(stamp)&&Number.isFinite(stampMs)&&stampMs<=now&&now-stampMs<=600000?{rate,observedAt:new Date(stampMs).toISOString(),source:'USDC BRL/USD · câmbio implícito indicativo'}:null;
   if(fxValid(next,now)){result.fx=next;result.diagnostics.fx={status:'ok'};}
   else{errors.push('Câmbio sem preço ou horário válido');result.diagnostics.fx={status:'invalid',reason:'Câmbio sem preço ou horário válido'};}
  }else if(kind==='new'){
   if(skipped){result.diagnostics.discovery={status:'skipped',reason:'Busca de novos pools desligada; posições abertas continuam sendo consultadas'};continue;}
   try{const parsed=parsePools(body,now);fresh.push(...parsed);result.entryIds=parsed.map(p=>p.id);result.diagnostics.discovery={status:'ok',count:parsed.length};}
   catch{errors.push('Resposta de novos pools inválida');result.diagnostics.discovery={status:'invalid'};}
  }else{
   if(!Array.isArray(body?.data)){
    errors.push('Resposta do lote de posições inválida');for(const id of ids)result.poolStatus[id]={...result.poolStatus[id],status:'unavailable',reason:'Resposta do lote de posições inválida'};
    result.diagnostics.batches.push({count:ids.length,status:'invalid'});continue;
   }
   const requested=new Set(ids),returned=new Map();
   for(const row of body.data){const id='solana:'+row?.attributes?.address;if(requested.has(id))returned.set(id,row);}
   let quoted=0;
   for(const id of ids){
    const row=returned.get(id),parsed=row?parsePool(row,now,old.assets?.[id]??{}):null;
    if(parsed){fresh.push(parsed);quoted++;result.poolStatus[id]={status:'quoted',checkedAt:result.attemptAt,lastQuoteAt:parsed.collectedAt,reason:'Preço indicativo e reserva positivos obtidos nesta consulta'};}
    else{const empty=row&&number(row.attributes?.reserve_in_usd)===0;
     result.poolStatus[id]={...result.poolStatus[id],status:empty?'no-liquidity':row?'invalid-data':'missing',reason:empty?'Fonte retornou reserva zero; venda não é simulada como executável':row?'Preço, reserva ou identidade do token inválidos':'Pool não retornado pela fonte; não presumir venda nem perda de 100%'};}
   }
   result.diagnostics.batches.push({count:ids.length,status:'ok',quoted});
  }
 }
 // Refresh valid records independently of other batches, preserving all held metadata.
 const usable=[];
 for(const p of fresh){
  if(held.includes(p.id)&&old.assets?.[p.id]?.token&&old.assets[p.id].token!==p.token)continue;
  usable.push(p);result.assets[p.id]={...p,firstSeenAt:old.assets?.[p.id]?.firstSeenAt??result.attemptAt};
  if(held.includes(p.id))result.poolStatus[p.id]={status:'quoted',checkedAt:result.attemptAt,lastQuoteAt:p.collectedAt,reason:'Preço indicativo e reserva positivos obtidos nesta consulta'};
 }
 const validFX=fxValid(result.fx,now);
 result.diagnostics.fxUsable=validFX;
 if(validFX)result.liveIds=[...new Set(usable.map(p=>p.id))];else{result.entryIds=[];errors.push('Câmbio indisponível ou antigo; nenhuma cotação BRL publicada');}
 for(const id of held){
  const status=result.poolStatus[id];
  if(status.status==='quoted'&&!validFX)result.poolStatus[id]={...status,status:'fx-unavailable',reason:'Preço do pool consultado, mas conversão BRL sem câmbio recente'};
  if(status.status==='pending')result.poolStatus[id]={...status,reason:'Livro dividido entre ciclos para respeitar o limite de consultas; posição preservada'};
 }
 const quoted=held.filter(id=>result.poolStatus[id].status==='quoted').length;
 result.heldHealth={total:held.length,quoted,pending:held.length-quoted,checkedAt:result.attemptAt};
 const keep=new Set([...held,...usable.sort((a,b)=>b.liquidityUSD-a.liquidityUSD).slice(0,20).map(p=>p.id)]);
 result.assets=Object.fromEntries(Object.entries(result.assets).filter(([id])=>keep.has(id)));
 result.status=result.liveIds.length?(errors.length||quoted<held.length?'parcial':'ok'):'indisponível';
 result.entryIds=result.entryIds.filter(id=>result.liveIds.includes(id));
 if(result.liveIds.length)result.updatedAt=result.attemptAt;
 result.error=result.status==='ok'?null:[...new Set([...errors,...(quoted<held.length?[`${held.length-quoted} de ${held.length} posições sem cotação BRL válida neste ciclo`]:[])])].join('; ')||'Nenhum pool com preço e reserva válidos';
 return result;
}
export function poolQuotes(discovery,now=Date.now()){
 if(!['ok','parcial'].includes(discovery?.status)||!fxValid(discovery.fx,now))return {};
 const out={};for(const id of discovery.liveIds??[]){const p=discovery.assets?.[id],age=now-Date.parse(p?.collectedAt);
  if(!p||!Number.isFinite(age)||age<0||age>120000||!(p.priceUSD>0)||!(p.liquidityUSD>0))continue;
  out[id]={price:p.priceUSD*discovery.fx.rate,observedAt:p.collectedAt,collectedAt:p.collectedAt,source:'geckoterminal-indicative',lastTradeAt:null,volume24h:null,liquidityBRL:p.liquidityUSD*discovery.fx.rate,liquidityUSD:p.liquidityUSD,volume5mUSD:p.volume5mUSD,createdAt:p.createdAt,token:p.token,fx:discovery.fx,buys5m:p.buys5m,sells5m:p.sells5m,executionVerified:false};
 }
 return out;
}
