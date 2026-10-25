import test from 'node:test';
import assert from 'node:assert/strict';
import { assessLive, assessHistory, forecastReadiness } from '../lib/forecast-assessment.mjs';
const now=Date.parse('2026-10-25T12:00:00Z');
const metrics=()=>({valid:120,tp:45,fn:15,tn:45,fp:15,coverage:1,brierSkill:.1,balancedAccuracy:.75,accuracy:.75,alwaysUpAccuracy:.5,momentumAccuracy:.55});
const history=()=>({protocolId:'direction-audit-v2',dataEnd:new Date(now-3600000).toISOString(),protocolMetrics:{1:metrics()},walkForward:{1:Array.from({length:4},()=>({metrics:metrics()}))}});
test('alto acerto em mercado que sempre sobe não comprova vantagem',()=>{
 const m={...metrics(),accuracy:.9,alwaysUpAccuracy:.95};assert.equal(assessLive(m).ready,false);
});
test('métricas ausentes, nulas e não finitas nunca liberam suporte',()=>{
 for(const value of [null,undefined,NaN,Infinity])assert.equal(assessLive({...metrics(),brierSkill:value}).ready,false);
 assert.equal(assessLive({...metrics(),tn:0,fp:0}).ready,false);
});
test('uma janela excepcional não compensa três janelas sem vantagem',()=>{
 const h=history();for(const f of h.walkForward[1].slice(1))f.metrics.accuracy=.4;
 const r=assessHistory(h,1,now);assert.equal(r.ready,false);assert.equal(r.winningWindows,1);assert.equal(r.windows,4);
});
test('histórico deve ter fonte temporal atual e protocolo válido',()=>{
 for(const end of ['invalid',new Date(now+1).toISOString(),new Date(now-8*86400000).toISOString()])assert.equal(assessHistory({...history(),dataEnd:end},1,now).ready,false);
 assert.equal(assessHistory({...history(),protocolId:'legacy'},1,now).ready,false);
});
test('janelas sem ambas as direções não demonstram estabilidade',()=>{
 const h=history();h.walkForward[1].forEach(f=>{f.metrics.tn=0;f.metrics.fp=0;});assert.equal(assessHistory(h,1,now).ready,false);
});
test('suporte requer evidência histórica e ao vivo; aprovação não migra entre horizontes',()=>{
 const s={intelligence:{history:{bitcoin:history()},directionEvaluation:{metrics:{1:{assets:{bitcoin:metrics()}}}}}};
 assert.equal(forecastReadiness(s,'bitcoin',1,now).ready,true);
 assert.equal(forecastReadiness(s,'bitcoin',6,now).ready,false);
 delete s.intelligence.history.bitcoin;assert.equal(forecastReadiness(s,'bitcoin',1,now).ready,false);
});
