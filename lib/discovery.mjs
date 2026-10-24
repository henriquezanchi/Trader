// Discovery is a source for the SAME virtual BRL portfolio, never a real swap.
const BASE='https://api.geckoterminal.com/api/v2';
const addressOK=value=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,50}$/.test(value);
const number=value=>{const n=Number(value);return Number.isFinite(n)?n:null;};
export const isPool=id=>typeof id==='string'&&id.startsWith('solana:');
export function parsePools(body, now=Date.now()) {
 if(!Array.isArray(body?.data))throw Error('Fonte de pools inválida');
 return body.data.slice(0,30).flatMap(row=>{
  const a=row.attributes??{},address=a.address,priceUSD=number(a.base_token_price_usd),liquidityUSD=number(a.reserve_in_usd),createdAt=Date.parse(a.pool_created_at);
  if(!addressOK(address)||!(priceUSD>=1e-15)||priceUSD>1e9||!(liquidityUSD>0)||!Number.isFinite(createdAt)||createdAt>now)return [];
  const token=String(row.relationships?.base_token?.data?.id??'').replace(/^solana_/,'');
  if(!addressOK(token))return [];
  const name=String(a.name??'Token Solana').replace(/[\x00-\x1f]/g,' ').slice(0,60);
  return [{id:'solana:'+address,address,token,name,symbol:name.split(' / ')[0].slice(0,18),market:'dex',risk:'Extremo',potential:'Pool recém-criado; pode ser token antigo. Venda, impostos e segurança não verificados',priceUSD,liquidityUSD,createdAt:new Date(createdAt).toISOString(),collectedAt:new Date(now).toISOString(),volume5mUSD:number(a.volume_usd?.m5)??0,buys5m:number(a.transactions?.m5?.buys)??0,sells5m:number(a.transactions?.m5?.sells)??0}];
 });
}
async function json(url,fetcher){const res=await fetcher(url,{signal:AbortSignal.timeout(4500),headers:{Accept:'application/json'},redirect:'error'});if(!res.ok)throw Error('Fonte pública indisponível');return res.json();}
export async function discover(previous, heldIds=[],fetcher=fetch,now=Date.now()) {
 const old=previous??{assets:{}};
 const result={...old,assets:{...old.assets},attemptAt:new Date(now).toISOString()};
 try {
  const [fresh,held,fxData]=await Promise.all([
   json(BASE+'/networks/solana/new_pools',fetcher),
   heldIds.length?json(BASE+'/networks/solana/pools/multi/'+heldIds.map(id=>encodeURIComponent(id.slice(7))).join(','),fetcher):{data:[]},
   json('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=brl%2Cusd&include_last_updated_at=true',fetcher),
  ]);
  const fx=fxData?.['usd-coin'],age=now-(fx?.last_updated_at??0)*1000,rate=fx?.brl/fx?.usd;
  if(!Number.isFinite(rate)||rate<.1||rate>100||age< -60000||age>600000)throw Error('Câmbio indicativo indisponível');
  result.fx={rate,observedAt:new Date(fx.last_updated_at*1000).toISOString(),source:'USDC BRL/USD · câmbio implícito indicativo'};
  const pools=[...parsePools(fresh,now),...parsePools(held,now)];
  for(const p of pools)result.assets[p.id]={...p,firstSeenAt:old.assets?.[p.id]?.firstSeenAt??new Date(now).toISOString()};
  const live=new Set(pools.map(p=>p.id));result.liveIds=[...live];
  // Preserve every held pool; bound non-held metadata and never revive an old quote as new.
  const keep=new Set([...heldIds,...pools.sort((a,b)=>b.liquidityUSD-a.liquidityUSD).slice(0,20).map(p=>p.id)]);
  result.assets=Object.fromEntries(Object.entries(result.assets).filter(([id])=>keep.has(id)));
  result.status='ok';result.updatedAt=new Date(now).toISOString();
 }catch{result.status='indisponível';result.error='Novos pools ou câmbio sem resposta válida; ativos estabelecidos continuam sendo avaliados';result.liveIds=[];}
 return result;
}
export function poolQuotes(discovery,now=Date.now()) {
 if(discovery?.status!=='ok')return {};
 const out={};for(const id of discovery.liveIds??[]){const p=discovery.assets[id];if(!p||!discovery.fx)continue;
  out[id]={price:p.priceUSD*discovery.fx.rate,observedAt:p.collectedAt,collectedAt:p.collectedAt,source:'geckoterminal-indicative',lastTradeAt:null,volume24h:null,liquidityBRL:p.liquidityUSD*discovery.fx.rate,liquidityUSD:p.liquidityUSD,volume5mUSD:p.volume5mUSD,createdAt:p.createdAt,token:p.token,fx:discovery.fx,buys5m:p.buys5m,sells5m:p.sells5m,executionVerified:false};}
 return out;
}
