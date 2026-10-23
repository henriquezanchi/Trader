import { repository, runTick } from '../lib/services.mjs';
import { equity, LIMITS } from '../lib/engine.mjs';
import { ASSETS, PROFILES, configurePortfolio, stopReason } from '../lib/portfolio.mjs';
import { readBody } from '../lib/http.mjs';
import { authorized, requireUser, sameOrigin } from '../lib/auth.mjs';
import { bootstrapTick } from '../lib/history.mjs';
export { authorized } from '../lib/auth.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  const action = new URL(req.url, 'https://local.invalid').searchParams.get('action') ?? 'status';
  const scheduler = action === 'tick' && authorized(req.headers.authorization, process.env.BOT_TOKEN);
  let userId = null;
  if (!scheduler) {
    try { userId = (await requireUser(req)).user.id; }
    catch (error) { return res.status(error.status ?? 503).json({ error: error.status ? error.message : 'Serviço de acesso indisponível' }); }
    if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Origem da solicitação inválida' });
  }
  if (!['status', 'tick', 'pause', 'resume', 'configure', 'audit', 'bootstrap'].includes(action)) return res.status(400).json({ error: 'Ação desconhecida' });
  if (req.method !== (['status', 'audit'].includes(action) ? 'GET' : 'POST')) return res.status(405).json({ error: 'Método não permitido' });
  try {
    const repo = repository();
    const commit = repo.commit;
    repo.commit = (version, state) => commit(version, { ...state, lastMutation: { actor: scheduler ? 'scheduler' : 'user', userId, action, at: new Date().toISOString() } });
    if (action === 'audit') {
      const raw = new URL(req.url, 'https://local.invalid').searchParams.get('before');
      if (raw !== null && !/^[1-9][0-9]{0,14}$/.test(raw)) return res.status(400).json({ error: 'Página inválida' });
      return res.status(200).json(await repo.audit(raw));
    }
    if (action === 'tick' || action === 'bootstrap') {
      const result = action === 'bootstrap' ? await bootstrapTick(repo) : await runTick(repo);
      return res.status(200).json({ ...result, limits: LIMITS, assets: ASSETS, profiles: PROFILES });
    }
    const { version, state } = await repo.read();
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
