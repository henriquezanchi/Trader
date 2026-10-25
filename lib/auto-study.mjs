import { runScenarioStudy,STUDY_PROTOCOL } from './scenario-study.mjs';
export async function refreshOneStudy(repo,state,studies,now=Date.now()){
 const assets=Object.keys(state.config?.allocations??{}).filter(id=>['bitcoin','ethereum','solana','binancecoin','ripple','cardano','chainlink','avalanche-2','polkadot','litecoin'].includes(id));
 const candidates=assets.filter(asset=>studies.some(s=>s.asset===asset&&s.protocol===STUDY_PROTOCOL.id)).map(asset=>({asset,at:Date.parse(studies.find(s=>s.asset===asset)?.recordedAt??'1970-01-01')})).filter(s=>now-s.at>=86400000).sort((a,b)=>a.at-b.at);
 const asset=candidates[0]?.asset;if(!asset)return false;
 const cached=await repo.scenarioDataset(asset)??await repo.trainingData(asset);if(!cached?.observations?.length)return false;
 // Preserve the original source; do not mix another vendor's historical candles.
 if(!cached.observations.every(p=>!p.source||p.source.startsWith('coingecko')))return false;
 const points=new Map(cached.observations.map(p=>[p.at.slice(0,13),p]));
 for(const p of state.portfolio[asset]?.observations??[]){const at=Date.parse(p.at),observed=Date.parse(p.observedAt??p.at);if(at<=now&&observed<=at&&at-observed<=120000&&(!p.source||p.source.startsWith('coingecko')))points.set(p.at.slice(0,13),p);}
 const merged=[...points.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-750);
 const study=runScenarioStudy(merged,asset,{source:cached.report.source??'CoinGecko · arquivo e observações ao vivo',now});
 if(studies.some(s=>s.asset===asset&&s.models?.[1]?.datasetHash===study.report.datasetHash))return false;
 await repo.scenarioSave(asset,study,merged);return true;
}
