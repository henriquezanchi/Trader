let token = '', paused = false;
const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const date = value => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
async function request(action = 'status') {
  const response = await fetch(`/api/agent?action=${action}`, { method: action === 'status' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(35000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Serviço indisponível');
  return data;
}
function render({ state: s }) {
  $('dashboard').hidden = false; $('login').hidden = true;
  const total = s.cash + s.btc * (s.lastPrice ?? 0);
  $('equity').textContent = money(total);
  $('cash').textContent = money(s.cash);
  $('result').textContent = `${money(total - s.initialCapital)} desde o início`;
  $('btc').textContent = `${s.btc.toFixed(8)} BTC`;
  $('position').textContent = money(s.btc * (s.lastPrice ?? 0));
  $('price').textContent = s.lastPrice ? money(s.lastPrice) : 'Sem cotação';
  const last = s.observations.at(-1);
  $('updated').textContent = last ? date(last.observedAt) : 'Execute o primeiro ciclo';
  paused = s.paused;
  $('status').textContent = paused ? 'Pausado' : 'Simulação habilitada';
  $('pause').textContent = paused ? 'Retomar' : 'Pausar';
  $('reason').textContent = s.reason;
  $('warmup').textContent = `${s.observations.length} observações mantidas · primeira decisão após 24 ciclos consecutivos · atualização automática do painel a cada minuto`;
  $('events').replaceChildren();
  for (const event of [...s.events].reverse()) {
    const row = document.createElement('tr');
    for (const text of [date(event.at), event.action, event.reason, money(event.fee), money(event.equity)]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    $('events').append(row);
  }
  $('empty').textContent = s.events.length ? '' : 'Nenhum ciclo executado ainda.';
  const values = s.events.map(x => x.equity);
  const lo = Math.min(s.initialCapital, ...values) - .1, hi = Math.max(s.initialCapital, ...values) + .1;
  $('line').setAttribute('d', values.map((v, i) => `${i ? 'L' : 'M'} ${10 + i * 780 / Math.max(1, values.length - 1)} ${150 - (v - lo) / (hi - lo) * 140}`).join(' '));
  $('chart-note').textContent = values.length < 2 ? 'O gráfico aparece após dois ciclos.' : `De ${money(Math.min(...values))} a ${money(Math.max(...values))} · resultado líquido das taxas simuladas`;
}
let busy = false;
async function update(action = 'status') {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const data = await request(action); render(data);
    const latest = data.state.observations.at(-1);
    const stale = latest && Date.now() - Date.parse(latest.at) > 90 * 60000;
    $('message').textContent = stale ? 'Atenção: sem ciclo há mais de 90 minutos. Confira o agendamento no GitHub.' : `Conectado · painel consultado às ${date(Date.now())}${data.duplicate ? ' · Esta hora já foi processada' : ''}`;
  } catch (error) { $('message').textContent = error.message; }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
$('connect').addEventListener('submit', event => { event.preventDefault(); token = $('token').value.trim(); $('token').value = ''; update(); });
$('refresh').addEventListener('click', () => update());
$('tick').addEventListener('click', () => update('tick'));
$('pause').addEventListener('click', () => update(paused ? 'resume' : 'pause'));
$('disconnect').addEventListener('click', () => { token = ''; $('dashboard').hidden = true; $('login').hidden = false; $('message').textContent = 'Desconectado'; });
setInterval(() => { if (token && !document.hidden && !$('dashboard').hidden) update(); }, 60000);
