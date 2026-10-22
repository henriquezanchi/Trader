import { timingSafeEqual } from 'node:crypto';
import { repository, runTick } from '../lib/services.mjs';
import { equity, LIMITS } from '../lib/engine.mjs';
import { ASSETS, PROFILES, configurePortfolio, stopReason } from '../lib/portfolio.mjs';

async function readBody(req) {
  if (req.body != null) {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(text) > 8192) throw new Error('Configuração muito grande');
    return JSON.parse(text);
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 8192) throw new Error('Configuração muito grande');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function authorized(header, token) {
  if (!token || token.length < 32 || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req.headers.authorization, process.env.BOT_TOKEN)) return res.status(401).json({ error: 'Token inválido ou servidor sem token de pelo menos 32 caracteres' });
  const action = new URL(req.url, 'https://local.invalid').searchParams.get('action') ?? 'status';
  if (!['status', 'tick', 'pause', 'resume', 'configure'].includes(action)) return res.status(400).json({ error: 'Ação desconhecida' });
  if (req.method !== (action === 'status' ? 'GET' : 'POST')) return res.status(405).json({ error: 'Método não permitido' });
  try {
    const repo = repository();
    if (action === 'tick') {
      const result = await runTick(repo);
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
