const base = process.env.BOT_URL;
const token = process.env.BOT_TOKEN;
if (!base || !token || !base.startsWith('https://')) throw new Error('Configure BOT_URL (HTTPS) e BOT_TOKEN nos secrets do GitHub');
const url = new URL('/api/agent?action=tick', base);
const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(45000) });
if (!res.ok) throw new Error(`Tick falhou (HTTP ${res.status}). Confira os logs do servidor e o painel`);
const result = await res.json();
console.log(result.duplicate ? 'Hora já processada; nenhuma operação duplicada' : 'Ciclo simulado registrado');
