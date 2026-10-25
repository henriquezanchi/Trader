import { runScenarioStudy, STUDY_PROTOCOL } from '../lib/scenario-study.mjs';
import { ENTRY_POLICY } from '../lib/entry-learning.mjs';
import { setExploration } from '../lib/exploration.mjs';
import { randomUUID } from 'node:crypto';
import { forecastReadiness, READINESS_POLICY } from '../lib/forecast-assessment.mjs';
import { auditForecast, PREDICTION_PROTOCOL } from '../lib/prediction-protocol.mjs';
import { historicalDirection, commitHistoricalDirection, fitHistoricalDirection, rememberHistoryBackoff } from '../lib/forecast-history.mjs';
import { fastSalePreview, fastSaleConfirm, scheduleSale } from '../lib/fast-control.mjs';
import { upgradeCapital, updatePerformance } from '../lib/performance.mjs';
import { getETFs, ETF_IDS } from '../lib/markets.mjs';
import { repository, runTick, getQuotes, getPortfolioQuotes } from '../lib/services.mjs';
import { equity, LIMITS } from '../lib/engine.mjs';
import { ASSETS, PROFILES, configurePortfolio, stopReason } from '../lib/portfolio.mjs';
import { readBody } from '../lib/http.mjs';
import { authorized, requireUser, sameOrigin, signedScheduler } from '../lib/auth.mjs';
import { bootstrapTick } from '../lib/history.mjs';
import { activeIds, opportunities, proposal, confirmProposal } from '../lib/assisted.mjs';
import { enrichResearch } from '../lib/research.mjs';
export { authorized } from '../lib/auth.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  const action = new URL(req.url, 'https://local.invalid').searchParams.get('action') ?? 'status';
  const scheduler = action === 'tick' && (authorized(req.headers.authorization, process.env.BOT_TOKEN) || signedScheduler(req));
  let userId = null;
  if (!scheduler) {
    try { userId = (await requireUser(req)).user.id; }
    catch (error) { return res.status(error.status ?? 503).json({ error: error.status ? error.message : 'Serviço de acesso indisponível' }); }
    if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Origem da solicitação inválida' });
  }
  if (!['status', 'tick', 'pause', 'resume', 'configure', 'audit', 'bootstrap', 'opportunities', 'preview', 'confirm', 'research', 'research-refresh', 'capital-upgrade', 'markets', 'fast-preview', 'fast-confirm', 'schedule-sale', 'history-train', 'quality', 'chart', 'chart-cycle', 'simulation-exploration', 'scenario-run', 'scenario-report', 'learning-start'].includes(action)) return res.status(400).json({ error: 'Ação desconhecida' });
  if (req.method !== (['status', 'audit', 'opportunities', 'research', 'markets', 'quality', 'chart', 'chart-cycle', 'scenario-report'].includes(action) ? 'GET' : 'POST')) return res.status(405).json({ error: 'Método não permitido' });
  try {
    const repo = repository();
    const commit = repo.commit;
    repo.commit = (version, state) => commit(version, { ...state, lastMutation: { actor: scheduler ? 'scheduler' : 'user', userId, action, at: new Date().toISOString() } });
    if(action==='scenario-report'){
      const asset=new URL(req.url,'https://local.invalid').searchParams.get('asset');
      if(asset&&!['bitcoin','ethereum','solana','binancecoin','ripple','cardano','chainlink','avalanche-2','polkadot','litecoin'].includes(asset))return res.status(400).json({error:'Ativo sem estudo horário'});
      const protocol=new URL(req.url,'https://local.invalid').searchParams.get('protocol');if(protocol&&!['scenario-comparison-v1','scenario-comparison-v2'].includes(protocol))return res.status(400).json({error:'Versão de estudo inválida'});
      return res.status(200).json(await repo.scenarioRead(asset,protocol));
    }
    if(action==='scenario-run'){
      const body=await readBody(req),asset=body.asset;
      if(!['bitcoin','ethereum','solana','binancecoin','ripple','cardano','chainlink','avalanche-2','polkadot','litecoin'].includes(asset))return res.status(400).json({error:'Ativo sem histórico horário'});
      let dataset=await repo.scenarioDataset(asset)??await repo.trainingData(asset),points=dataset?.observations,source=dataset?.report?.source;
      if(!points?.length){const latest=await repo.read(),result=await historicalDirection(asset,fetch,Date.now(),latest.state.historySourcePolicy);points=result.points;source=result.report.source;}
      const study=runScenarioStudy(points,asset,{source}),id=await repo.scenarioSave(asset,study,points);
      return res.status(200).json({id,summary:study.report.summary});
    }
    if(action==='chart'){
      const period=new URL(req.url,'https://local.invalid').searchParams.get('period')??'1d';
      if(!['1h','1d','1w','1m','1y','5y'].includes(period))return res.status(400).json({error:'Prazo inválido'});
      return res.status(200).json(await repo.chart(period));
    }
    if(action==='chart-cycle'){
      const id=new URL(req.url,'https://local.invalid').searchParams.get('id');
      if(!/^[1-9][0-9]{0,14}$/.test(id??''))return res.status(400).json({error:'Ciclo inválido'});
      return res.status(200).json(await repo.chartCycle(id));
    }
    if(action==='quality'){
      const report=await repo.quality(),{state}=await repo.read(),pending=state.intelligence?.directionPending??[],checked=pending.filter(p=>p.protocolId===PREDICTION_PROTOCOL.id).map(auditForecast);
      const forecastAssessment=Object.keys(state.intelligence?.history??{}).flatMap(id=>[1,6,24].map(h=>forecastReadiness(state,id,h)));
      return res.status(200).json({...report,forecastAssessment,readinessPolicy:READINESS_POLICY,replay:{protocol:PREDICTION_PROTOCOL.id,checked:checked.length,valid:checked.filter(p=>p.valid).length,invalid:checked.filter(p=>!p.valid),legacyUnfingerprinted:pending.length-checked.length}});
    }
    if (action === 'audit' || action === 'research') {
      const raw = new URL(req.url, 'https://local.invalid').searchParams.get('before');
      if (raw !== null && !/^[1-9][0-9]{0,14}$/.test(raw)) return res.status(400).json({ error: 'Página inválida' });
      return res.status(200).json(await (action === 'audit' ? repo.audit(raw) : repo.research(raw)));
    }
    if (action === 'tick' || action === 'bootstrap') {
      const result = action === 'bootstrap' ? await bootstrapTick(repo) : await runTick(repo);
      if (scheduler) return res.status(200).json({ duplicate: result.duplicate, version: result.version });
      return res.status(200).json({ ...result, limits: LIMITS, assets: ASSETS, profiles: PROFILES });
    }
    if(action==='history-train'){
      const body=await readBody(req);let trained;
      try{
        const cached=await repo.trainingData(body.asset);
        if(cached?.observations?.length>=120&&Date.now()-Date.parse(cached.report?.importedAt)<24*3600000){trained=fitHistoricalDirection(cached.observations,body.asset);trained.report.source=cached.report.source;trained.report.dataFetchedAt=cached.report.dataFetchedAt??cached.report.importedAt;trained.report.reusedDataset=true;}
        else{const current=await repo.read();trained=await historicalDirection(body.asset,fetch,Date.now(),current.state.historySourcePolicy??current.state.intelligence?.historySourcePolicy);}
      }catch(error){
        if(error.coinGeckoNotBefore){await rememberHistoryBackoff(repo,error.coinGeckoNotBefore);res.setHeader('Retry-After',String(Math.max(1,Math.ceil((Date.parse(error.coinGeckoNotBefore)-Date.now())/1000))));}
        return res.status(error.coinGeckoNotBefore?429:503).json({error:error.message});
      }
      const result=await commitHistoricalDirection(repo,trained);
      return res.status(200).json({...result,assets:ASSETS,profiles:PROFILES,limits:LIMITS});
    }
    if(action==='markets')return res.status(200).json({quotes:await getETFs(ETF_IDS)});
    const { version, state } = await repo.read();
    if(action==='learning-start'){
      if(!state.config)return res.status(400).json({error:'Configure a carteira primeiro'});
      const body=await readBody(req),pct=body.explorationPct??ENTRY_POLICY.explorationPct;
      if(!Number.isFinite(pct)||pct<1||pct>100)return res.status(400).json({error:'Parcela de exploração deve ser de 1 a 100%'});
      if(state.config.learningPolicy!==ENTRY_POLICY.id&&state.fast)state.fast.lastSlot=null;
      state.config.learningPolicy=ENTRY_POLICY.id;state.config.learningExplorationPct=pct;
      state.learningGoal={protocol:STUDY_PROTOCOL.id,targetAccuracy:.8,realTradingEnabled:false,createdAt:new Date().toISOString()};
      state.events=[...state.events,{id:randomUUID(),at:new Date().toISOString(),mode:'control',action:'CONFIGURAR',reason:`Aprendizado de entrada ativado: ${pct}% para testar; restante reservado para estratégias com vantagem líquida demonstrada contra caixa. Meta de pesquisa: 80% de acerto, sem habilitar dinheiro real.`,fee:0,equity:equity(state),parameters:{policy:ENTRY_POLICY,explorationPct:pct}}].slice(-200);
      await repo.commit(version,state);
      return res.status(200).json({state,version:version+1,assets:ASSETS,profiles:PROFILES,limits:LIMITS});
    }
    if(action==='simulation-exploration'){
      const body=await readBody(req);let next;
      try{next=setExploration(state,body.enabled);}catch(error){return res.status(400).json({error:error.message});}
      next.events=[...next.events,{id:randomUUID(),at:new Date().toISOString(),mode:'control',action:'CONFIGURAR',reason:next.reason,fee:0,equity:equity(next),parameters:{simulationExploration:body.enabled}}].slice(-200);
      await repo.commit(version,next);
      return res.status(200).json({state:next,version:version+1,assets:ASSETS,profiles:PROFILES,limits:LIMITS});
    }
    if(action==='schedule-sale'){
      let next;try{next=scheduleSale(state,await readBody(req),version,userId);}catch(error){return res.status(409).json({error:error.message});}
      await repo.commit(version,next);return res.status(200).json({state:next,version:version+1,limits:LIMITS,assets:ASSETS,profiles:PROFILES});
    }
    if(action==='fast-preview'||action==='fast-confirm'){
      const body=await readBody(req),{quotes}=await getPortfolioQuotes(state);
      try{
        if(action==='fast-preview')return res.status(200).json({proposal:fastSalePreview(state,quotes,body.asset,version,userId)});
        const result=fastSaleConfirm(state,quotes,body.token,version,userId);result.state=await updatePerformance(result.state);await repo.commit(version,result.state);
        return res.status(200).json({...result,version:version+1,limits:LIMITS,assets:ASSETS,profiles:PROFILES});
      }catch(error){return res.status(409).json({error:error.message});}
    }
    if(action==='capital-upgrade'){
      const next=upgradeCapital(state);
      if(next===state)return res.status(200).json({state,version,limits:LIMITS,assets:ASSETS,profiles:PROFILES});
      const enriched=await updatePerformance(next);await repo.commit(version,enriched);
      return res.status(200).json({state:enriched,version:version+1,limits:LIMITS,assets:ASSETS,profiles:PROFILES});
    }
    if (['opportunities', 'preview', 'confirm', 'research-refresh', 'capital-upgrade', 'markets'].includes(action)) {
      if (!state.config) return res.status(400).json({ error: 'Configure a carteira primeiro' });
      if (action === 'research-refresh' && state.intelligence?.lastSlot >= new Date().toISOString().slice(0, 13)) {
        if(!state.performance)return res.status(200).json({state,version,limits:LIMITS,assets:ASSETS,profiles:PROFILES});
        const next=await updatePerformance({...state,performance:{...state.performance,cdi:{...state.performance.cdi,attemptDate:null}}});
        await repo.commit(version,next);return res.status(200).json({state:next,version:version+1,limits:LIMITS,assets:ASSETS,profiles:PROFILES});
      }
      const quotes = await getQuotes(activeIds(state));
      if (action === 'opportunities') return res.status(200).json({ opportunities: opportunities(state, quotes), asOf: new Date().toISOString(), version });
      if (action === 'research-refresh') {
        const next = await updatePerformance(await enrichResearch(state, quotes));
        await repo.commit(version, next);
        return res.status(200).json({ state: next, version: version + 1, limits: LIMITS, assets: ASSETS, profiles: PROFILES });
      }
      let body;
      try { body = await readBody(req); if (!body || typeof body !== 'object') throw new Error(); }
      catch { return res.status(400).json({ error: 'Solicitação inválida' }); }
      if (action === 'preview') {
        try { return res.status(200).json({ proposal: proposal(state, quotes, body, version, userId) }); }
        catch (error) { return res.status(400).json({ error: error.message }); }
      }
      let result;
      try { result = confirmProposal(state, quotes, body.token, version, userId); }
      catch (error) { return res.status(409).json({ error: error.message }); }
      result.state = await updatePerformance(result.state);
      await repo.commit(version, result.state);
      return res.status(200).json({ ...result, version: version + 1, limits: LIMITS, assets: ASSETS, profiles: PROFILES });
    }
    if (action === 'configure') {
      let body, next;
      try {
        body = await readBody(req);
        if (body.expectedVersion !== version) return res.status(409).json({ error: 'O estado mudou; atualize antes de salvar' });
        next = configurePortfolio(state, body.config);
      } catch (error) { return res.status(400).json({ error: error.message }); }
      await repo.commit(version, next);
      return res.status(200).json({ state: next, version: version + 1, limits: LIMITS, assets: ASSETS, profiles: PROFILES });
    }
    if (action !== 'status') {
      if (action === 'resume') {
        const reason = state.config ? stopReason(state) : equity(state) <= state.initialCapital - LIMITS.totalLoss ? 'Limite total atingido' : null;
        if (reason) return res.status(409).json({ error: `${reason}. Retomada bloqueada; revise os parâmetros` });
        if (state.config) state.startedAt ??= new Date().toISOString();
      }
      state.paused = action === 'pause';
      state.reason = state.paused ? 'Pausado pelo usuário' : 'Retomado pelo usuário; limites continuam ativos';
      await repo.commit(version, state);
    }
    return res.status(200).json({ state, version: action === 'status' ? version : version + 1, limits: LIMITS, assets: ASSETS, profiles: PROFILES });
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }
}
