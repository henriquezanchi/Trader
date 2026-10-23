let connected = false, paused = false, version = null, catalogue = [], profiles = {}, dirty = false, busy = false;
const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const date = value => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fields = ['exposurePct', 'orderPct', 'dailyLossPct', 'totalLossPct', 'targetPct', 'days'];
async function authCall(action, body) {
  const response = await fetch(`/api/auth?action=${action}`, { method: action === 'session' ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(action === 'session' ? {} : { body: JSON.stringify(body ?? {}) }), cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error ?? 'Não foi possível acessar a conta'); error.status = response.status; throw error; }
  return data;
}
async function request(action = 'status', body, retry = true, before) {
  const response = await fetch(`/api/agent?action=${action}${before ? `&before=${encodeURIComponent(before)}` : ''}`, { method: ['status', 'audit'].includes(action) ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(35000) });
  if (response.status === 401 && retry) { await authCall('refresh'); return request(action, body, false, before); }
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error ?? 'Serviço indisponível'); error.status = response.status; throw error; }
  return data;
}
function showLogin() {
  connected = false; version = null; dirty = false;
  $('dashboard').hidden = true; $('audit-panel').hidden = true; $('audit-entries').replaceChildren(); $('reset-panel').hidden = true; $('login').hidden = false;
  $('password').value = ''; $('new-password').value = ''; $('confirm-password').value = '';
}
function sequenceLength(observations) {
  if (!observations.length) return 0;
  let n = 1;
  for (let i = observations.length - 1; i > 0; i--) {
    if (Date.parse(observations[i].at) - Date.parse(observations[i - 1].at) > 90 * 60000) break;
    n++;
  }
  // A stale sequence cannot be used for a new decision without collecting again.
  return Date.now() - Date.parse(observations.at(-1).at) > 90 * 60000 ? 0 : Math.min(n, 24);
}
function cells(parent, texts) {
  const row = document.createElement('tr');
  for (const text of texts) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
  parent.append(row);
}
function fillSettings(c) {
  $('profile').value = c.profile;
  for (const key of fields) $(key).value = c[key];
  for (const a of catalogue) $(`weight-${a.id}`).value = c.allocations[a.id] ?? 0;
  mixSummary();
}
function mixSummary() {
  const sum = catalogue.reduce((v, a) => v + Number($(`weight-${a.id}`).value), 0);
  $('mix-summary').textContent = `Pesos: ${sum.toFixed(1)}% · reserva mínima planejada: ${(100 - sum).toFixed(1)}% · limites em % do capital virtual inicial`;
}
function render(data) {
  const s = data.state; version = data.version; connected = true; $('reset-panel').hidden = true;
  if (!catalogue.length) {
    catalogue = data.assets; profiles = data.profiles;
    for (const a of catalogue) {
      const label = document.createElement('label'); label.textContent = `${a.name} (${a.symbol}) · peso máximo (%)`;
      const input = document.createElement('input'); input.id = `weight-${a.id}`; input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '0.1'; input.required = true; label.append(input); $('asset-inputs').append(label);
    }
  }
  $('dashboard').hidden = false; $('audit-panel').hidden = false; $('login').hidden = true;
  const holdings = s.portfolio ?? { bitcoin: { quantity: s.btc, lastPrice: s.lastPrice, observations: s.observations } };
  const exposure = Object.values(holdings).reduce((v, p) => v + p.quantity * (p.lastPrice ?? 0), 0), total = s.cash + exposure;
  $('equity').textContent = money(total); $('cash').textContent = money(s.cash);
  $('result').textContent = `${money(total - s.initialCapital)} desde o início`;
  $('exposure').textContent = money(exposure);
  $('position').textContent = `${total > 0 ? (exposure / total * 100).toFixed(1) : '0'}% do patrimônio atual`;
  $('last-cycle').textContent = s.lastTick ? date(`${s.lastTick}:00:00Z`) : 'Não executado';
  $('updated').textContent = 'Confira a continuidade da coleta abaixo';
  paused = s.paused;
  $('status').textContent = paused ? 'Pausado' : s.startedAt ? 'Habilitado para ciclos' : 'Simulação habilitada';
  $('pause').textContent = paused ? 'Iniciar / retomar' : 'Pausar';
  $('reason').textContent = s.reason;
  $('warmup').textContent = 'Cada ativo precisa de 24 observações horárias consecutivas. O botão iniciar habilita o motor; fechar esta aba não configura o agendador. Acompanhe a última execução.';
  $('settings-fields').disabled = false;
  $('save-settings').disabled = !paused || busy;
  $('pause-settings').hidden = paused;
  $('bootstrap').hidden = !s.config || Boolean(s.bootstrap) || Object.values(holdings).some(p => p.quantity > 0);
  $('bootstrap').disabled = paused || busy;
  $('config-state').textContent = s.config ? `Perfil base: ${profiles[s.config.profile].label} · ajustes personalizados` : 'Motor original BTC; escolha um perfil para preparar sua carteira';
  $('config-note').textContent = paused ? 'Edite os parâmetros e salve antes de iniciar. Ativos com posição aberta só podem ser removidos após a saída pelo motor.' : 'Você pode explorar e ajustar os perfis. Para aplicar as mudanças, clique em Pausar para salvar e depois em Salvar carteira e limites.';
  if (!dirty) fillSettings(s.config ?? { profile: 'moderado', ...profiles.moderado });
  $('holdings').replaceChildren();
  for (const a of catalogue) {
    const p = holdings[a.id];
    cells($('holdings'), [a.symbol, a.risk, a.potential, s.config ? `${s.config.allocations[a.id] ?? 0}%` : a.id === 'bitcoin' ? 'Legado' : 'Não selecionado', p ? `${p.quantity.toFixed(8)} · ${money(p.quantity * (p.lastPrice ?? 0))}` : '—', p?.lastPrice ? money(p.lastPrice) : 'Sem cotação', `${sequenceLength(p?.observations ?? [])}/24 consecutivas · ${p?.observations?.length ?? 0} mantidas`]);
  }
  const cutoff = Date.now() - 24 * 3600000;
  const recentEvents = s.events.filter(e => Date.parse(e.at) >= cutoff);
  const trades = recentEvents.filter(e => ['COMPRAR', 'VENDER'].includes(e.action)).length;
  const selected = s.config ? Object.keys(s.config.allocations) : ['bitcoin'];
  const cycles = new Set([...recentEvents.map(e => e.at), ...selected.flatMap(id => (holdings[id]?.observations ?? []).filter(o => !o.historical && Date.parse(o.at) >= cutoff).map(o => o.at))]);
  const historicalSamples = selected.reduce((n, id) => n + (holdings[id]?.observations ?? []).filter(o => o.historical).length, 0);
  const warming = selected.some(id => sequenceLength(holdings[id]?.observations ?? []) < 24);
  $('activity-summary').textContent = `${cycles.size} ciclos ao vivo registrados · ${historicalSamples} amostras históricas para indicadores · ${trades} compras ou vendas simuladas · ${recentEvents.filter(e => e.action === 'AGUARDAR').length} decisões de aguardar.`;
  $('activity-reason').textContent = trades ? 'Veja as decisões e seus motivos no diário abaixo.' : warming ? 'Sem negociações: a sequência de 24 observações horárias ainda não está completa. Intervalos maiores que 90 minutos interrompem a sequência. Sem posições, o caixa virtual não rende.' : s.paused ? 'A simulação está pausada. Veja os motivos no diário abaixo.' : 'A janela de dados está completa; o motor aguarda um sinal e respeita os limites configurados.';
  $('events').replaceChildren();
  for (const event of [...s.events].reverse()) {
    const symbol = catalogue.find(a => a.id === (event.asset ?? 'bitcoin'))?.symbol ?? '';
    cells($('events'), [date(event.at), `${symbol} · ${event.action}`, event.reason, money(event.fee), money(event.equity)]);
  }
  $('empty').textContent = s.events.length ? '' : 'Nenhum ciclo executado ainda.';
  const values = s.events.map(x => x.equity);
  const lo = Math.min(s.initialCapital, ...values) - .1, hi = Math.max(s.initialCapital, ...values) + .1;
  $('line').setAttribute('d', values.map((v, i) => `${i ? 'L' : 'M'} ${10 + i * 780 / Math.max(1, values.length - 1)} ${150 - (v - lo) / (hi - lo) * 140}`).join(' '));
  $('chart-note').textContent = values.length < 2 ? 'O gráfico aparece após dois registros.' : `De ${money(Math.min(...values))} a ${money(Math.max(...values))} · líquido das taxas simuladas`;
}
async function update(action = 'status', body) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const data = await request(action, body);
    if (action === 'configure') dirty = false;
    render(data);
    const latest = data.state.lastTick && Date.parse(`${data.state.lastTick}:00:00Z`);
    const stale = latest && Date.now() - latest > 90 * 60000;
    $('message').textContent = stale ? 'Sem ciclo há mais de 90 minutos. Confira o agendador e o relatório privado.' : `Conectado · consultado às ${date(Date.now())}${data.duplicate ? ' · Hora já processada' : ''}${action === 'configure' ? ' · Carteira salva, ainda pausada' : action === 'bootstrap' ? ' · Histórico real preparado; ciclo atual avaliado' : ''}`;
  } catch (error) { if ([401, 403].includes(error.status)) showLogin(); $('message').textContent = error.message; }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); $('save-settings').disabled = !paused; $('bootstrap').disabled = paused; }
}
$('settings').addEventListener('input', () => { dirty = true; mixSummary(); });
$('profile').addEventListener('change', () => { const profile = $('profile').value; fillSettings({ ...profiles[profile], profile }); dirty = true; });
$('settings').addEventListener('submit', event => {
  event.preventDefault();
  if (!paused) { $('message').textContent = 'Pause a simulação antes de salvar a carteira.'; return; }
  const config = { profile: $('profile').value, allocations: {} };
  for (const key of fields) config[key] = Number($(key).value);
  for (const a of catalogue) { const value = Number($(`weight-${a.id}`).value); if (value) config.allocations[a.id] = value; }
  update('configure', { config, expectedVersion: version });
});
$('connect').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('password').value; $('password').value = '';
  const button = event.submitter; button.disabled = true;
  try { await authCall('login', { email: $('email').value.trim(), password }); dirty = false; connected = true; await update(); }
  catch (error) { showLogin(); $('message').textContent = error.message; }
  finally { button.disabled = false; }
});
$('recover').addEventListener('click', async () => {
  if (!$('email').reportValidity()) return;
  $('recover').disabled = true;
  try { const data = await authCall('recover', { email: $('email').value.trim() }); $('message').textContent = data.message; }
  catch (error) { $('message').textContent = error.message; }
  finally { $('recover').disabled = false; }
});
$('reset-password').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('new-password').value !== $('confirm-password').value) { $('message').textContent = 'As senhas precisam ser iguais'; return; }
  const password = $('new-password').value; $('new-password').value = ''; $('confirm-password').value = '';
  event.submitter.disabled = true;
  try { const data = await authCall('reset', { password }); showLogin(); $('message').textContent = data.message; }
  catch (error) { $('message').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});
$('refresh').addEventListener('click', () => update());
$('tick').addEventListener('click', () => update('tick'));
$('bootstrap').addEventListener('click', () => update('bootstrap'));
$('pause').addEventListener('click', () => update(paused ? 'resume' : 'pause'));
$('pause-settings').addEventListener('click', () => update('pause'));
$('disconnect').addEventListener('click', async () => {
  try { await authCall('logout'); showLogin(); $('message').textContent = 'Você saiu da conta'; }
  catch (error) { showLogin(); $('message').textContent = error.message; }
});
setInterval(() => { if (connected && !dirty && !document.hidden && !$('dashboard').hidden) update(); }, 60000);
async function restoreSession() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const recovery = hash.get('type') === 'recovery' || new URLSearchParams(location.search).get('recovery') === '1';
  const accessToken = hash.get('access_token'), refreshToken = hash.get('refresh_token');
  // Remove link credentials before making any request; never store tokens in localStorage.
  if (location.hash || location.search.includes('recovery')) history.replaceState(null, '', location.pathname);
  if (recovery) {
    try {
      if (!accessToken || !refreshToken) throw new Error('Link inválido ou expirado. Solicite um novo link com seu e-mail.');
      await authCall('recovery-session', { accessToken, refreshToken });
      $('login').hidden = true; $('dashboard').hidden = true; $('reset-panel').hidden = false;
      $('message').textContent = 'Defina sua senha para concluir o acesso';
    } catch (error) { showLogin(); $('message').textContent = error.message; }
    return;
  }
  try {
    try { await authCall('session'); } catch (error) { if (error.status !== 401) throw error; await authCall('refresh'); }
    connected = true; await update();
  } catch (error) { if (error.status !== 401) $('message').textContent = error.message; }
}
restoreSession();

let auditCursor = null;
async function loadAudit(before = null) {
  if (!connected) return;
  $('audit-refresh').disabled = true; $('audit-more').disabled = true;
  try {
    const data = await request('audit', undefined, true, before);
    if (!before) $('audit-entries').replaceChildren();
    for (const entry of data.entries) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      const decisions = (entry.decisions ?? []).map(d => `${catalogue.find(a => a.id === (d.asset ?? 'bitcoin'))?.symbol ?? ''}: ${d.action} — ${d.reason}`).join(' · ');
      summary.textContent = `${date(entry.recorded_at)} · versão ${entry.state_version} · ${entry.kind === 'legacy_snapshot' ? 'Legado: parâmetros históricos não registrados' : entry.kind} · ${decisions || 'Alteração de configuração ou controle'}`;
      const pre = document.createElement('pre'); pre.textContent = JSON.stringify(entry, null, 2); details.append(summary, pre); $('audit-entries').append(details);
    }
    auditCursor = data.nextCursor; $('audit-more').hidden = !auditCursor;
    $('audit-message').textContent = data.entries.length ? 'Abra um registro para inspecionar os parâmetros e indicadores.' : 'Nenhum registro anterior nesta página.';
  } catch (error) { if ([401, 403].includes(error.status)) showLogin(); $('audit-message').textContent = error.message; }
  finally { $('audit-refresh').disabled = false; $('audit-more').disabled = false; }
}
$('audit-refresh').addEventListener('click', () => loadAudit());
$('audit-more').addEventListener('click', () => loadAudit(auditCursor));
