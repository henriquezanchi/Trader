let discoveredAssets = {},currentViewState=null;
let connected = false, paused = false, version = null, catalogue = [], profiles = {}, dirty = false, busy = false;
const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const date = value => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fields = ['exposurePct', 'orderPct', 'dailyLossPct', 'totalLossPct', 'targetPct', 'days', 'discoveryPct', 'learningExplorationPct'];
async function authCall(action, body) {
  const response = await fetch(`/api/auth?action=${action}`, { method: action === 'session' ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(action === 'session' ? {} : { body: JSON.stringify(body ?? {}) }), cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error ?? 'Não foi possível acessar a conta'); error.status = response.status; throw error; }
  return data;
}
async function request(action = 'status', body, retry = true, before, query = {}) {
  const response = await fetch(`/api/agent?action=${action}${before ? `&before=${encodeURIComponent(before)}` : ''}${Object.entries(query).map(([k,v])=>'&'+encodeURIComponent(k)+'='+encodeURIComponent(v)).join('')}`, { method: ['status', 'audit', 'opportunities', 'research', 'quality', 'chart', 'chart-cycle', 'scenario-report'].includes(action) ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(35000) });
  if (response.status === 401 && retry) { await authCall('refresh'); return request(action, body, false, before, query); }
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error ?? 'Serviço indisponível'); error.status = response.status; throw error; }
  return data;
}
function showLogin() {
  connected = false; version = null; dirty = false; chartCache=null; chartRequestId++; chartLoading=false; scenarioCache=null;scenarioRequestId++;scenarioLoading=false;
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
  return row;
}
function fillSettings(c) {
  $('profile').value = c.profile;
  $('crypto-strategy').value=c.cryptoStrategy??'trend';
  for (const key of fields) $(key).value = key==='learningExplorationPct'?(c.learningExplorationPct??20):key==='discoveryPct'?(c.discoveryPct??(c.profile.includes('agressivo')?15:c.profile.includes('conservador')?0:5)):c[key];
  for (const a of catalogue) $(`weight-${a.id}`).value = c.allocations[a.id] ?? 0;
  mixSummary();
}
function mixSummary() {
  const sum = catalogue.reduce((v, a) => v + Number($(`weight-${a.id}`).value), 0);
  $('mix-summary').textContent = `Pesos: ${sum.toFixed(1)}% · reserva mínima planejada: ${(100 - sum).toFixed(1)}% · limites em % do capital virtual inicial`;
}
function render(data) {
  const s = data.state; discoveredAssets=s.discovery?.assets??{};currentViewState=s; version = data.version; connected = true; $('reset-panel').hidden = true;
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
  renderPerformance(s);
  renderFast(s);
  renderPredictions(s);
  renderLearning(s);
  renderScenarioLive(s);
  if((!scenarioCache||Date.now()-scenarioLoadedAt>300000)&&!scenarioLoading&&!scenarioRunning&&!document.querySelector('#scenario-results details[open]'))loadScenarioReports();
  const activeAssets = [...new Set([...Object.keys(s.config?.allocations ?? {}), ...Object.keys(s.portfolio ?? {}).filter(id => s.portfolio[id].quantity > 0)])];
  const chosen = $('assist-asset').value; $('assist-asset').replaceChildren();
  for (const id of activeAssets) { const o = document.createElement('option'); o.value = id; o.textContent = catalogue.find(a => a.id === id)?.symbol ?? id; $('assist-asset').append(o); }
  if (activeAssets.includes(chosen)) $('assist-asset').value = chosen;
  const holdings = s.portfolio ?? { bitcoin: { quantity: s.btc, lastPrice: s.lastPrice, observations: s.observations } };
  const exposure = Object.values(holdings).reduce((v, p) => v + p.quantity * (p.lastPrice ?? 0), 0) + Object.values(s.fast?.positions??{}).reduce((v,p)=>v+(p.market==='dex'?(p.liquidationValue??0):p.quantity*(p.lastPrice??0)),0), total = s.cash + exposure + (s.unsettled??[]).reduce((v,x)=>v+x.amount,0);
  $('equity').textContent = money(total); $('cash').textContent = money(s.cash);
  $('result').textContent = `${money(total - s.initialCapital)} desde o início`;
  $('exposure').textContent = money(exposure);
  $('position').textContent = `${total > 0 ? (exposure / total * 100).toFixed(1) : '0'}% do patrimônio atual`;
  $('last-cycle').textContent = s.lastTick ? date(`${s.lastTick}:00:00Z`) : 'Não executado';
  $('updated').textContent = 'Confira a continuidade da coleta abaixo';
  paused = s.paused;
  $('exploration-status').textContent=s.config?.simulationExploration?'Exploração simulada ativa: sem limites de perda e exposição, stop de perda ou bloqueios econômicos. Compras usam apenas o caixa virtual. Saídas por alvo, prazo ou sua ordem.'+(s.config.learningPolicy==='paper-entry-value-v1'?` Aprendizado de entradas: ${s.config.learningExplorationPct??20}% para testes; restante para oportunidades com evidência líquida favorável ou caixa.`:''):'Simulação com os limites do perfil.';
  $('exploration-toggle').textContent=s.config?.simulationExploration?'Restaurar limites e pausar':'Ativar exploração simulada';
  $('status').textContent = paused ? 'Pausado' : s.startedAt ? 'Habilitado para ciclos' : 'Simulação habilitada';
  $('pause').textContent = paused ? 'Iniciar / retomar' : 'Pausar';
  $('reason').textContent = `${s.reason}${s.dataStatus?.status==='unavailable'?` · ${s.dataStatus.message} (${date(s.dataStatus.at)})`:''}`;
  $('warmup').textContent = 'Cripto usa observações horárias; ETFs usam 24 pregões concluídos, obtidos da fonte. DCA semanal não exige janela técnica. O botão iniciar habilita o motor; fechar esta aba não configura o agendador. Acompanhe a última execução.';
  $('settings-fields').disabled = false;
  $('save-settings').disabled = !paused || busy;
  $('pause-settings').hidden = paused;
  $('bootstrap').hidden = Object.keys(s.config?.allocations??{}).some(id=>catalogue.find(a=>a.id===id)?.market==='b3') || !s.config || Boolean(s.bootstrap) || Object.values(holdings).some(p => p.quantity > 0);
  $('bootstrap').disabled = paused || busy;
  $('config-state').textContent = s.config ? `Perfil base: ${profiles[s.config.profile].label} · ajustes personalizados` : 'Motor original BTC; escolha um perfil para preparar sua carteira';
  $('config-note').textContent = paused ? 'Edite os parâmetros e salve antes de iniciar. Ativos com posição aberta só podem ser removidos após a saída pelo motor.' : 'Você pode explorar e ajustar os perfis. Para aplicar as mudanças, clique em Pausar para salvar e depois em Salvar carteira e limites.';
  if (!dirty) fillSettings(s.config ?? { profile: 'moderado', ...profiles.moderado });
  $('holdings').replaceChildren();
  for (const a of catalogue) {
    const p = holdings[a.id];
    cells($('holdings'), [a.symbol, a.risk, a.potential, s.config ? `${s.config.allocations[a.id] ?? 0}%` : a.id === 'bitcoin' ? 'Legado' : 'Não selecionado', p ? `${p.quantity.toFixed(8)} · ${money(p.quantity * (p.lastPrice ?? 0))}` : '—', p?.lastPrice ? money(p.lastPrice) : 'Sem cotação', a.market==='b3'?`${p?.dailyHistory?.length??0} pregões na fonte · cotas inteiras`:`${sequenceLength(p?.observations ?? [])}/24 consecutivas · ${p?.observations?.length ?? 0} mantidas`]);
  }
  const cutoff = Date.now() - 24 * 3600000;
  const recentEvents = s.events.filter(e => Date.parse(e.at) >= cutoff);
  const trades = recentEvents.filter(e => ['COMPRAR', 'VENDER'].includes(e.action)).length;
  const selected = s.config ? Object.keys(s.config.allocations) : ['bitcoin'];
  const cycles = new Set([...recentEvents.map(e => e.at), ...selected.flatMap(id => (holdings[id]?.observations ?? []).filter(o => !o.historical && Date.parse(o.at) >= cutoff).map(o => o.at))]);
  const historicalSamples = selected.reduce((n, id) => n + (holdings[id]?.observations ?? []).filter(o => o.historical).length, 0);
  const warming = !['dca-weekly','active'].includes(s.config?.cryptoStrategy) && selected.filter(id=>catalogue.find(a=>a.id===id)?.market!=='b3').some(id => sequenceLength(holdings[id]?.observations ?? []) < 24);
  $('activity-summary').textContent = `${cycles.size} ciclos ao vivo registrados · ${historicalSamples} amostras históricas para indicadores · ${trades} compras ou vendas simuladas · ${recentEvents.filter(e => e.action === 'AGUARDAR').length} decisões de aguardar.`;
  $('activity-reason').textContent = trades ? 'Veja as decisões e seus motivos no diário abaixo. Taxas e deslizamento contam no resultado e nos limites de perda.' : warming ? 'Sem negociações: a sequência de 24 observações horárias ainda não está completa. Intervalos maiores que 90 minutos interrompem a sequência. Sem posições, o caixa virtual não rende.' : s.paused ? 'A simulação está pausada. Veja os motivos no diário abaixo.' : s.config?.cryptoStrategy==='dca-weekly' ? 'DCA semanal: o ciclo verifica a data do próximo aporte e o teto de 5% em BTC; não é uma estratégia de trade diário.' : 'A janela de dados está completa; o motor aguarda um sinal e respeita os limites configurados.';
  const latestEvent=s.events.at(-1), latestCycle=latestEvent?s.events.filter(e=>e.at===latestEvent.at):[];
  $('diary-latest').textContent=latestEvent?`Último ciclo ${date(latestEvent.at)} · ${latestCycle.length} decisões · mais recente: ${catalogue.find(a=>a.id===latestEvent.asset)?.symbol??'Dados'} ${latestEvent.action}`:'Aguardando primeiro ciclo.';
  renderJournal(s.events);
  $('empty').textContent = s.events.length ? '' : 'Nenhum ciclo executado ainda.';
  renderChart(s);

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
    return true;
  } catch (error) { if ([401, 403].includes(error.status)) showLogin(); $('message').textContent = error.message; return false; }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); $('save-settings').disabled = !paused; $('bootstrap').disabled = paused; syncProposalButton(); }
}
$('settings').addEventListener('input', () => { dirty = true; mixSummary(); });
$('profile').addEventListener('change', () => { const profile = $('profile').value; fillSettings({ ...profiles[profile], profile, cryptoStrategy:$('crypto-strategy').value }); dirty = true; });
$('settings').addEventListener('submit', event => {
  event.preventDefault();
  if (!paused) { $('message').textContent = 'Pause a simulação antes de salvar a carteira.'; return; }
  const config = { simulationExploration:currentViewState?.config?.simulationExploration??false, learningPolicy:currentViewState?.config?.learningPolicy??'legacy', profile: $('profile').value, cryptoStrategy:$('crypto-strategy').value, allocations: {} };
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
      info.textContent = `${item.price?money(item.price):'Sem cotação'} · ${item.observedAt?`fonte às ${date(item.observedAt)}`:'fonte indisponível'}`;
      card.append(title, info);
      const why=document.createElement('details'),whyTitle=document.createElement('summary'),whyText=document.createElement('p');whyTitle.textContent='Ver decisão';whyText.textContent=item.reason;why.append(whyTitle,whyText);card.append(why);
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
    const { proposal: p } = await request(order.book==='fast'?'fast-preview':'preview', order); currentProposal = {...p,confirmAction:order.book==='fast'?'fast-confirm':'confirm'};
    $('proposal-title').textContent = `${p.action === 'COMPRAR' ? 'Comprar' : 'Vender'} ${assetLabel(p.asset)} · somente simulação`;
    $('proposal-summary').textContent = `${p.quantity.toFixed(8)} unidades · preço de execução estimado ${money(p.executionPrice)} · taxa ${money(p.fee)} · ${p.action === 'COMPRAR' ? 'débito' : 'crédito'} ${money(Math.abs(p.amount))}.${p.costs?.lot===1?' Cotas inteiras; emolumentos de 0,03% e deslizamento de 0,05%, corretagem assumida zero.':''}${p.estimatedTax?` Reserva tributária estimada: ${money(p.estimatedTax)}.`:''}${p.settlement?` Crédito disponível em ${p.settlement} (D+2).`:''}`;
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
  const token = currentProposal.token,confirmAction=currentProposal.confirmAction??'confirm'; assistBusy = true; syncProposalButton();
  try {
    const data = await request(confirmAction, { token }); clearProposal(); render(data);
    $('assist-status').textContent = `Operação simulada registrada: ${data.execution.action}. Taxa ${money(data.execution.fee)}. Consulte o diário e o relatório privado.`;
  } catch (e) { clearProposal(); if ([401, 403].includes(e.status)) showLogin(); $('assist-status').textContent = e.message; }
  finally { assistBusy = false; syncProposalButton(); }
});
setInterval(syncProposalButton, 1000);
function renderIntelligence(s) {
  const r = s.intelligence, latest = r?.latest;
  $('model-metrics').replaceChildren(); $('shadow-results').replaceChildren(); $('news-list').replaceChildren();
  $('intelligence-status').textContent = s.researchError?.message ?? (r ? `Pesquisa atualizada em ${date(r.updatedAt)}. Modelo de 6h: ${r.metrics?.[6]?.trained??0}/100 resultados para liberar entradas na carteira experimental. Sem troca automática do motor principal.` : 'A pesquisa começará no próximo ciclo; você também pode atualizar agora.');
  if (!r) { $('news-sources').textContent = 'Fontes ainda não consultadas.'; return; }
  for (const h of [1, 6, 24]) {
    const m = r.metrics?.[h]??{scored:0,missed:0,accuracy:null,brier:null}, card = document.createElement('article'), title = document.createElement('h3'), p = document.createElement('p');
    title.textContent = `Horizonte ${h}h`; p.textContent = `${m.scored} resultados avaliados · ${m.missed} sem preço adequado · acerto ${m.accuracy == null ? 'sem dados' : `${(m.accuracy * 100).toFixed(1)}%`} · Brier ${m.brier == null ? 'sem dados' : m.brier.toFixed(3)} (menor é melhor).`; card.append(title, p); $('model-metrics').append(card);
  }
  for (const row of latest?.experiment?.summaries ?? []) cells($('shadow-results'), [{ baseline: 'Referência MA 6/24', 'rsi-confirmed': 'Tendência + RSI', learned: 'Modelo aprendido', 'dca-weekly':'DCA semanal BTC · teto 5%', 'rsi-recovery':'Recuperação RSI' }[row.id], `${row.returnPct.toFixed(2)}%`, `${row.maxDrawdownPct.toFixed(2)}%`, String(row.trades), row.status === 'learning' ? 'Aprendendo, sem entradas' : row.paused ? 'Pausada por limite' : 'Somente pesquisa']);
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


function renderPerformance(s) {
  $('capital-upgrade').hidden=Boolean(s.capitalUpgrade)||s.initialCapital>=1000;
  $('capital-note').textContent=s.capitalUpgrade?`Capital contribuído: ${money(s.initialCapital)}. Aporte virtual de ${money(s.capitalUpgrade.amount)} em ${date(s.capitalUpgrade.at)}. Resultado anterior preservado: ${money(s.capitalUpgrade.resultBefore)}. Aporte não conta como lucro.`:`Capital contribuído: ${money(s.initialCapital)}. Elevar o capital adiciona somente a diferença em caixa virtual e preserva posições e resultado.`;
  const p=s.performance;$('performance-metrics').replaceChildren();
  if(p){for(const [label,value] of [['Resultado após custos',money(p.netPnl??0)],['Referência CDI bruto',p.cdi.through?money(p.cdi.equity):'Aguardando dias publicados'],['Maior queda desde o aporte',`${p.maxDrawdownPct.toFixed(2)}%`],['Tempo de observação',`${p.elapsedDays?.toFixed(1)??'0'} dias`]]){const box=document.createElement('article'),title=document.createElement('h3'),text=document.createElement('p');title.textContent=label;text.textContent=value;box.append(title,text);$('performance-metrics').append(box);}
  $('performance-note').textContent=`${p.conclusion??'Aguardando observações'}. CDI: ${p.cdi.status??'aguardando fonte'}${p.cdi.error?` (${p.cdi.error})`:''}${p.cdi.through?`, taxas consideradas até ${p.cdi.through}`:': nenhuma rentabilidade projetada'}. Comparação desde ${date(p.startedAt)}. Taxas dos fundos já integram o preço; impostos de cripto, spreads reais e qualidade da execução podem diferir.`;
  }else $('performance-note').textContent='A comparação começará com o aporte virtual, sem inventar rentabilidade passada.';
  const pending=(s.unsettled??[]).reduce((v,x)=>v+x.amount,0);$('settlement-note').textContent=pending?`${money(pending)} em liquidação D+2: incluído no patrimônio e indisponível para novas compras.`:'Nenhum valor em liquidação.';
}
$('capital-upgrade').addEventListener('click',()=>update('capital-upgrade'));

function renderFast(s){
 const active=s.config?.cryptoStrategy==='active',hybrid=active||s.config?.cryptoStrategy==='hybrid',f=s.fast;
 const type=s.config?.profile.includes('agressivo')?'agressivo':s.config?.profile.includes('conservador')?'conservador':'moderado';
 const blend={conservador:[80,20,.6,.8,1],moderado:[50,50,.5,1,4],agressivo:[30,70,.5,1.2,8]}[type];
 $('fast-status').textContent=s.config?.simulationExploration?'Exploração simulada: caixa disponível distribuído entre os ativos elegíveis, sem tetos do perfil nem stops de perda. Saídas curtas, intermediárias e pacientes são comparadas pelo resultado líquido. Pausar interrompe novas entradas.':active?`Ativo adaptativo ${type}: entradas por liquidez, cenário e evidência acumulada; previsão direcional orienta seleção e saídas antecipadas. Limites da posição são definidos na entrada e preservados. Novos pools compartilham o caixa, com teto de ${s.config.discoveryPct??0}% do capital. Fonte de descoberta: ${s.discovery?.status??'primeira consulta pendente'}.`:hybrid?`Híbrido ${type}: ${blend[0]}% cenário / ${blend[1]}% curto, dentro dos pesos de cripto. Entrada curta até ${blend[4]}% do capital por ativo, limitada ao saldo e exposição. Alvo líquido +${blend[2]}%; perda por posição de referência -${blend[3]}%. ${s.paused?'Simulação pausada.':'Habilitado para ciclos automáticos.'}`:'Escolha Híbrido em Estratégia automática para cripto e salve com a simulação pausada para habilitar as duas velocidades.';
 $('fast-cycle').textContent=f?.updatedAt?`Último ciclo curto: ${date(f.updatedAt)}`:'Aguardando primeiro ciclo curto';
 const stats=f?.stats;$('fast-stats').textContent=stats?`${stats.buys} compras · ${stats.sells} vendas · ${stats.wins} saídas positivas / ${stats.losses} negativas · resultado realizado ${money(stats.realizedPnl)} · taxas acumuladas ${money(stats.fees)}. Lucro líquido de trade inclui custos de entrada e saída; impostos de cripto não incluídos.`:'As primeiras entradas exigem cerca de 4–6 minutos de coleta nova e estabilização; esperar também é uma decisão registrada.';
 $('fast-holdings').replaceChildren();
 for(const [id,p] of Object.entries(f?.positions??{}))if(p.quantity>0){const net=p.quantity*p.lastPrice*.999*.999-p.costBasis;const row=cells($('fast-holdings'),[assetLabel(id),`${p.quantity.toFixed(8)} · ${money(p.market==='dex'?(p.liquidationValue??0):p.quantity*p.lastPrice)}${p.market==='dex'?' · saída estimada':''}`,id.startsWith('solana:')?'Consultar prévia: impacto e taxas variáveis':`${money(net)} (${(net/p.costBasis*100).toFixed(2)}%)`,p.userExit?'Programado pelo usuário':`+${p.plan?.takeProfitPct??blend[2]}%`,s.config?.simulationExploration?'Desligado':`-${p.plan?.stopPct??blend[3]}%`,'']);
 const actions=document.createElement('div');actions.className='actions';const sell=document.createElement('button'),schedule=document.createElement('button');sell.textContent='Vender agora';sell.addEventListener('click',()=>previewOrder({asset:id,action:'VENDER',book:'fast'}));schedule.textContent=p.userExit?'Editar programação':'Programar venda';schedule.className='secondary';schedule.addEventListener('click',()=>openSchedule(id,p));actions.append(sell,schedule);row.lastChild.append(actions);if(p.userExit){const note=document.createElement('small');note.textContent=`Programada: ${p.userExit.kind} ${p.userExit.kind==='time'?date(p.userExit.value):p.userExit.value}`;row.lastChild.append(note);}}
}

function renderJournal(events){
  const openReports=new Set([...$('events').children].filter(row=>row.querySelector('details')?.open).map(row=>row.dataset.eventId)),selectedCycle=[...$('events').children].find(row=>row.classList.contains('selected-cycle'))?.dataset.cycle;
  $('events').replaceChildren();
  for (const event of [...events].reverse().sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))) {
    const symbol = event.action==='APORTE'?'':event.assetSymbol??assetLabel(event.asset??'bitcoin');
    const row=cells($('events'), [date(event.at), `${symbol} · ${event.action}${event.mode==='fast'?' · CURTO':event.mode==='assisted'?' · ASSISTIDO':event.mode==='core'?' · CENÁRIO':event.mode==='data'?' · DADOS':''}`, '', money(event.fee??0), money(event.equity)]);
    const action=event.action??'';row.dataset.action=action;
    row.classList.add(action==='AGUARDAR'?'decision-wait':'decision-action');
    if(action==='COMPRAR')row.classList.add('decision-buy');
    else if(action==='VENDER')row.classList.add('decision-sell');
    if(action!=='AGUARDAR'){const badge=document.createElement('span');badge.className='decision-badge';badge.textContent=row.children[1].textContent;row.children[1].replaceChildren(badge);}
    row.dataset.cycle=new Date(event.at).toISOString();row.dataset.eventId=event.id??`${event.at}:${event.asset}:${event.action}`;if(row.dataset.cycle===selectedCycle)row.classList.add('selected-cycle');
    const detail=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Ver decisão';detail.append(summary);
    detail.addEventListener('toggle',()=>{if(detail.open&&!detail.dataset.loaded){detail.dataset.loaded='true';const reason=document.createElement('p'),pre=document.createElement('pre');reason.textContent=event.reason;pre.textContent=JSON.stringify({parameters:event.parameters,indicators:event.indicators,quote:event.quote,before:event.before,after:event.after,learning:event.learning,realizedPnl:event.realizedPnl},null,2);detail.append(reason,pre);}});
    row.children[2].append(detail);if(openReports.has(row.dataset.eventId))detail.open=true;
  }
  filterJournal();
}
function filterJournal(){
 const filter=$('journal-filter').value,rows=[...$('events').children];let visible=0;
 for(const row of rows){const action=row.dataset.action;row.hidden=!(filter==='all'||filter==='actions'&&action!=='AGUARDAR'||filter==='buy'&&action==='COMPRAR'||filter==='sell'&&action==='VENDER');visible+=Number(!row.hidden);}
 $('journal-filter-status').textContent=`${visible} de ${rows.length} decisões exibidas.${visible?'':' Nenhuma decisão neste filtro.'}`;
}
$('journal-filter').addEventListener('change',filterJournal);
function openCycle(at,events){
 at=new Date(at).toISOString();
 $('decisions-log').open=true;
 $('journal-filter').value='all';filterJournal();
 const rows=[...$('events').children];for(const row of rows)row.classList.toggle('selected-cycle',row.dataset.cycle===at);
 const selected=rows.find(row=>row.dataset.cycle===at);selected?.scrollIntoView({behavior:'smooth',block:'center'});
 selected?.querySelector('summary')?.focus({preventScroll:true});
 const cycle=events.filter(e=>Date.parse(e.at)===Date.parse(at));$('chart-cycle').hidden=false;$('chart-cycle').textContent=`${date(at)} · ${cycle.map(e=>`${assetLabel(e.asset)} ${e.action}`).join(' · ')}. Decisões destacadas no diário; clique em Ver decisão para abrir o motivo.`;
}
function assetLabel(id){return catalogue.find(a=>a.id===id)?.symbol??discoveredAssets?.[id]?.symbol??currentViewState?.fast?.positions[id]?.symbol??(id??'Dados');}
let chartCache=null,chartLoading=false,chartRequestId=0;
async function loadChart(){
 if(!connected||!currentViewState)return;
 const period=$('chart-period').value,token=++chartRequestId;chartLoading=true;
 try{const data=await request('chart',undefined,true,undefined,{period});if(!Array.isArray(data.points))throw Error('Resposta do histórico inválida');if(token!==chartRequestId||!connected)return;chartCache={period,data,loadedAt:Date.now()};renderChart(currentViewState);}
 catch(error){if(token===chartRequestId)$('chart-note').textContent='Não foi possível carregar o histórico: '+error.message+'. Use Atualizar gráfico para tentar novamente.';}
 finally{if(token===chartRequestId)chartLoading=false;}
}
async function openChartPoint(point,s){
 if(!point.auditId){openCycle(point.at,s.events);return;}
 try{const cycle=await request('chart-cycle',undefined,true,undefined,{id:point.auditId});if(!connected)return;const events=[...s.events,...(cycle?.decisions??[])],unique=[...new Map(events.map(e=>[e.id??`${e.at}:${e.asset}:${e.action}`,e])).values()];renderJournal(unique);openCycle(point.at,unique);}
 catch(error){$('chart-cycle').hidden=false;$('chart-cycle').textContent=error.message;}
}
$('chart-period').addEventListener('change',()=>{chartRequestId++;chartLoading=false;chartCache=null;if(currentViewState)renderChart(currentViewState);});
$('chart-refresh').addEventListener('click',()=>loadChart());
$('exploration-toggle').addEventListener('click',()=>update('simulation-exploration',{enabled:!currentViewState?.config?.simulationExploration}));
function renderChart(s){
 const period=$('chart-period').value,remote=chartCache?.period===period?chartCache.data:null,windowMs={'1h':3600000,'1d':86400000,'1w':7*86400000,'1m':31*86400000,'1y':366*86400000,'5y':5*366*86400000}[period];
 const source=remote?remote.points.map(p=>({...p,at:new Date(p.at).toISOString()})):s.events;
 const byTime=new Map();for(const e of source)if(Number.isFinite(e.equity)&&Number.isFinite(Date.parse(e.at))&&Date.parse(e.at)>=Date.now()-windowMs)byTime.set(e.at,e);
 if(!chartLoading&&(!chartCache||chartCache.period!==period||Date.now()-chartCache.loadedAt>30000))loadChart();
 const events=[...byTime.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)),values=events.map(e=>e.equity);
 const lo=(values.length?Math.min(...values):0)-.1,hi=(values.length?Math.max(...values):0)+.1,start=events.length?Date.parse(events[0].at):0,end=events.length?Date.parse(events.at(-1).at):start;
 const points=events.map(e=>({event:e,x:end===start?400:10+(Date.parse(e.at)-start)/(end-start)*780,y:150-(e.equity-lo)/(hi-lo)*140}));
 $('line').setAttribute('d',points.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' '));$('chart-points').replaceChildren();
 for(const p of points){const c=document.createElementNS('http://www.w3.org/2000/svg','circle'),title=document.createElementNS('http://www.w3.org/2000/svg','title');c.setAttribute('cx',p.x);c.setAttribute('cy',p.y);c.setAttribute('r','4');c.setAttribute('tabindex','0');c.setAttribute('role','button');c.setAttribute('aria-label',`${date(p.event.at)} · ${money(p.event.equity)} · abrir decisões`);title.textContent=c.getAttribute('aria-label');c.append(title);c.addEventListener('click',e=>{e.stopPropagation();openChartPoint(p.event,s);});c.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();openChartPoint(p.event,s);}});$('chart-points').append(c);}
 $('chart').onclick=e=>{if(!points.length)return;const p=$('chart').createSVGPoint();p.x=e.clientX;p.y=e.clientY;const at=p.matrixTransform($('chart').getScreenCTM().inverse());const nearest=points.reduce((best,p)=>Math.abs(p.x-at.x)<Math.abs(best.x-at.x)?p:best);openChartPoint(nearest.event,s);};
 $('chart-window').textContent=remote?`${remote.cycleCount} ciclos · ${points.length} pontos`:'Decisões recentes · carregando histórico';
 $('chart-note').textContent=(points.length?`De ${money(Math.min(...values))} a ${money(Math.max(...values))}. Clique em um ponto para abrir as decisões. `:'Sem ciclos registrados neste prazo. ')+(remote?.availableFrom?`Histórico disponível desde ${date(remote.availableFrom)}. Os pontos resumem o último ciclo de cada intervalo; aportes também alteram o patrimônio.`:'Ainda consultando o histórico persistente.');
}

let scheduledAsset=null;
function openSchedule(id,position){scheduledAsset=id;$('sale-schedule-title').textContent=`Programar venda · ${assetLabel(id)} · posição curta`;$('sale-condition').value=position.userExit?.kind??'net';$('sale-value').value=position.userExit&&position.userExit.kind!=='time'?position.userExit.value:1;if(position.userExit?.kind==='time')$('sale-time').value=new Date(Date.parse(position.userExit.value)-3*3600000).toISOString().slice(0,16);$('sale-schedule-form').hidden=false;syncSaleCondition();$('sale-schedule-form').scrollIntoView({behavior:'smooth',block:'center'});}
function syncSaleCondition(){const timed=$('sale-condition').value==='time';$('sale-number-label').hidden=timed;$('sale-time-label').hidden=!timed;$('sale-value').required=!timed;$('sale-time').required=timed;}
$('sale-condition').addEventListener('change',syncSaleCondition);
$('sale-close-form').addEventListener('click',()=>{$('sale-schedule-form').hidden=true;});
$('sale-schedule-form').addEventListener('submit',async e=>{e.preventDefault();const kind=$('sale-condition').value,value=kind==='time'?new Date($('sale-time').value+':00-03:00').toISOString():Number($('sale-value').value);const ok=await update('schedule-sale',{asset:scheduledAsset,kind,value,expectedVersion:version});if(ok){$('sale-schedule-form').hidden=true;$('sale-message').textContent=currentViewState?.config?.simulationExploration?'Venda programada salva; stop automático de perda desligado neste modo.':'Venda programada salva; os limites de perda continuam ativos.';}});
$('sale-cancel-order').addEventListener('click',async()=>{const ok=await update('schedule-sale',{asset:scheduledAsset,kind:'cancel',expectedVersion:version});if(ok){$('sale-schedule-form').hidden=true;$('sale-message').textContent='Programação removida.';}});



function renderPredictions(s){
 const h=$('prediction-horizon').value,r=s.intelligence,e=r?.directionEvaluation,live=e?.metrics?.[h]?.primary,legacy=e?.legacy?.metrics?.[h]??r?.directionMetrics?.[h];
 const reports=Object.values(r?.history??{}),tested=reports.filter(v=>v.protocolId==='direction-audit-v2').map(v=>v.protocolMetrics?.[h]).filter(Boolean),n=tested.reduce((v,m)=>v+m.valid,0),correct=tested.reduce((v,m)=>v+m.correct,0);
 const pct=value=>value==null?'—':`${(value*100).toFixed(1)}%`;
 $('prediction-score').textContent=live?.valid?pct(live.accuracy):'Protocolo em avaliação';
 $('prediction-count').textContent=live?`${live.correct}/${live.valid} acertos · ${live.missing} sem avaliação · ${live.pending} pendentes · ${live.flat} estáveis contadas como não acerto`:'A nova medição começará no próximo ciclo. Resultados antigos não serão apagados nem misturados.';
 $('prediction-legacy').textContent=legacy?.scored?`Legado: ${pct(legacy.accuracy)} (${legacy.correct}/${legacy.scored})${e?.legacy?.asOf?' até '+date(e.legacy.updatedAt??e.legacy.asOf):''}, com limitações temporais; não comparar diretamente.`:'Sem medições anteriores.';
 $('history-score').textContent=n?pct(correct/n):'Aguardando revalidação';$('history-count').textContent=n?`${correct}/${n} casos cronológicos sem sobreposição · ${tested.length} ativos · resultado histórico`:'Revalidar histórico com o novo protocolo; o relatório anterior continua preservado no registro privado.';
 $('prediction-status').textContent=`Protocolo: ${e?.protocol?.id??'aguardando implantação'}${e?.startedAt?' desde '+date(e.startedAt):''}. Emissões horárias; posições seguem monitoradas a cada 2 minutos. Escopo: criptoativos com histórico horário; ETFs e novos pools não entram nesta taxa. Dados, vetor e coeficientes ficam registrados antes do resultado.`;
 $('prediction-quality').replaceChildren();if(live){for(const text of [`Modelo: ${pct(live.accuracy)}; sempre prever alta: ${pct(live.alwaysUpAccuracy)}; seguir último movimento: ${pct(live.momentumAccuracy)}.`,`Acerto balanceado: ${pct(live.balancedAccuracy)}; Brier: ${live.brier==null?'—':live.brier.toFixed(3)}; ganho sobre probabilidade neutra de 50%: ${pct(live.brierSkill)}. Valores negativos indicam desempenho pior que a referência.`,`Cobertura: ${pct(live.coverage)}; erros de direção, estabilidade e falta de cotação são contabilizados separadamente. Probabilidade não é certeza nem lucro.`]){const p=document.createElement('p');p.textContent=text;$('prediction-quality').append(p);}}
 if(live){const d=document.createElement('details'),summary=document.createElement('summary'),table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody');summary.textContent='Calibração: probabilidade estimada versus altas observadas';cells(head,['Probabilidade média de alta','Altas observadas','Casos']);for(const bin of live.calibration??[])if(bin.n)cells(body,[pct(bin.meanProbability),pct(bin.observedUpRate),String(bin.n)]);table.append(head,body);d.append(summary,table);$('prediction-quality').append(d);}
 const historical=document.createElement('details'),historicalTitle=document.createElement('summary'),historicalBody=document.createElement('div');historicalTitle.textContent='Validação histórica por ativo e janela';for(const report of reports.filter(v=>v.protocolId==='direction-audit-v2')){const m=report.protocolMetrics?.[h];if(!m)continue;const d=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=`${assetLabel(report.asset)} · ${m.correct}/${m.valid} acertos · ${m.missing} ausências`;pre.textContent=JSON.stringify({source:report.source,dataHash:report.hash,dataStart:report.dataStart,dataEnd:report.dataEnd,cutoff:report.cutoff,metrics:m,walkForward:report.walkForward?.[h]},null,2);d.append(summary,pre);historicalBody.append(d);}historical.append(historicalTitle,historicalBody);$('prediction-quality').append(historical);
 $('prediction-assets').replaceChildren();for(const [id,m] of Object.entries(e?.metrics?.[h]?.assets??{}))cells($('prediction-assets'),[assetLabel(id),`${m.correct}/${m.valid}`,pct(m.accuracy),pct(m.alwaysUpAccuracy),pct(m.momentumAccuracy),pct(m.coverage)]);
 $('prediction-items').replaceChildren();for(const p of (r?.directionPending??[]).filter(p=>String(p.horizon)===h).slice(-12).reverse()){const detail=document.createElement('details'),title=document.createElement('summary'),pre=document.createElement('pre');title.textContent=`${assetLabel(p.asset)} · ${p.probability>=.5?'SUBIR':'DESCER'} · avaliar em ${date(p.targetAt)}${p.primary?' · amostra principal':''}`;pre.textContent=JSON.stringify({id:p.id,protocol:p.protocolId,knownAt:p.knownAt,priceAt:p.priceAt,basePrice:p.price,probability:p.probability,modelHash:p.modelHash,inputHash:p.inputHash,vector:p.vector,model:p.modelSnapshot,baselines:p.baselines},null,2);detail.append(title,pre);$('prediction-items').append(detail);}
}

function renderLearning(s){
 const l=s.learning;
 $('learning-summary').textContent=l?`${l.closed} resultados de entradas avaliados · atualizado ${date(l.updatedAt)}`:'Hipóteses de entrada são registradas; aprendizado de resultado ocorre na saída, sem inventar acertos.';
 $('learning-arms').replaceChildren();
 $('entry-learning-status').textContent=s.config?.simulationExploration&&s.config?.learningPolicy==='paper-entry-value-v1'?`Compra comparada com caixa (0%): ${s.config.learningExplorationPct??20}% do patrimônio para testar; restante só para a melhor alternativa de ajuste que também tenha validação líquida positiva. A validação é reservada na entrada e não treina o ajuste.`:'Aprendizado de entradas inativo neste modo.';
 $('entry-reference-results').replaceChildren();const refs=Object.entries(l?.entryReferences?.stats??{});if(refs.length){const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody');cells(head,['Família / saída','Comparações conhecidas','Compra superou caixa','Média líquida hipotética','Sem cotação válida']);for(const [key,v] of refs)cells(body,[key,String(v.known),`${v.betterThanCash}/${v.known}`,v.known?`${(v.sumNetPct/v.known).toFixed(2)}%`:'—',String(v.missing)]);table.append(head,body);$('entry-reference-results').append(table);}
 const arms=Object.entries(l?.explorationArms??{});
 if(arms.length){const title=document.createElement('p');title.textContent='Aprendizado das saídas na exploração simulada (retornos líquidos observados; não são previsões garantidas).';const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody');cells(head,['Grupo / saída','Vendas avaliadas','Resultado médio líquido','Vendas positivas']);for(const [key,arm] of arms)cells(body,[key,String(arm.trades),`${(arm.sumNetPct/arm.trades).toFixed(2)}%`,`${arm.wins}/${arm.trades}`]);table.append(head,body);$('learning-arms').append(title,table);}
 $('learning-items').replaceChildren();
 for(const item of [...(l?.summaries??[])].reverse().slice(0,30)){
  const d=document.createElement('details'),summary=document.createElement('summary'),p=document.createElement('p');
  summary.textContent=`${date(item.at)} · ${assetLabel(item.asset)} · ${item.netPct.toFixed(2)}% líquido`;
  p.textContent=item.summary+' Próxima postura: '+(item.nextBehavior?.reason??'avaliar mais exemplos');
  d.append(summary,p);
  const e=item.nextBehavior?.economics;
  if(e){
   const table=document.createElement('table'),body=document.createElement('tbody');
   const amount=value=>Number.isFinite(value)?money(value):'Não disponível';
   const rate=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'Não disponível';
   for(const row of [
    ['Vendas recentes neste cenário',String(e.sales)],
    ['Acertos nas vendas',rate(e.winRate)],
    ['Resultado líquido acumulado',amount(e.netPnl)],
    ['Resultado líquido médio por venda',amount(e.expectancyBRL)],
    ['Ganho médio nas vendas positivas',amount(e.averageWinBRL)],
    ['Perda média nas vendas negativas',amount(e.averageLossBRL)],
    ['Ganhos acumulados ÷ perdas acumuladas',Number.isFinite(e.profitFactor)?e.profitFactor.toFixed(2):'Não disponível sem perdas observadas'],
    ['Acerto necessário para equilíbrio',rate(e.breakEvenWinRate)],
    ['Novas entradas bloqueadas até',item.nextBehavior.blockedUntil?date(item.nextBehavior.blockedUntil):'Sem bloqueio neste registro']
   ])cells(body,row);
   table.append(body);const scroll=document.createElement('div');scroll.className='table-scroll';scroll.append(table);d.append(scroll);
   const note=document.createElement('p');note.className='muted';note.textContent='Retrato calculado na data desta saída, não o estado atual. '+e.note+' O equilíbrio usa os ganhos e perdas médios observados; não é uma probabilidade prevista. Custos já incluídos no resultado líquido.';d.append(note);
  }else{const note=document.createElement('p');note.className='muted';note.textContent='Registro anterior à avaliação econômica detalhada. Valores não foram reconstruídos nem estimados.';d.append(note);}
  $('learning-items').append(d);
 }
}
let scenarioCache=null,scenarioLoading=false,scenarioRunning=false,scenarioLoadedAt=0,scenarioRequestId=0;
const researchAssets=['bitcoin','ethereum','solana','binancecoin','ripple','cardano','chainlink','avalanche-2','polkadot','litecoin'];
const candidateNames={'train-prior':'Frequência do treino','always-up':'Sempre alta','always-down':'Sempre baixa',momentum:'Último movimento',trend:'Tendência',reversion:'Reversão', 'online-logistic':'Regressão incremental','batch-logistic':'Regressão em lote',neighbors:'Cenários vizinhos','regime-frequency':'Frequência por cenário','batch-context':'Regressão com contexto','neighbors-context':'Vizinhos com contexto','ensemble-context':'Combinação de contexto'};
function scenarioName(key){return key.split('|').map(x=>({up:'alta',down:'baixa',flat:'lateral',low:'baixa volatilidade',medium:'média volatilidade',high:'alta volatilidade',oversold:'RSI em sobrevenda',neutral:'RSI neutro',overbought:'RSI em sobrecompra'}[x]??x)).join(' / ');}
const researchPct=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'—';
async function loadScenarioReports(force=false){
 if(!connected||scenarioLoading&&!force)return;const token=++scenarioRequestId;scenarioLoading=true;
 try{const version=$('scenario-version').value,data=await request('scenario-report',undefined,true,undefined,version?{protocol:version}:{});if(!connected||token!==scenarioRequestId)return;scenarioCache=data;scenarioLoadedAt=Date.now();$('scenario-results').replaceChildren();
  $('scenario-status').textContent=`${data.studies?.length??0}/10 ativos com estudo. ${Math.max(0,...(data.studies??[]).map(s=>s.report.candidateCount??10))} métodos × três prazos × 27 cenários possíveis; cenários sem dados permanecem sem conclusão.`;
  for(const study of data.studies??[]){const d=document.createElement('details'),summary=document.createElement('summary'),content=document.createElement('div');summary.textContent=`${assetLabel(study.asset)} · ${study.report.protocol} · dados até ${date(study.report.dataEnd)}`;d.append(summary,content);
   for(const [h,v] of Object.entries(study.report.horizons??{})){const p=document.createElement('p');p.textContent=`${h}h: ${candidateNames[v.chosen]} escolhido na validação; teste ${v.metrics.correct}/${v.metrics.valid} (${researchPct(v.metrics.accuracy)}). ${v.scenariosObserved}/27 cenários observados. Meta ainda não demonstrada prospectivamente.`;content.append(p);}
   d.addEventListener('toggle',async()=>{if(!d.open||d.dataset.loaded)return;d.dataset.loaded='true';try{const detail=await request('scenario-report',undefined,true,undefined,{asset:study.asset,protocol:study.report.protocol});if(!connected)return;renderScenarioDetail(content,detail.studies[0].report);}catch(error){content.textContent=error.message;d.dataset.loaded='';}});$('scenario-results').append(d);
  }
 }catch(error){if(token===scenarioRequestId)$('scenario-status').textContent='Estudos indisponíveis: '+error.message;}
 finally{if(token===scenarioRequestId)scenarioLoading=false;}
}
function renderScenarioDetail(container,report){
 container.replaceChildren();for(const text of report.limitations??[]){const p=document.createElement('p');p.className='muted';p.textContent=text;container.append(p);}
 for(const [h,v] of Object.entries(report.horizons)){
  const d=document.createElement('details'),title=document.createElement('summary');title.textContent=`${h}h · escolhido antes do teste: ${candidateNames[v.chosen]}`;d.append(title);
  const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody');cells(head,['Método','Brier da validação','Casos no teste','Acerto no teste','Acerto com confiança ≥70% / participação','Média líquida das compras']);
  for(const c of v.comparisons){const m=c.test.metrics,selective=c.test.selective,e=c.test.economics;cells(body,[`${candidateNames[c.candidate]}${c.candidate===v.chosen?' · ESCOLHIDO':''}`,Number.isFinite(c.validation.metrics.brier)?c.validation.metrics.brier.toFixed(3):'—',`${m.correct}/${m.valid} (${m.missing} ausentes)`,researchPct(m.accuracy),`${researchPct(selective.accuracy)} / ${researchPct(selective.participation)} · ${selective.valid} casos`,e.buyCases?`${e.meanNetPct.toFixed(3)}% · ${e.buyCases} compras`:'Sem compras']);}
  table.append(head,body);const scroll=document.createElement('div');scroll.className='table-scroll';scroll.append(table);d.append(scroll);
  const priorities=document.createElement('p');priorities.textContent='Prioridades para pesquisa futura (não escolhem o vencedor deste teste): '+(v.learningPriorities??[]).map(r=>`${scenarioName(r.scenario)}: ${r.errors} erros em ${r.cases} casos`).join('; ');d.append(priorities);
  const reasons=document.createElement('p');reasons.textContent='Meta de 80%: '+v.goal.reasons.join('; ')+'. A taxa principal usa todos os casos, não apenas os de maior confiança.';d.append(reasons);
  const regimes=document.createElement('details'),regimeTitle=document.createElement('summary'),regimeTable=document.createElement('table'),regimeHead=document.createElement('thead'),regimeBody=document.createElement('tbody');regimeTitle.textContent='Cenários do método escolhido';cells(regimeHead,['Tendência / volatilidade / RSI','Casos válidos','Acerto','Falsas altas / falsas baixas']);for(const r of v.championTest.scenarios)cells(regimeBody,[r.scenario.split('|').map(x=>({up:'alta',down:'baixa',flat:'lateral',low:'baixa volatilidade',medium:'média volatilidade',high:'alta volatilidade',oversold:'RSI em sobrevenda',neutral:'RSI neutro',overbought:'RSI em sobrecompra'}[x]??x)).join(' / '),String(r.valid),r.valid?researchPct(r.accuracy):'Sem dados',`${r.fp}/${r.fn}`]);regimeTable.append(regimeHead,regimeBody);const regimeScroll=document.createElement('div');regimeScroll.className='table-scroll';regimeScroll.append(regimeTable);regimes.append(regimeTitle,regimeScroll);d.append(regimes);container.append(d);
 }
}
function renderScenarioLive(s){
 const summaries=s.intelligence?.scenarioLive?.summary??[],known=summaries.reduce((n,r)=>n+r.metrics.valid,0),met=summaries.filter(r=>r.goal.demonstrated).length;
 $('scenario-live').textContent=`Confirmação prospectiva: ${known} resultados registrados após a escolha dos métodos; ${met}/${summaries.length} conjuntos de ativo e prazo atingiram os critérios empíricos da meta. Isso não habilita dinheiro real. Os ativos podem ser correlacionados.`;
 $('scenario-live-table').replaceChildren();if(summaries.length){const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody');cells(head,['Ativo','Versão','Prazo','Acertos / válidas','Acerto','Cobertura','Referência nos mesmos casos','Meta empírica']);for(const v of summaries)cells(body,[assetLabel(v.asset),v.protocol??'scenario-comparison-v1',v.horizon+'h',`${v.metrics.correct}/${v.metrics.valid}`,researchPct(v.metrics.accuracy),researchPct(v.metrics.coverage),v.paired?.reference?.valid?`${researchPct(v.paired.reference.accuracy)} (${v.paired.reference.valid} casos); candidato ${researchPct(v.paired.challenger.accuracy)}`:'—',v.goal.demonstrated?'Critérios atingidos no papel':'Em avaliação']);table.append(head,body);$('scenario-live-table').append(table);}
}
$('scenario-version').addEventListener('change',()=>{scenarioCache=null;loadScenarioReports(true);});
$('scenario-run-all').addEventListener('click',async()=>{
 if(scenarioRunning)return;$('scenario-version').value='';scenarioRunning=true;const button=$('scenario-run-all');button.disabled=true;let count=0;const failed=[];
 try{for(const asset of researchAssets){$('scenario-status').textContent=`Testando ${assetLabel(asset)} (${count+failed.length+1}/10)…`;try{await request('scenario-run',{asset});count++;}catch(error){failed.push(`${assetLabel(asset)}: ${error.message}`);}}
  scenarioCache=null;await loadScenarioReports(true);$('scenario-status').textContent+=` Executados: ${count}; pendentes: ${failed.length}.${failed.length?' '+failed.join(' · '):''}`;
 }finally{scenarioRunning=false;button.disabled=false;}
});

$('prediction-horizon').addEventListener('change',()=>{if(currentViewState)renderPredictions(currentViewState);});
$('train-history').addEventListener('click',async()=>{if(!currentViewState)return;const ids=Object.keys(currentViewState.config?.allocations??{}).filter(id=>catalogue.find(a=>a.id===id)?.market!=='b3');$('train-history').disabled=true;let trained=0;const failed=[];for(const asset of ids){$('training-status').textContent=`Importando ${trained+failed.length+1}/${ids.length}: ${assetLabel(asset)}…`;try{const result=await request('history-train',{asset});render(result);trained++;}catch(e){failed.push(assetLabel(asset));if(e.status===429){failed.push('demais ativos adiados pelo limite do provedor');break;}}}$('training-status').textContent=`${trained} ativos com histórico importado e teste cronológico concluído.${failed.length?' Sem fonte válida: '+failed.join(', '):''}`;$('train-history').disabled=false;});


$('quality-load').addEventListener('click',async()=>{const button=$('quality-load');button.disabled=true;try{const report=await request('quality');$('quality-report').replaceChildren();const note=document.createElement('p');note.textContent=`Auditoria até ${date(report.asOf)}. Resultado realizado já inclui custos: não subtrair taxas novamente.`;$('quality-report').append(note);for(const g of report.trading){const p=document.createElement('p');p.textContent=`${g.asset_group==='new-pools'?'Novos pools (fora do índice direcional)':'Ativos estabelecidos'}: ${g.buys} compras, ${g.sells} vendas, ${money(g.realized_net)} realizado líquido; ${money(g.fees)} de taxas registradas${g.unknown_pnl?' · '+g.unknown_pnl+' saídas sem custo de entrada conhecido':''}.`;$('quality-report').append(p);}const assessment=document.createElement('details'),assessmentTitle=document.createElement('summary');assessmentTitle.textContent='Validação das previsões por ativo e horizonte';assessment.append(assessmentTitle);for(const item of report.forecastAssessment??[]){const row=document.createElement('details'),title=document.createElement('summary'),explanation=document.createElement('p');title.textContent=`${assetLabel(item.asset)} · ${item.horizon}h · ${item.ready?'Critérios de triagem atendidos':'Sem vantagem demonstrada'}`;explanation.textContent=`Ao vivo: ${item.live.ready?'critérios atendidos':item.live.reasons.join('; ')}. Histórico: ${item.history.ready?'critérios atendidos':item.history.reasons.join('; ')}. Janelas históricas com vantagem: ${item.history.winningWindows}/${item.history.windows}. ${item.note}`;row.append(title,explanation);if(item.economics){const e=item.economics,info=document.createElement('p');info.textContent=`Diagnóstico de custos: alta mínima de ${e.breakEvenRawPct.toFixed(3)}% para equilibrar compra e venda nas hipóteses atuais. Saída fixa no horizonte, sem stops intermediários, impostos ou limites da carteira; não reproduz o bot inteiro.`;row.append(info);const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody'),pct=v=>Number.isFinite(v)?`${v.toFixed(3)}%`:'—';cells(head,['Regra fixa','Resultados / entradas','Acerto de alta','Vendas com lucro líquido','Média líquida por operação','Média com custos dobrados']);for(const p of e.policies)cells(body,[{'model-up':'Modelo ≥ 50%','model-confident':'Modelo ≥ 60%','always-buy':'Comprar em todas as janelas','expected-net':'Retorno líquido estimado > 0,1%, positivo com custos dobrados'}[p.id],`${p.known}/${p.selected} (${p.missing} ausentes)`,pct(p.directionalHitRate==null?null:p.directionalHitRate*100),pct(p.netWinRate==null?null:p.netWinRate*100),pct(p.meanNetPct),pct(p.meanStressNetPct)]);table.append(head,body);const scroll=document.createElement('div');scroll.className='table-scroll';scroll.append(table);row.append(scroll);if(e.returnForecast){const f=e.returnForecast,err=f.errors,p=document.createElement('p');p.textContent=`Estimador de retorno em diagnóstico: erro absoluto médio ${pct(err.maePct)}; referência constante do treinamento ${pct(err.baselineMaePct)}. Viés médio ${pct(err.biasPct)} (positivo indica otimismo excessivo). Treinado com ${f.model.trained} resultados conhecidos antes do corte. Não executa ordens e não substitui os limites de risco.`;row.append(p);}}else{const missing=document.createElement('p');missing.textContent='Diagnóstico de custos ainda não calculado para este histórico. Use “Importar histórico e treinar agora” para revalidar; isso não executa ordens.';row.append(missing);}assessment.append(row);}$('quality-report').append(assessment);const detail=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Ver contagens e integridade temporal';pre.textContent=JSON.stringify({evaluation:report.evaluation,issuance:report.issuance,replay:report.replay},null,2);detail.append(summary,pre);$('quality-report').append(detail);}catch(error){$('quality-report').textContent=error.message;}finally{button.disabled=false;}});
restoreSession();
