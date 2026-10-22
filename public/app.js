let token = '', paused = false, version = null, catalogue = [], profiles = {}, dirty = false, busy = false;
const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const date = value => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fields = ['exposurePct', 'orderPct', 'dailyLossPct', 'totalLossPct', 'targetPct', 'days'];
async function request(action = 'status', body) {
  const response = await fetch(`/api/agent?action=${action}`, { method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(35000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Serviço indisponível');
  return data;
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
  const s = data.state; version = data.version;
  if (!catalogue.length) {
    catalogue = data.assets; profiles = data.profiles;
    for (const a of catalogue) {
      const label = document.createElement('label'); label.textContent = `${a.name} (${a.symbol}) · peso máximo (%)`;
      const input = document.createElement('input'); input.id = `weight-${a.id}`; input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '0.1'; input.required = true; label.append(input); $('asset-inputs').append(label);
    }
  }
  $('dashboard').hidden = false; $('login').hidden = true;
  const holdings = s.portfolio ?? { bitcoin: { quantity: s.btc, lastPrice: s.lastPrice, observations: s.observations } };
  const exposure = Object.values(holdings).reduce((v, p) => v + p.quantity * (p.lastPrice ?? 0), 0), total = s.cash + exposure;
  $('equity').textContent = money(total); $('cash').textContent = money(s.cash);
  $('result').textContent = `${money(total - s.initialCapital)} desde o início`;
  $('exposure').textContent = money(exposure);
  $('position').textContent = `${total > 0 ? (exposure / total * 100).toFixed(1) : '0'}% do patrimônio atual`;
  $('last-cycle').textContent = s.lastTick ? date(`${s.lastTick}:00:00Z`) : 'Não executado';
  $('updated').textContent = 'Ciclos horários; agendamento externo necessário';
  paused = s.paused;
  $('status').textContent = paused ? 'Pausado' : s.startedAt ? 'Habilitado para ciclos' : 'Simulação habilitada';
  $('pause').textContent = paused ? 'Iniciar / retomar' : 'Pausar';
  $('reason').textContent = s.reason;
  $('warmup').textContent = 'Cada ativo precisa de 24 observações horárias consecutivas. O botão iniciar habilita o motor; fechar esta aba não configura o agendador. Acompanhe a última execução.';
  $('settings-fields').disabled = false;
  $('save-settings').disabled = !paused || busy;
  $('pause-settings').hidden = paused;
  $('config-state').textContent = s.config ? `Perfil base: ${profiles[s.config.profile].label} · ajustes personalizados` : 'Motor original BTC; escolha um perfil para preparar sua carteira';
  $('config-note').textContent = paused ? 'Edite os parâmetros e salve antes de iniciar. Ativos com posição aberta só podem ser removidos após a saída pelo motor.' : 'Você pode explorar e ajustar os perfis. Para aplicar as mudanças, clique em Pausar para salvar e depois em Salvar carteira e limites.';
  if (!dirty) fillSettings(s.config ?? { profile: 'moderado', ...profiles.moderado });
  $('holdings').replaceChildren();
  for (const a of catalogue) {
    const p = holdings[a.id];
    cells($('holdings'), [a.symbol, a.risk, a.potential, s.config ? `${s.config.allocations[a.id] ?? 0}%` : a.id === 'bitcoin' ? 'Legado' : 'Não selecionado', p ? `${p.quantity.toFixed(8)} · ${money(p.quantity * (p.lastPrice ?? 0))}` : '—', p?.lastPrice ? money(p.lastPrice) : 'Sem cotação', `${p?.observations?.length ?? 0} observações`]);
  }
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
    $('message').textContent = stale ? 'Sem ciclo há mais de 90 minutos. Confira o agendamento no GitHub.' : `Conectado · consultado às ${date(Date.now())}${data.duplicate ? ' · Hora já processada' : ''}${action === 'configure' ? ' · Carteira salva, ainda pausada' : ''}`;
  } catch (error) { $('message').textContent = error.message; }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); $('save-settings').disabled = !paused; }
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
$('connect').addEventListener('submit', event => { event.preventDefault(); token = $('token').value.trim(); $('token').value = ''; dirty = false; update(); });
$('refresh').addEventListener('click', () => update());
$('tick').addEventListener('click', () => update('tick'));
$('pause').addEventListener('click', () => update(paused ? 'resume' : 'pause'));
$('pause-settings').addEventListener('click', () => update('pause'));
$('disconnect').addEventListener('click', () => { token = ''; version = null; dirty = false; $('dashboard').hidden = true; $('login').hidden = false; $('message').textContent = 'Desconectado'; });
setInterval(() => { if (token && !dirty && !document.hidden && !$('dashboard').hidden) update(); }, 60000);
