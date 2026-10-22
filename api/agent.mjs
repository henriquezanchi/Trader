import { timingSafeEqual } from 'node:crypto';
import { repository, runTick } from '../lib/services.mjs';
import { equity, LIMITS } from '../lib/engine.mjs';

export function authorized(header, token) {
  if (!token || token.length < 32 || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req.headers.authorization, process.env.BOT_TOKEN)) return res.status(401).json({ error: 'Token inválido ou servidor sem token de pelo menos 32 caracteres' });
  const action = new URL(req.url, 'https://local.invalid').searchParams.get('action') ?? 'status';
  if (!['status', 'tick', 'pause', 'resume'].includes(action)) return res.status(400).json({ error: 'Ação desconhecida' });
  if (req.method !== (action === 'status' ? 'GET' : 'POST')) return res.status(405).json({ error: 'Método não permitido' });
  try {
    const repo = repository();
    if (action === 'tick') {
      const result = await runTick(repo);
      return res.status(200).json({ ...result, limits: LIMITS });
    }
    const { version, state } = await repo.read();
    if (action !== 'status') {
      if (action === 'resume' && equity(state) <= state.initialCapital - LIMITS.totalLoss) return res.status(409).json({ error: 'Limite total atingido. Retomada bloqueada para preservar o teto de perda' });
      state.paused = action === 'pause';
      state.reason = state.paused ? 'Pausado pelo usuário' : 'Retomado pelo usuário; limites continuam ativos';
      await repo.commit(version, state);
    }
    return res.status(200).json({ state, limits: LIMITS });
  } catch (error) {
    return res.status(503).json({ error: error.message });
  }
}
