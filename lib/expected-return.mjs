import { netRoundTrip } from './forecast-economics.mjs';
export const RETURN_PROTOCOL=Object.freeze({id:'net-return-ridge-v1',lambda:10,minSamples:30,minExpectedNetPct:.1,costStressMultiplier:2,target:'fixed-horizon net return percent',selection:'expected net > 0.1 percent AND expected net with doubled costs > 0',promotion:'diagnostic only; never places orders'});
function solve(matrix,rhs){
 const a=matrix.map((row,i)=>[...row,rhs[i]]),n=rhs.length;
 for(let i=0;i<n;i++){
  let pivot=i;for(let j=i+1;j<n;j++)if(Math.abs(a[j][i])>Math.abs(a[pivot][i]))pivot=j;
  [a[i],a[pivot]]=[a[pivot],a[i]];if(Math.abs(a[i][i])<1e-12)throw Error('Regressão sem solução estável');
  const d=a[i][i];for(let k=i;k<=n;k++)a[i][k]/=d;
  for(let j=0;j<n;j++)if(j!==i){const factor=a[j][i];for(let k=i;k<=n;k++)a[j][k]-=factor*a[i][k];}
 }
 return a.map(row=>row[n]);
}
export function fitExpectedReturn(samples,id){
 const train=samples.filter(s=>s.status==='scored'&&Number.isFinite(s.rawPct)&&s.rawPct> -100&&Array.isArray(s.vector)&&s.vector.every(Number.isFinite));
 if(train.length<RETURN_PROTOCOL.minSamples)return null;
 const width=train[0].vector.length;if(!width||train.some(s=>s.vector.length!==width))throw Error('Vetores incompatíveis na regressão');
 const means=Array.from({length:width},(_,j)=>train.reduce((n,s)=>n+s.vector[j],0)/train.length);
 const scales=means.map((mean,j)=>Math.sqrt(train.reduce((n,s)=>n+(s.vector[j]-mean)**2,0)/train.length));
 const targets=train.map(s=>netRoundTrip(s.rawPct,id)),intercept=targets.reduce((a,b)=>a+b,0)/targets.length;
 const matrix=Array.from({length:width},(_,i)=>Array.from({length:width},(_,j)=>i===j?RETURN_PROTOCOL.lambda:0)),rhs=Array(width).fill(0);
 train.forEach((s,k)=>{const v=s.vector.map((x,j)=>scales[j]>1e-9?(x-means[j])/scales[j]:0);for(let i=0;i<width;i++){rhs[i]+=v[i]*(targets[k]-intercept);for(let j=0;j<width;j++)matrix[i][j]+=v[i]*v[j];}});
 const weights=solve(matrix,rhs);
 return {protocol:RETURN_PROTOCOL.id,lambda:RETURN_PROTOCOL.lambda,trained:train.length,intercept,means,scales,weights,lastTrainingLabelAt:train.at(-1).labelKnownAt??null};
}
export function expectedNet(model,vector){
 if(!model||!Array.isArray(vector)||vector.length!==model.weights.length||!vector.every(Number.isFinite))return null;
 const prediction=model.intercept+model.weights.reduce((n,w,j)=>n+w*(model.scales[j]>1e-9?(vector[j]-model.means[j])/model.scales[j]:0),0);
 return Number.isFinite(prediction)?prediction:null;
}
export function expectedStressNet(netPct,id){
 if(!Number.isFinite(netPct))return null;
 const normal=1+netRoundTrip(0,id)/100,stress=1+netRoundTrip(0,id,2)/100;
 return ((1+netPct/100)*stress/normal-1)*100;
}
export function returnError(samples,model,id){
 const known=samples.filter(s=>s.status==='scored'&&Number.isFinite(s.rawPct)&&s.rawPct> -100&&Number.isFinite(s.expectedNetPct));
 let sq=0,abs=0,baselineSq=0,baselineAbs=0,bias=0;
 for(const s of known){const actual=netRoundTrip(s.rawPct,id),error=s.expectedNetPct-actual,base=model.intercept-actual;sq+=error**2;abs+=Math.abs(error);baselineSq+=base**2;baselineAbs+=Math.abs(base);bias+=error;}
 return {known:known.length,maePct:known.length?abs/known.length:null,rmsePct:known.length?Math.sqrt(sq/known.length):null,biasPct:known.length?bias/known.length:null,baselineMeanNetPct:model.intercept,baselineMaePct:known.length?baselineAbs/known.length:null,baselineRmsePct:known.length?Math.sqrt(baselineSq/known.length):null,note:'Erros em pontos percentuais de retorno líquido; referência constante estimada só no treinamento.'};
}
