import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { equity, validateQuote } from './engine.mjs';
import { fill, costs } from './markets.mjs';
import { recordExit } from './learning.mjs';
const key=()=>{const k=process.env.SCHEDULER_SIGNING_KEY;if(!k||k.length<32)throw Error('Controle de posições não configurado');return k;};
const sign=s=>createHmac('sha256',key()).update('trade-lab:fast-sale:'+s).digest('base64url');
function execute(previous,quotes,asset,now,userId){
 const s=structuredClone(previous),p=s.fast?.positions[asset];if(!p||p.quantity<=0)throw Error('Posição curta já encerrada');
 validateQuote(quotes[asset],now);if(now-Date.parse(quotes[asset].observedAt)>120000)throw Error('Cotação antiga; atualize a prévia');
 for(const [id,h] of Object.entries(s.fast.positions))if(quotes[id]?.price)h.lastPrice=quotes[id].price;
 for(const [id,h] of Object.entries(s.portfolio??{}))if(quotes[id]?.price)h.lastPrice=quotes[id].price;
 p.liquidityBRL=quotes[asset].liquidityBRL??p.liquidityBRL;
 const before={cash:s.cash,quantity:p.quantity,equity:equity(s),costBasis:p.costBasis},order=fill(asset,'VENDER',quotes[asset].price,0,p,now),entry=p.learningEntry;
 s.cash+=order.cashChange;p.quantity=0;p.costBasis=0;delete p.userExit;delete p.learningEntry;
 s.fast.cooldowns[asset]=new Date(now+4*60000).toISOString();
 const after={cash:s.cash,quantity:0,equity:equity(s),costBasis:0};
 const event={id:randomUUID(),at:new Date(now).toISOString(),asset,mode:'fast',action:'VENDER',reason:'Venda imediata da posição curta confirmada pelo usuário',quantity:order.quantity,fee:order.fee,executionPrice:order.executionPrice,price:quotes[asset].price,realizedPnl:order.realizedPnl,saleProceeds:order.cashChange,equity:after.equity,before,after,quote:quotes[asset],parameters:{engine:'manual-fast-sale-v1',approvedBy:userId,costs:costs(asset)}};
 event.learning=recordExit(s,entry,event,now);
 const stats=s.fast.stats??={buys:0,sells:0,wins:0,losses:0,fees:0,realizedPnl:0};stats.sells++;stats.fees+=order.fee;stats.realizedPnl+=order.realizedPnl??0;if(order.realizedPnl>0)stats.wins++;else if(order.realizedPnl<0)stats.losses++;
 s.events=[...s.events,event].slice(-200);return {state:s,event,preview:{asset,costs:costs(asset),action:'VENDER',quantity:order.quantity,price:quotes[asset].price,executionPrice:order.executionPrice,fee:order.fee,amount:-order.cashChange,realizedPnl:order.realizedPnl,before,after,scenarios:[-5,0,5].map(changePct=>({changePct,equityAfterExit:after.equity,differenceVsBefore:after.equity-before.equity}))}};
}
export function fastSalePreview(state,quotes,asset,version,userId,now=Date.now()){
 const {preview}=execute(state,quotes,asset,now,userId),payload={id:randomUUID(),asset,version,userId,quantity:preview.quantity,price:preview.price,issuedAt:now,expiresAt:now+60000};const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');return {...preview,version,expiresAt:payload.expiresAt,token:encoded+'.'+sign(encoded)};
}
export function fastSaleConfirm(state,quotes,token,version,userId,now=Date.now()){
 if(typeof token!=='string'||token.length>4096)throw Error('Proposta inválida');const parts=token.split('.');if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))throw Error('Proposta inválida');const expected=Buffer.from(sign(parts[0])),actual=Buffer.from(parts[1]);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('Proposta inválida');
 let p;try{p=JSON.parse(Buffer.from(parts[0],'base64url').toString());}catch{throw Error('Proposta inválida');}
 if(p.userId!==userId||p.version!==version)throw Error('A carteira mudou; solicite nova prévia');
 if(!Number.isFinite(p.expiresAt)||p.expiresAt-p.issuedAt!==60000||p.issuedAt>now+5000||now>=p.expiresAt)throw Error('Proposta vencida');
 if(state.fast?.positions[p.asset]?.quantity!==p.quantity)throw Error('A posição mudou');
 if(!Number.isFinite(quotes[p.asset]?.price)||Math.abs(quotes[p.asset].price/p.price-1)>.002)throw Error('Preço variou mais de 0,2%; solicite nova prévia');
 const result=execute(state,quotes,p.asset,now,userId);return {state:result.state,execution:result.event};
}
export function scheduleSale(previous,body,version,userId,now=Date.now()){
 if(body.expectedVersion!==version)throw Error('A carteira mudou; atualize antes de programar');
 const s=structuredClone(previous),p=s.fast?.positions[body.asset];if(!p||p.quantity<=0)throw Error('Posição curta já encerrada');
 const kind=body.kind;let value=body.value;
 if(!['cancel','net','price','time'].includes(kind))throw Error('Tipo de venda inválido');
 if(kind==='time'){const t=Date.parse(value);if(!Number.isFinite(t)||t<=now||t>now+7*86400000)throw Error('Escolha uma data futura em até sete dias');value=new Date(t).toISOString();}
 else if(kind!=='cancel'&&(!Number.isFinite(value)||value<=0||value>(kind==='net'?10000:1e12)))throw Error('Alvo inválido');
 if(kind==='cancel')delete p.userExit;else p.userExit={id:randomUUID(),kind,value,createdAt:new Date(now).toISOString(),createdBy:userId,quantity:p.quantity,openedAt:p.openedAt};
 s.events=[...s.events,{id:randomUUID(),at:new Date(now).toISOString(),asset:body.asset,mode:'fast',action:kind==='cancel'?'CANCELAR':'PROGRAMAR',reason:kind==='cancel'?'Programação de venda removida pelo usuário':`Venda programada pelo usuário: ${kind} ${value}; stops e prazo máximo continuam prioritários`,fee:0,equity:equity(s),parameters:{engine:'user-exit-v1',order:p.userExit??null},before:{quantity:p.quantity},after:{quantity:p.quantity}}].slice(-200);return s;
}
export function scheduledExit(position,quote,netPct,now){const o=position.userExit;if(!o||o.quantity!==position.quantity||o.openedAt!==position.openedAt)return null;if(o.kind==='net'&&netPct>=o.value)return `Venda programada: ganho líquido ${netPct.toFixed(2)}% atingiu ${o.value}%`;if(o.kind==='price'&&quote.price>=o.value)return `Venda programada: preço ${quote.price} atingiu ${o.value}`;if(o.kind==='time'&&now>=Date.parse(o.value))return `Venda programada: horário ${o.value} alcançado`;return null;}
