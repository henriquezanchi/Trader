export const exploring=s=>s.config?.simulationExploration===true;
export const EXPLORATION_ARMS=[{id:'short',label:'Curta',maxMinutes:6,takeProfitPct:.5},{id:'medium',label:'Intermediária',maxMinutes:20,takeProfitPct:1},{id:'patient',label:'Paciente',maxMinutes:60,takeProfitPct:2}];
export function explorationPlan(state,context,base){
 const stats=state.learning?.explorationArms??{},family=context.family;
 const pending=arm=>Object.values(state.fast?.positions??{}).filter(p=>p.quantity>0&&p.plan?.explorationArm===arm&&p.learningEntry?.context?.family===family).length;
 const total=EXPLORATION_ARMS.reduce((n,a)=>n+(stats[family+'|'+a.id]?.fitTrades??stats[family+'|'+a.id]?.trades??0),0);
 const choices=EXPLORATION_ARMS.map(a=>{const s=stats[family+'|'+a.id]??{trades:0,sumReward:0},n=s.fitTrades??s.trades,reward=s.fitSumReward??s.sumReward;return {...a,trades:n,pending:pending(a.id),score:n?reward/n+Math.sqrt(2*Math.log(total+1)/n):null};});
 choices.sort((a,b)=>Number(b.trades===0)-Number(a.trades===0)||(a.trades===0?a.pending-b.pending:b.score-a.score));
 const arm=choices[0];
 return {...base,...arm,explorationArm:arm.id,sizeFactor:1,blockedUntil:null,context,evidence:{...base.evidence,model:'paper-exploration-ucb-v1',exploration:true,blockedUntil:null,arm:arm.id,arms:choices,reason:`Exploração simulada: saída ${arm.label.toLowerCase()}, alvo líquido +${arm.takeProfitPct}%, prazo ${arm.maxMinutes} min; comparação adaptativa de retornos líquidos, sem stop de perda ou bloqueio econômico. Amostras ainda não comprovam vantagem.`}};
}
export function learnExploration(learning,entry,netPct,now){
 const arm=entry.plan?.explorationArm;if(!arm)return;
 const key=entry.context.family+'|'+arm,s=(learning.explorationArms??={})[key]??={trades:0,wins:0,sumNetPct:0,sumReward:0};
 s.fitTrades??=s.trades;s.fitSumReward??=s.sumReward;
 if(entry.evidence?.entryDecision?.phase!=='validation'){s.fitTrades++;s.fitSumReward+=Math.max(-1,Math.min(1,netPct/10));}
 s.trades++;s.wins+=Number(netPct>0);s.sumNetPct+=netPct;s.sumReward+=Math.max(-1,Math.min(1,netPct/10));s.lastAt=new Date(now).toISOString();
}
export function setExploration(previous,enabled,now=Date.now()){
 if(typeof enabled!=='boolean'||!previous.config)throw Error('Configure a carteira e informe o modo de simulação');
 const s=structuredClone(previous);
 if(enabled&&!exploring(previous)){s.explorationPreviousStrategy=s.config.cryptoStrategy;if(s.fast)s.fast.lastSlot=null;}
 s.config.simulationExploration=enabled;
 if(enabled){s.config.cryptoStrategy='active';s.paused=false;s.startedAt??=new Date(now).toISOString();}
 else{s.config.cryptoStrategy=s.explorationPreviousStrategy??s.config.cryptoStrategy;s.paused=true;}
 s.reason=enabled?'Exploração simulada ativada: limites de perda, exposição, prazo global e bloqueios econômicos desligados; caixa virtual e cotações válidas continuam obrigatórios':'Exploração desligada; simulação pausada com limites restaurados';
 return s;
}
