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
  const response = await fetch(`/api/agent?action=${action}${before ? `&before=${encodeURIComponent(before)}` : ''}`, { method: ['status', 'audit', 'opportunities', 'research'].includes(action) ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(35000) });
  if (response.status === 401 && retry) { await authCall('refresh'); return request(action, body, false, before); }
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error ?? 'Serviço indisponível'); error.status = response.status; throw error; }
  return data;
}
function showLogin() {
  connected = false; version = null; dirty = false;
  $('dashboard').hidden = true; $('audit-panel').hidden = true; $('audit-entries').replaceChildren(); $('reset-panel').hidden = true; $('login').hidden = false;
  clearProposal(); $('assist-enabled').checked = false; $('assist-opportunities').replaceChildren(); $('research-entries').replaceChildren();
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
  if (currentProposal && currentProposal.version !== data.version) { clearProposal(); $('assist-status').textContent = 'A carteira mudou; solicite uma nova proposta.'; }
  renderIntelligence(s);
  const activeAssets = [...new Set([...Object.keys(s.config?.allocations ?? {}), ...Object.keys(s.portfolio ?? {}).filter(id => s.portfolio[id].quantity > 0)])];
  const chosen = $('assist-asset').value; $('assist-asset').replaceChildren();
  for (const id of activeAssets) { const o = document.createElement('option'); o.value = id; o.textContent = catalogue.find(a => a.id === id)?.symbol ?? id; $('assist-asset').append(o); }
  if (activeAssets.includes(chosen)) $('assist-asset').value = chosen;
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
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); $('save-settings').disabled = !paused; $('bootstrap').disabled = paused; syncProposalButton(); }
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
setInterval(async () => { if (connected && !dirty && !document.hidden && !$('dashboard').hidden) { await update(); if ($('assist-enabled').checked && !currentProposal) await scanOpportunities(); } }, 60000);
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

let currentProposal = null, assistBusy = false, researchCursor = null;
function clearProposal() { currentProposal = null; $('proposal-card').hidden = true; }
function syncProposalButton() {
  const valid = currentProposal && Date.now() < currentProposal.expiresAt;
  $('proposal-confirm').disabled = !valid || assistBusy || busy;
  if (currentProposal) $('proposal-expiry').textContent = valid ? `Válida por mais ${Math.ceil((currentProposal.expiresAt - Date.now()) / 1000)} segundos` : 'Proposta vencida. Consulte o mercado novamente.';
}
async function scanOpportunities() {
  if (!connected || assistBusy || document.hidden) return;
  assistBusy = true; $('assist-scan').disabled = true;
  try {
    const data = await request('opportunities'); $('assist-opportunities').replaceChildren();
    for (const item of data.opportunities) {
      const card = document.createElement('article'), title = document.createElement('h3'), info = document.createElement('p'), button = document.createElement('button');
      title.textContent = `${catalogue.find(a => a.id === item.asset)?.symbol ?? item.asset} · ${item.action}`;
      info.textContent = `${money(item.price)} · fonte às ${date(item.observedAt)}. ${item.reason}`;
      card.append(title, info);
      if (item.action !== 'AGUARDAR') { button.textContent = `Ver proposta de ${item.action === 'COMPRAR' ? 'compra' : 'venda'}`; button.addEventListener('click', () => previewOrder({ asset: item.asset, action: item.action })); card.append(button); }
      $('assist-opportunities').append(card);
    }
    $('assist-status').textContent = `Mercado consultado às ${date(data.asOf)}. Consultar e abrir uma proposta não movimentam a carteira.`;
  } catch (e) { $('assist-opportunities').replaceChildren(); clearProposal(); if ([401, 403].includes(e.status)) showLogin(); $('assist-status').textContent = `${e.message}. Sugestões anteriores removidas; consulte novamente para obter dados atualizados.`; }
  finally { assistBusy = false; $('assist-scan').disabled = false; syncProposalButton(); }
}
async function previewOrder(order) {
  if (assistBusy || !connected) return;
  assistBusy = true; clearProposal();
  try {
    const { proposal: p } = await request('preview', order); currentProposal = p;
    $('proposal-title').textContent = `${p.action === 'COMPRAR' ? 'Comprar' : 'Vender'} ${catalogue.find(a => a.id === p.asset)?.symbol ?? p.asset} · somente simulação`;
    $('proposal-summary').textContent = `${p.quantity.toFixed(8)} unidades · preço de execução estimado ${money(p.executionPrice)} · taxa ${money(p.fee)} · ${p.action === 'COMPRAR' ? 'débito' : 'crédito'} ${money(Math.abs(p.amount))}.`;
    $('proposal-impact').textContent = `Saldo após operação: ${money(p.after.cash)}. Patrimônio marcado ao preço atual: ${money(p.after.equity)} (impacto inicial ${money(p.after.equity - p.before.equity)}).${p.realizedPnl != null ? ` Resultado realizado estimado da posição: ${money(p.realizedPnl)}.` : ''}`;
    $('proposal-scenarios').replaceChildren();
    for (const row of p.scenarios) cells($('proposal-scenarios'), [`${row.changePct > 0 ? '+' : ''}${row.changePct}%`, money(row.equityAfterExit), money(row.differenceVsBefore)]);
    $('proposal-confirm').textContent = `Confirmar ${p.action === 'COMPRAR' ? 'compra' : 'venda'} simulada`;
    $('proposal-card').hidden = false; $('proposal-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { if ([401, 403].includes(e.status)) showLogin(); $('assist-status').textContent = e.message; }
  finally { assistBusy = false; syncProposalButton(); }
}
$('assist-scan').addEventListener('click', scanOpportunities);
$('assist-enabled').addEventListener('change', () => { if ($('assist-enabled').checked) scanOpportunities(); });
$('assist-action').addEventListener('change', () => { $('assist-amount-label').hidden = $('assist-action').value !== 'COMPRAR'; });
$('assisted-form').addEventListener('submit', event => {
  event.preventDefault(); const body = { asset: $('assist-asset').value, action: $('assist-action').value };
  if (body.action === 'COMPRAR' && $('assist-amount').value) body.amount = Number($('assist-amount').value);
  previewOrder(body);
});
$('proposal-cancel').addEventListener('click', clearProposal);
$('proposal-confirm').addEventListener('click', async () => {
  if (!currentProposal || assistBusy || Date.now() >= currentProposal.expiresAt) return;
  const token = currentProposal.token; assistBusy = true; syncProposalButton();
  try {
    const data = await request('confirm', { token }); clearProposal(); render(data);
    $('assist-status').textContent = `Operação simulada registrada: ${data.execution.action}. Taxa ${money(data.execution.fee)}. Consulte o diário e o relatório privado.`;
  } catch (e) { clearProposal(); if ([401, 403].includes(e.status)) showLogin(); $('assist-status').textContent = e.message; }
  finally { assistBusy = false; syncProposalButton(); }
});
setInterval(syncProposalButton, 1000);
function renderIntelligence(s) {
  const r = s.intelligence, latest = r?.latest;
  $('model-metrics').replaceChildren(); $('shadow-results').replaceChildren(); $('news-list').replaceChildren();
  $('intelligence-status').textContent = s.researchError?.message ?? (r ? `Pesquisa atualizada em ${date(r.updatedAt)}. Modelo de 6h: ${r.metrics[6].trained}/100 resultados para liberar entradas na carteira experimental. Sem troca automática do motor principal.` : 'A pesquisa começará no próximo ciclo; você também pode atualizar agora.');
  if (!r) { $('news-sources').textContent = 'Fontes ainda não consultadas.'; return; }
  for (const h of [1, 6, 24]) {
    const m = r.metrics[h], card = document.createElement('article'), title = document.createElement('h3'), p = document.createElement('p');
    title.textContent = `Horizonte ${h}h`; p.textContent = `${m.scored} resultados avaliados · ${m.missed} sem preço adequado · acerto ${m.accuracy == null ? 'sem dados' : `${(m.accuracy * 100).toFixed(1)}%`} · Brier ${m.brier == null ? 'sem dados' : m.brier.toFixed(3)} (menor é melhor).`; card.append(title, p); $('model-metrics').append(card);
  }
  for (const row of latest?.experiment?.summaries ?? []) cells($('shadow-results'), [{ baseline: 'Referência MA 6/24', 'rsi-confirmed': 'Tendência + RSI', learned: 'Modelo aprendido' }[row.id], `${row.returnPct.toFixed(2)}%`, `${row.maxDrawdownPct.toFixed(2)}%`, String(row.trades), row.status === 'learning' ? 'Aprendendo, sem entradas' : row.paused ? 'Pausada por limite' : 'Somente pesquisa']);
  const benchmark = latest?.experiment?.benchmark;
  if (benchmark) cells($('shadow-results'), ['Comprar e manter o mix', `${benchmark.returnPct.toFixed(2)}%`, 'Não calculado', 'Compra inicial', 'Benchmark sem stops']);
  $('news-sources').textContent = (r.news?.sources ?? []).map(source => `${source.source}: ${source.status}`).join(' · ');
  for (const item of r.news?.items ?? []) {
    const p = document.createElement('p'), link = document.createElement('a'), meta = document.createElement('small');
    link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = item.title;
    meta.textContent = ` · ${item.publisher} · publicado ${date(item.publishedAt)} · observado ${date(item.firstSeenAt)} · tom lexical ${item.score.toFixed(1)}`;
    p.append(link, meta); $('news-list').append(p);
  }
}
$('research-refresh').addEventListener('click', () => update('research-refresh'));
async function loadResearch(before = null) {
  if (!connected) return;
  $('research-log').disabled = true; $('research-more').disabled = true;
  try {
    const data = await request('research', undefined, true, before);
    if (!before) $('research-entries').replaceChildren();
    for (const entry of data.entries) {
      const detail = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
      summary.textContent = `${date(entry.recorded_at)} · pesquisa da versão ${entry.state_version}`; pre.textContent = JSON.stringify(entry.data, null, 2); detail.append(summary, pre); $('research-entries').append(detail);
    }
    researchCursor = data.nextCursor; $('research-more').hidden = !researchCursor; $('research-message').textContent = 'Registros com fontes, indicadores, previsões e resultados disponíveis depois de cada horizonte.';
  } catch (e) { if ([401, 403].includes(e.status)) showLogin(); $('research-message').textContent = e.message; }
  finally { $('research-log').disabled = false; $('research-more').disabled = false; }
}
$('research-log').addEventListener('click', () => loadResearch());
$('research-more').addEventListener('click', () => loadResearch(researchCursor));
restoreSession();
