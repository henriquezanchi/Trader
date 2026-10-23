import { timingSafeEqual, createHmac } from 'node:crypto';

export function signedScheduler(req, now = Date.now()) {
  const key = process.env.SCHEDULER_SIGNING_KEY;
  const time = req.headers['x-trade-lab-time'], signature = req.headers['x-trade-lab-signature'];
  if (!key || key.length < 32 || typeof time !== 'string' || !/^\d{10}$/.test(time) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const seconds = Number(time), current = now / 1000;
  if (current - seconds > 90 || seconds - current > 5 || Math.floor(seconds / 3600) !== Math.floor(current / 3600)) return false;
  const expected = createHmac('sha256', key).update(`trade-lab:tick:${time}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function authorized(header, token) {
  if (!token || token.length < 32 || typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function appOrigin() {
  const url = new URL(process.env.APP_ORIGIN);
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Origem do aplicativo inválida');
  return url.origin;
}

export function sameOrigin(req) {
  // Browser writes must include the explicit trusted Origin. Never trust Host/X-Forwarded-Host.
  try { return req.headers.origin === appOrigin() && req.headers['sec-fetch-site'] !== 'cross-site'; } catch { return false; }
}

function cookieNames() {
  const prefix = appOrigin().startsWith('https:') ? '__Host-' : '';
  return { access: `${prefix}trade_lab_access`, refresh: `${prefix}trade_lab_refresh` };
}

export function cookieTokens(req) {
  if (!req.headers.cookie) return {};
  const names = cookieNames(), entries = Object.create(null);
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (Object.hasOwn(entries, name)) return {}; // Ambiguous duplicate cookies fail closed.
    try { entries[name] = decodeURIComponent(part.slice(i + 1)); } catch { return {}; }
  }
  return { access: entries[names.access], refresh: entries[names.refresh] };
}

export function clearSession(res) {
  writeCookies(res, '', '', 0, 0);
}

function writeCookies(res, access, refresh, accessAge, refreshAge) {
  const names = cookieNames();
  const secure = appOrigin().startsWith('https:') ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `${names.access}=${encodeURIComponent(access)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${accessAge}${secure}`,
    `${names.refresh}=${encodeURIComponent(refresh)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${refreshAge}${secure}`,
  ]);
}

export function setSession(res, session) {
  if (typeof session.access_token !== 'string' || !session.access_token || typeof session.refresh_token !== 'string' || !session.refresh_token) throw new Error('Sessão inválida');
  const age = Math.max(1, Math.min(Number(session.expires_in) || 3600, 3600));
  writeCookies(res, session.access_token, session.refresh_token, Math.floor(age), 7 * 86400);
}

export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function authRequest(path, { method = 'GET', data, access } = {}, fetcher = fetch) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  if (!url || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key || !process.env.TRADE_LAB_USER_IDS) throw new AuthError(503, 'Acesso por conta ainda não configurado');
  let res;
  try {
    res = await fetcher(`${url}/auth/v1/${path}`, {
      method, headers: { apikey: key, 'Content-Type': 'application/json', ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      ...(data != null ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(10000), redirect: 'error',
    });
  } catch { throw new AuthError(503, 'Serviço de acesso indisponível; tente novamente'); }
  if (!res.ok) {
    if (res.status === 429) throw new AuthError(429, 'Muitas tentativas. Aguarde antes de tentar novamente');
    if (res.status >= 500) throw new AuthError(503, 'Serviço de acesso indisponível; tente novamente');
    throw new AuthError(401, 'Credenciais inválidas ou sessão expirada');
  }
  return res.status === 204 ? {} : res.json();
}

export function allowedUser(user) {
  const ids = (process.env.TRADE_LAB_USER_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const emails = (process.env.TRADE_LAB_EMAILS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return Boolean(user?.id && ids.includes(user.id) && emails.includes(user.email?.toLowerCase()) && user.email_confirmed_at && !user.is_anonymous);
}

export async function requireUser(req, fetcher = fetch) {
  const access = cookieTokens(req).access;
  if (!access || access.length > 8192) throw new AuthError(401, 'Entre com seu e-mail e senha');
  const user = await authRequest('user', { access }, fetcher);
  if (!allowedUser(user)) throw new AuthError(403, 'Esta conta não tem acesso ao Trade Lab');
  return { user, access };
}
