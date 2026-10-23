import { readBody } from '../lib/http.mjs';
import { appOrigin, sameOrigin, cookieTokens, clearSession, setSession, authRequest, allowedUser, requireUser, AuthError } from '../lib/auth.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Cookie');
  const action = new URL(req.url, 'https://local.invalid').searchParams.get('action') ?? 'session';
  if (!['session', 'login', 'logout', 'recover', 'recovery-session', 'reset', 'refresh'].includes(action)) return res.status(400).json({ error: 'Ação desconhecida' });
  if (req.method !== (action === 'session' ? 'GET' : 'POST')) return res.status(405).json({ error: 'Método não permitido' });
  if (action !== 'session' && !sameOrigin(req)) return res.status(403).json({ error: 'Origem da solicitação inválida' });
  try {
    if (action === 'session') {
      await requireUser(req);
      return res.status(200).json({ authenticated: true });
    }
    if (action === 'logout') {
      const access = cookieTokens(req).access;
      // Clear local credentials even if the provider is temporarily unavailable.
      clearSession(res);
      if (access) {
        try { await authRequest('logout?scope=local', { method: 'POST', access }); }
        catch (error) {
          if (error.status === 503) return res.status(503).json({ error: 'Acesso removido deste navegador; não foi possível confirmar a revogação no serviço' });
        }
      }
      return res.status(200).json({ authenticated: false });
    }
    let body;
    try { body = await readBody(req); if (!body || typeof body !== 'object') throw new Error(); }
    catch { return res.status(400).json({ error: 'Solicitação inválida' }); }
    if (action === 'login') {
      if (typeof body.email !== 'string' || body.email.length > 254 || typeof body.password !== 'string' || !body.password || body.password.length > 1024) return res.status(400).json({ error: 'Informe e-mail e senha' });
      const allowedEmails = (process.env.TRADE_LAB_EMAILS ?? '').split(',').map(x => x.trim().toLowerCase());
      if (!allowedEmails.includes(body.email.trim().toLowerCase())) throw new AuthError(401, 'Credenciais inválidas ou sessão expirada');
      const session = await authRequest('token?grant_type=password', { method: 'POST', data: { email: body.email.trim(), password: body.password } });
      if (!allowedUser(session.user)) throw new AuthError(403, 'Esta conta não tem acesso ao Trade Lab');
      setSession(res, session);
      return res.status(200).json({ authenticated: true });
    }
    if (action === 'recover') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!email || email.length > 254) return res.status(400).json({ error: 'Informe seu e-mail' });
      if (!process.env.TRADE_LAB_EMAILS) throw new AuthError(503, 'Recuperação de acesso ainda não configurada');
      // Do not send mail to unrelated users in the shared Supabase project.
      if (process.env.TRADE_LAB_EMAILS.split(',').map(x => x.trim().toLowerCase()).includes(email)) {
        await authRequest(`recover?redirect_to=${encodeURIComponent(`${appOrigin()}/?recovery=1`)}`, { method: 'POST', data: { email } });
      }
      return res.status(200).json({ message: 'Se o e-mail estiver autorizado, você receberá um link para definir sua senha. Confira também o spam.' });
    }
    if (action === 'recovery-session') {
      if (typeof body.accessToken !== 'string' || body.accessToken.length > 8192 || typeof body.refreshToken !== 'string' || body.refreshToken.length > 8192) throw new AuthError(400, 'Link de recuperação inválido');
      const user = await authRequest('user', { access: body.accessToken });
      if (!allowedUser(user)) throw new AuthError(403, 'Esta conta não tem acesso ao Trade Lab');
      setSession(res, { access_token: body.accessToken, refresh_token: body.refreshToken, expires_in: 3600 });
      return res.status(200).json({ authenticated: true });
    }
    if (action === 'refresh') {
      const refresh = cookieTokens(req).refresh;
      if (!refresh || refresh.length > 8192) throw new AuthError(401, 'Entre novamente para continuar');
      const session = await authRequest('token?grant_type=refresh_token', { method: 'POST', data: { refresh_token: refresh } });
      if (!allowedUser(session.user)) throw new AuthError(403, 'Esta conta não tem acesso ao Trade Lab');
      setSession(res, session);
      return res.status(200).json({ authenticated: true });
    }
    if (action === 'reset') {
      const { access } = await requireUser(req);
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) return res.status(400).json({ error: 'Use uma senha entre 12 e 128 caracteres' });
      await authRequest('user', { method: 'PUT', access, data: { password: body.password } });
      clearSession(res);
      try { await authRequest('logout?scope=local', { method: 'POST', access }); }
      catch (error) { if (error.status === 503) return res.status(200).json({ message: 'Senha definida. Entre novamente. A revogação no serviço não pôde ser confirmada agora.' }); }
      return res.status(200).json({ message: 'Senha definida. Entre com seu e-mail e a nova senha.' });
    }
  } catch (error) {
    if (action !== 'session' && [401, 403].includes(error.status)) clearSession(res);
    return res.status(error.status ?? 503).json({ error: error instanceof AuthError ? error.message : 'Não foi possível concluir o acesso; tente novamente' });
  }
}
