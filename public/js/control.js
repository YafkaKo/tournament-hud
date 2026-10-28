/* Пульт: правит состояние на сервере, сервер сам разошлёт его оверлеям. */

const $ = id => document.getElementById(id);
let state = null;
let match = null;
let ws;

/* ----------------------------------------------------------- связь */

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => $('dotWs').classList.add('on');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'control') { state = msg.data; fill(); }
    if (msg.type === 'gsi') $('dotGsi').classList.add('on');
    if (msg.type === 'match') { match = msg.data; renderMatchInfo(); }
    if (msg.type === 'status') {
      $('dotGsi').classList.toggle('on', msg.data.gsiConnected);
      $('sourceWarning').hidden = !msg.data.warning;
      $('sourceWarning').textContent = msg.data.warning || '';
    }
  };
  ws.onclose = () => {
    $('dotWs').classList.remove('on');
    $('dotGsi').classList.remove('on');
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws.close();
}
connect();

async function patch(partial) {
  try {
    state = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial)
    }).then(r => r.json());
    fill();
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------- фон заставок */

const updateBackgrounds = createBackgroundPanel($('bgPanel'), { patch, toast: () => {} });

/* ----------------------------------------------------------- привязка полей */

function get(path) {
  return path.split('.').reduce((o, k) => (o ?? {})[k], state);
}

function nest(path, value) {
  return path.split('.').reverse().reduce((acc, key) => ({ [key]: acc }), value);
}

function fill() {
  if (!state) return;

  document.querySelectorAll('[data-path]').forEach(el => {
    if (document.activeElement === el) return;   // не перебиваем то, что печатают
    const value = get(el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!value;
    else if (el.dataset.type === 'datetime') el.value = value ? toLocalInput(value) : '';
    else el.value = value ?? '';
  });

  document.querySelectorAll('.scenes button').forEach(b => {
    b.classList.toggle('active', b.dataset.scene === state.scene);
  });

  updateBackgrounds(state);

  $('radWins').textContent = state.series.radiantWins;
  $('direWins').textContent = state.series.direWins;

  if (document.activeElement !== $('bracketJson')) {
    $('bracketJson').value = JSON.stringify(state.bracket.rounds ?? [], null, 2);
  }
}

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-path]');
  if (!el) return;
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.type === 'datetime') value = value ? new Date(value).toISOString() : null;
  patch(nest(el.dataset.path, value));
});

/* ----------------------------------------------------------- кнопки */

document.addEventListener('click', (e) => {
  const scene = e.target.closest('[data-scene]');
  if (scene) patch({ scene: scene.dataset.scene });

  const inc = e.target.closest('[data-inc]');
  if (inc) {
    const path = inc.dataset.inc;
    const next = Math.max(0, (get(path) || 0) + Number(inc.dataset.by));
    patch(nest(path, next));
  }
});

// Названия и счёт остаются за командами — меняется только, кто за Radiant.
$('swapTeams').onclick = () => fetch('/api/action/dota-swap-sides', { method: 'POST' });

$('applyBracket').onclick = () => {
  const err = $('bracketError');
  try {
    const rounds = JSON.parse($('bracketJson').value || '[]');
    if (!Array.isArray(rounds)) throw new Error('Ожидается массив раундов');
    err.hidden = true;
    patch({ bracket: { ...state.bracket, rounds }, scene: 'bracket' });
  } catch (ex) {
    err.hidden = false;
    err.textContent = 'Не разобрал JSON: ' + ex.message;
  }
};

$('sampleBracket').onclick = () => {
  $('bracketJson').value = JSON.stringify([
    {
      name: 'Полуфиналы',
      matches: [
        { a: { name: 'ИТ-факультет', score: 2, won: true }, b: { name: 'Энергетики', score: 0 } },
        { a: { name: 'Механики', score: 1 }, b: { name: 'Общежитие 4', score: 2, won: true } }
      ]
    },
    {
      name: 'Финал',
      matches: [
        { a: { name: 'ИТ-факультет', score: 0 }, b: { name: 'Общежитие 4', score: 0 } }
      ]
    }
  ], null, 2);
};

$('resetMatch').onclick = async () => {
  if (!confirm('Сбросить матч? Итоги карты и снимки вероятности будут удалены. Команды и счёт серии останутся.')) return;
  await fetch('/api/match/reset', { method: 'POST' });
};

function renderMatchInfo() {
  const el = $('matchInfo');
  if (!match || !match.gameState) { el.textContent = 'Данных из игры пока нет.'; return; }
  const parts = [];
  if (match.matchId) parts.push(`матч ${match.matchId}`);
  if (match.clock != null) parts.push(clockText(match.clock));
  if (match.probability) parts.push(`Radiant ${match.probability.radiant}% / Dire ${match.probability.dire}%`);
  if (match.finished) parts.push('итоги заморожены');
  if (match.finished && match.enrichment?.message) parts.push(`OpenDota: ${match.enrichment.message}`);
  el.textContent = parts.join(' · ');
}

function clockText(s) {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(Math.trunc(s));
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

$('resetAll').onclick = async () => {
  if (!confirm('Сбросить названия команд, счёт и заставки к заводским?')) return;
  state = await fetch('/api/control/reset', { method: 'POST' }).then(r => r.json());
  fill();
};

/* ----------------------------------------------------------- хоткеи

   Хоткеи обрабатывает общий пульт (control.html): он ловит нажатия и
   внутри этой страницы, поэтому здесь своего обработчика нет. */

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
