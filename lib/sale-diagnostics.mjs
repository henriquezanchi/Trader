import {fill} from './markets.mjs';
import {isPool} from './discovery.mjs';
export function saleDiagnostics(rows=[]){
 const groups=new Map(),items=[];
 for(const r of rows){const sale=r.sale_light,net=sale?.realizedPnl;if(!Number.isFinite(net))continue;
  const arm=sale.parameters?.explorationArm??'unattributed';let g=groups.get(arm);if(!g){g={arm,sales:0,wins:0,netBRL:0,matched:0,spotPnlBRL:0,executionCostBRL:0,priceLosses:0,costOnlyLosses:0,unknown:0,exits:{},afterHourCases:0,betterAfterHour:0,worseAfterHour:0,afterHourDeltaBRL:0};groups.set(arm,g);}
  const reason=r.reason??'',kind=/Prazo máximo/.test(reason)?'time':/móvel|trailing|Recuo/i.test(reason)?'trailing':/usuário|programada/i.test(reason)?'user':'other';
  g.sales++;g.wins+=Number(net>0);g.netBRL+=net;g.exits[kind]=(g.exits[kind]??0)+1;
  const matched=Number.isFinite(r.quantity)&&r.quantity>0&&Number.isFinite(r.entry_quantity)&&Math.abs(r.quantity-r.entry_quantity)<=1e-8*Math.max(1,r.quantity)&&Number.isFinite(r.entry_price)&&r.entry_price>0&&Number.isFinite(r.exit_price)&&r.exit_price>0;
  let spotPnlBRL=null,executionCostBRL=null,afterHourDeltaBRL=null;
  if(matched){spotPnlBRL=r.quantity*(r.exit_price-r.entry_price);executionCostBRL=spotPnlBRL-net;g.matched++;g.spotPnlBRL+=spotPnlBRL;g.executionCostBRL+=executionCostBRL;g.priceLosses+=Number(net<0&&spotPnlBRL<0);g.costOnlyLosses+=Number(net<0&&spotPnlBRL>=0);}else g.unknown++;
  if(!isPool(sale.asset)&&matched&&Number.isFinite(r.before?.costBasis)&&Number.isFinite(r.after_hour?.price)&&Date.parse(r.after_hour.observedAt)>=Date.parse(sale.at)+3600000&&Date.parse(r.after_hour.observedAt)<=Date.parse(sale.at)+3900000){
   const alternate=fill(sale.asset,'VENDER',r.after_hour.price,0,{quantity:r.quantity,costBasis:r.before.costBasis},Date.parse(r.after_hour.observedAt));afterHourDeltaBRL=alternate.realizedPnl-net;g.afterHourCases++;g.betterAfterHour+=Number(afterHourDeltaBRL>0);g.worseAfterHour+=Number(afterHourDeltaBRL<0);g.afterHourDeltaBRL+=afterHourDeltaBRL;
  }
  items.push({id:sale.id,at:sale.at,asset:sale.asset,arm,netBRL:net,reason,exitKind:kind,entryAt:r.entry_at,spotPnlBRL,executionCostBRL,afterHourDeltaBRL,afterHourQuote:r.after_hour??null});
 }
 return {method:'recent-sales-spot-cost-exit-v1',sales:items.length,from:items.at(-1)?.at??null,through:items[0]?.at??null,netBRL:items.reduce((s,r)=>s+r.netBRL,0),groups:[...groups.values()],items,notes:['Últimas 40 vendas curtas; amostra descritiva, sem validação independente.','Decomposição em preço à vista e custos implícitos somente para compras/vendas integralmente pareadas. Custos incluem taxas e deslizamento já contidos no resultado; não descontar novamente.','Comparação retrospectiva de sair uma hora depois usa a mesma quantidade e custos atuais, com cotação real até cinco minutos após o alvo. Não contabiliza capital ocupado, sinais intermediários ou outras operações que deixariam de ocorrer. Não treina o bot nem demonstra que esperar é melhor.']};
}
