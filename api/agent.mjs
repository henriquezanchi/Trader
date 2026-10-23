import { repository, runTick, getQuotes } from '../lib/services.mjs';
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
  if (!['status', 'tick', 'pause', 'resume', 'configure', 'audit', 'bootstrap', 'opportunities', 'preview', 'confirm', 'research', 'research-refresh'].includes(action)) return res.status(400).json({ error: 'Ação desconhecida' });
  if (req.method !== (['status', 'audit', 'opportunities', 'research'].includes(action) ? 'GET' : 'POST')) return res.status(405).json({ error: 'Método não permitido' });
  try {
    const repo = repository();
    const commit = repo.commit;
    repo.commit = (version, state) => commit(version, { ...state, lastMutation: { actor: scheduler ? 'scheduler' : 'user', userId, action, at: new Date().toISOString() } });
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
    const { version, state } = await repo.read();
    if (['opportunities', 'preview', 'confirm', 'research-refresh'].includes(action)) {
      if (!state.config) return res.status(400).json({ error: 'Configure a carteira primeiro' });
      if (action === 'research-refresh' && state.intelligence?.lastSlot >= new Date().toISOString().slice(0, 13)) return res.status(200).json({ state, version, limits: LIMITS, assets: ASSETS, profiles: PROFILES });
      const quotes = await getQuotes(activeIds(state));
      if (action === 'opportunities') return res.status(200).json({ opportunities: opportunities(state, quotes), asOf: new Date().toISOString(), version });
      if (action === 'research-refresh') {
        const next = await enrichResearch(state, quotes);
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
