/* Пульт: правит состояние на сервере, сервер сам рассылает его оверлеям. */

const $ = id => document.getElementById(id);
let state = null;     // состояние пульта (control)
let game = null;      // картина матча из игры

/* ----------------------------------------------------------- связь */

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => $('pillWs').classList.add('on');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'control') { state = msg.data; fill(); }
    if (msg.type === 'game') { game = msg.data; $('pillGsi').classList.add('on'); fillGame(); }
    if (msg.type === 'status') $('pillGsi').classList.toggle('on', msg.data.gsiConnected);
  };
  ws.onclose = () => {
    $('pillWs').classList.remove('on');
    $('pillGsi').classList.remove('on');
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws.close();
}
connect();

async function api(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `ошибка ${res.status}`);
  return data;
}

async function patch(partial) {
  try {
    state = await api('/api/control', partial);
    fill();
  } catch (ex) {
    toast('Не сохранилось: ' + ex.message);
  }
}

const action = name => api(`/api/action/${encodeURIComponent(name)}`).catch(ex => toast(ex.message));

let toastTimer;
function toast(textValue) {
  const el = $('toast');
  el.textContent = textValue;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ----------------------------------------------------------- привязка полей */

const get = path => path.split('.').reduce((o, k) => (o ?? {})[k], state);
const nest = (path, value) => path.split('.').reverse().reduce((acc, key) => ({ [key]: acc }), value);
const teamName = key => (key === 'B' ? state.teamB.name || 'Справа' : state.teamA.name || 'Слева');

function fill() {
  if (!state) return;

  document.querySelectorAll('[data-path]').forEach(el => {
    if (document.activeElement === el) return;     // не перебиваем то, что сейчас печатают
    const value = get(el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!value;
    else if (el.dataset.type === 'datetime') el.value = value ? toLocalInput(value) : '';
    else el.value = value ?? '';
  });

  document.querySelectorAll('.scenes button').forEach(b => b.classList.toggle('active', b.dataset.scene === state.scene));
  $('aWins').textContent = state.series.aWins;
  $('bWins').textContent = state.series.bWins;

  // подписи «Слева / Справа» превращаем в названия команд
  const opts = $('resultWinner').options;
  opts[0].textContent = teamName('A');
  opts[1].textContent = teamName('B');

  logoPreview('A');
  logoPreview('B');
  fillMaps();
  fillBackgrounds();
  fillTriviaPos();
  fillGame();

  if (document.activeElement !== $('bracketJson')) {
    $('bracketJson').value = JSON.stringify(state.bracket?.rounds ?? [], null, 2);
  }
}

function fillGame() {
  if (!state) return;
  const g = game && game.live ? game : null;
  $('pillMatch').textContent = g ? `${g.map.label} · раунд ${g.round} · ${g.a.score}:${g.b.score}` : 'нет матча';
  const el = $('sidesNow');
  if (!g) {
    el.textContent = 'Данных из игры пока нет — стороны определятся, когда придут игроки.';
  } else {
    el.innerHTML = `
      <b>${esc(teamName('A'))}</b> <span class="side-tag ${g.a.side === 'T' ? 'is-t' : 'is-ct'}">${g.a.side}</span>
      <span style="color:var(--muted)">·</span>
      <b>${esc(teamName('B'))}</b> <span class="side-tag ${g.b.side === 'T' ? 'is-t' : 'is-ct'}">${g.b.side}</span>
      <span style="color:var(--muted);margin-left:auto">игроки: ${g.a.players.map(p => esc(p.name)).join(', ') || '—'}</span>`;
  }
  // подсветка карты, которая идёт сейчас
  document.querySelectorAll('.map-row').forEach(row => {
    row.classList.toggle('is-live', !!g && row.dataset.map === g.map.name && !row.classList.contains('is-done'));
  });
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
  if (scene) { patch({ scene: scene.dataset.scene }); flash(scene); }

  const act = e.target.closest('[data-action]');
  if (act) action(act.dataset.action);

  const set = e.target.closest('[data-cd-min]');
  if (set) setCountdown(Number(set.dataset.cdMin));
  const add = e.target.closest('[data-cd-add]');
  if (add) addCountdown(Number(add.dataset.cdAdd));
});

function setCountdown(min) {
  const to = new Date(Date.now() + min * 60000 + 900);
  patch({ countdown: { to: to.toISOString(), show: true } });
}
function addCountdown(min) {
  const base = state.countdown?.to ? new Date(state.countdown.to).getTime() : Date.now();
  const to = new Date(Math.max(Date.now(), base) + min * 60000);
  patch({ countdown: { to: to.toISOString() } });
  toast(`Таймер: ${min > 0 ? '+' : '−'}1 мин`);
}

$('finishMap').onclick = async () => {
  const msg = $('matchMsg');
  try {
    state = await api('/api/map/finish');
    fill();
    msg.className = 'msg';
    const done = state.series.maps.filter(m => m.winner);
    const last = done[done.length - 1];
    msg.textContent = last ? `Записано: ${mapLabel(last.map)} ${last.scoreA}:${last.scoreB}, серия ${state.series.aWins}:${state.series.bWins}.` : `Серия ${state.series.aWins}:${state.series.bWins}.`;
  } catch (ex) {
    msg.className = 'msg msg--error';
    msg.textContent = ex.message;
  }
  msg.hidden = false;
};

$('swapTeams').onclick = async () => {
  // Меняем местами всё, что относится к командам, а сервер переворачивает привязку
  // игроков — иначе игроки остались бы под чужим названием.
  const s = state.series;
  const maps = (s.maps || []).map(m => ({
    ...m,
    pick: m.pick === 'A' ? 'B' : m.pick === 'B' ? 'A' : m.pick,
    winner: m.winner === 'A' ? 'B' : m.winner === 'B' ? 'A' : m.winner,
    scoreA: m.scoreB, scoreB: m.scoreA
  }));
  await patch({
    teamA: { ...state.teamB },
    teamB: { ...state.teamA },
    series: { ...s, aWins: s.bWins, bWins: s.aWins, maps },
    results: { ...state.results, winner: state.results.winner === 'A' ? 'B' : 'A' },
    sides: { aStart: state.sides.aStart === 'CT' ? 'T' : 'CT' }
  });
  await api('/api/sides/swap');
  toast('Команды поменялись местами');
};

$('resetPlayers').onclick = async () => {
  await api('/api/sides/reset');
  toast('Игроки будут определены заново по стартовой стороне');
};

$('resetStats').onclick = async () => {
  if (!confirm('Обнулить историю раундов, ADR и HS% текущей карты?')) return;
  await api('/api/stats/reset');
  toast('Статистика карты обнулена');
};

$('resetAll').onclick = async () => {
  if (!confirm('Сбросить названия команд, счёт, карты и заставки к заводским?')) return;
  state = await api('/api/control/reset');
  fill();
};

/* ----------------------------------------------------------- логотипы */

function logoPreview(key) {
  const url = state[`team${key}`]?.logo;
  $(`logoPrev${key}`).style.backgroundImage = url ? `url("${url.replace(/"/g, '%22')}")` : '';
}

document.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-logo]');
  if (!input || !input.files[0]) return;
  const file = input.files[0];
  try {
    const res = await fetch(`/api/logo/${input.dataset.logo}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `ошибка ${res.status}`);
    state = body;
    fill();
    toast('Логотип загружен');
  } catch (ex) {
    toast('Логотип не загрузился: ' + ex.message);
  }
  input.value = '';
});

document.addEventListener('click', (e) => {
  const clear = e.target.closest('[data-logo-clear]');
  if (clear) patch({ [`team${clear.dataset.logoClear}`]: { logo: '' } });
});

/* ----------------------------------------------------------- карты серии */

function fillMaps() {
  const box = $('maps');
  const maps = state.series.maps || [];
  // Перестраиваем строки, только если поменялось их число или кто-то не печатает внутри
  if (box.contains(document.activeElement) && box.children.length === maps.length) return;
  const mapOptions = sel => window.CS2_MAPS.map(([id, label]) => `<option value="${id}" ${id === sel ? 'selected' : ''}>${label}</option>`).join('');
  box.innerHTML = maps.map((m, i) => `
    <div class="map-row ${m.winner ? 'is-done' : ''}" data-i="${i}" data-map="${esc(m.map)}">
      <span class="map-row__num">${i + 1}</span>
      <select data-m="map">${mapOptions(m.map)}</select>
      <select data-m="pick">
        <option value="A" ${m.pick === 'A' ? 'selected' : ''}>${esc(teamName('A'))}</option>
        <option value="B" ${m.pick === 'B' ? 'selected' : ''}>${esc(teamName('B'))}</option>
        <option value="decider" ${m.pick === 'decider' ? 'selected' : ''}>Десайдер</option>
      </select>
      <input type="number" min="0" max="99" data-m="scoreA" value="${m.scoreA ?? ''}" placeholder="—">
      <input type="number" min="0" max="99" data-m="scoreB" value="${m.scoreB ?? ''}" placeholder="—">
      <select data-m="winner">
        <option value="" ${!m.winner ? 'selected' : ''}>не сыграна</option>
        <option value="A" ${m.winner === 'A' ? 'selected' : ''}>${esc(teamName('A'))}</option>
        <option value="B" ${m.winner === 'B' ? 'selected' : ''}>${esc(teamName('B'))}</option>
      </select>
      <button class="btn btn--ghost" data-m-del title="Убрать карту">✕</button>
    </div>`).join('');
}

function saveMaps(maps) {
  // Массив целиком: mergeDeep на сервере массивы не сливает, а заменяет
  patch({ series: { ...state.series, maps } });
}

$('maps').addEventListener('change', (e) => {
  const field = e.target.dataset.m;
  if (!field) return;
  const i = Number(e.target.closest('.map-row').dataset.i);
  const maps = state.series.maps.map(m => ({ ...m }));
  let v = e.target.value;
  if (field === 'scoreA' || field === 'scoreB') v = v === '' ? null : Math.max(0, Number(v));
  maps[i][field] = v;
  saveMaps(maps);
  e.target.blur();
});

$('maps').addEventListener('click', (e) => {
  if (!e.target.closest('[data-m-del]')) return;
  const i = Number(e.target.closest('.map-row').dataset.i);
  saveMaps(state.series.maps.filter((_, j) => j !== i));
});

$('addMap').onclick = () => {
  const used = new Set((state.series.maps || []).map(m => m.map));
  const free = window.CS2_MAPS.find(([id]) => !used.has(id));
  saveMaps([...(state.series.maps || []), { map: free ? free[0] : 'de_mirage', pick: 'decider', winner: '', scoreA: null, scoreB: null }]);
};

/* ----------------------------------------------------------- trivia */

function triviaItems() {
  return String(state.trivia?.list || '').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
    const [title, ...rest] = line.split('|');
    return rest.length ? { title: title.trim(), text: rest.join('|').trim() } : { title: '', text: title.trim() };
  });
}

function fillTriviaPos() {
  const n = triviaItems().length;
  $('triviaPos').textContent = n ? `заготовок: ${n}, показан №${(state.trivia.index ?? -1) + 1 || '—'}` : '';
}

function nextTrivia() {
  const items = triviaItems();
  if (!items.length) { toast('Заготовок нет — впишите факты в поле «Заготовки»'); return; }
  const index = ((state.trivia.index ?? -1) + 1) % items.length;
  patch({ trivia: { ...items[index], index, show: true } });
  toast(`Trivia ${index + 1} из ${items.length}`);
}
$('nextTrivia').onclick = nextTrivia;

/* ----------------------------------------------------------- фоны сцен */

const BG_SCENES = [
  { key: 'starting',   name: 'Скоро начнём',   canHide: true },
  { key: 'break',      name: 'Перерыв',        canHide: true },
  { key: 'results',    name: 'Итог карты',     canHide: true },
  { key: 'veto',       name: 'Пики карт',      canHide: false },
  { key: 'bracket',    name: 'Сетка',          canHide: false },
  { key: 'scoreboard', name: 'Таблица счёта',  canHide: false }
];

(function buildBackgrounds() {
  $('bgs').innerHTML = BG_SCENES.map(s => `
    <div class="bg" data-bg="${s.key}">
      <div class="bg__preview" data-bg-preview></div>
      <div class="bg__body">
        <div class="bg__name">${s.name}</div>
        <label class="field"><span>Путь или URL картинки</span>
          <input data-path="backgrounds.${s.key}.image" placeholder="пусто — фирменный фон"></label>
        <div class="row">
          <label class="btn">Загрузить файл…<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-bg-upload hidden></label>
          <button class="btn btn--ghost" data-bg-clear>Убрать</button>
          ${s.canHide ? `<label class="check"><input type="checkbox" data-path="backgrounds.${s.key}.hideContent"> Только картинка</label>` : ''}
        </div>
      </div>
    </div>`).join('');
})();

function fillBackgrounds() {
  for (const s of BG_SCENES) {
    const row = document.querySelector(`[data-bg="${s.key}"]`);
    const url = state.backgrounds?.[s.key]?.image || '';
    const prev = row.querySelector('[data-bg-preview]');
    prev.style.backgroundImage = url ? `url("${url.replace(/"/g, '%22')}")` : '';
    prev.classList.toggle('is-empty', !url);
    row.classList.toggle('bg--on', s.key === state.scene);
  }
}

document.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-bg-upload]');
  if (!input || !input.files[0]) return;
  const row = input.closest('[data-bg]');
  const file = input.files[0];
  try {
    const res = await fetch(`/api/background/${row.dataset.bg}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `ошибка ${res.status}`);
    state = body;
    fill();
    toast('Фон загружен');
  } catch (ex) {
    toast('Не загрузилось: ' + ex.message);
  }
  input.value = '';
});

document.addEventListener('click', (e) => {
  const clear = e.target.closest('[data-bg-clear]');
  if (!clear) return;
  patch({ backgrounds: { [clear.closest('[data-bg]').dataset.bg]: { image: '', hideContent: false } } });
});

/* ----------------------------------------------------------- сетка */

$('applyBracket').onclick = () => {
  const err = $('bracketError');
  try {
    const rounds = JSON.parse($('bracketJson').value || '[]');
    if (!Array.isArray(rounds)) throw new Error('ожидается массив раундов');
    err.hidden = true;
    patch({ bracket: { ...state.bracket, rounds }, scene: 'bracket' });
  } catch (ex) {
    err.hidden = false;
    err.textContent = 'Не разобрал JSON: ' + ex.message;
  }
};

$('sampleBracket').onclick = () => {
  $('bracketJson').value = JSON.stringify([
    { name: 'Полуфиналы', matches: [
      { a: { name: 'ИТ-факультет', score: 2, won: true }, b: { name: 'Энергетики', score: 0 } },
      { a: { name: 'Механики', score: 1 }, b: { name: 'Общежитие 4', score: 2, won: true } }
    ] },
    { name: 'Финал', matches: [
      { a: { name: 'ИТ-факультет', score: 0 }, b: { name: 'Общежитие 4', score: 0 } }
    ] }
  ], null, 2);
};

/* ----------------------------------------------------------- хоткеи */

// Alt+буква, а не F-клавиши: F-клавиши заняты OBS и самой игрой.
// Alt+E, Alt+F и Alt+D не используем — в Chrome они открывают меню и адресную строку.
const SCENE_KEYS = { Digit1: 'auto', Digit2: 'starting', Digit3: 'break', Digit4: 'bracket', Digit5: 'results', Digit6: 'scoreboard', Digit7: 'veto', Digit0: 'blank' };
const TOGGLE_KEYS = { KeyH: 'hud', KeyR: 'stats', KeyM: 'rounds', KeyB: 'economy', KeyK: 'casters', KeyT: 'trivia', KeyC: 'countdown', KeyL: 'killfeed' };
const TOGGLE_NAMES = { hud: 'Вся графика', stats: 'Таблица игроков', rounds: 'История раундов', economy: 'Экономика', casters: 'Комментаторы', trivia: 'Trivia', countdown: 'Таймер', killfeed: 'Лента убийств' };
const TOGGLE_PATHS = { hud: 'showHud', stats: 'panels.stats', rounds: 'panels.rounds', economy: 'panels.economy', casters: 'casters.show', trivia: 'trivia.show', countdown: 'countdown.show', killfeed: 'panels.killfeed' };

document.addEventListener('keydown', (e) => {
  if (window.HUD_EMBEDDED) return;   // внутри общего пульта хоткеи обрабатывает он
  if (!e.altKey || e.ctrlKey || e.metaKey || !state) return;
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

  if (SCENE_KEYS[e.code]) {
    e.preventDefault();
    const scene = SCENE_KEYS[e.code];
    action(`scene-${scene}`);
    flash(document.querySelector(`[data-scene="${scene}"]`));
    return;
  }
  if (TOGGLE_KEYS[e.code]) {
    e.preventDefault();
    const name = TOGGLE_KEYS[e.code];
    const willBe = !get(TOGGLE_PATHS[name]);
    action(`toggle-${name}`);
    const input = document.querySelector(`[data-path="${TOGGLE_PATHS[name]}"]`);
    if (input) flash(input.closest('.tgl') || input);
    toast(`${TOGGLE_NAMES[name]}: ${willBe ? 'показано' : 'скрыто'}`);
    return;
  }
  if (e.code === 'KeyN') { e.preventDefault(); nextTrivia(); return; }
  if (e.code === 'ArrowUp') { e.preventDefault(); addCountdown(1); return; }
  if (e.code === 'ArrowDown') { e.preventDefault(); addCountdown(-1); return; }
});

// Alt в Windows выделяет меню браузера — гасим одиночное отпускание Alt
document.addEventListener('keyup', (e) => { if (e.key === 'Alt') e.preventDefault(); });

function flash(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/* ----------------------------------------------------------- превью */

function fitPreview() {
  const box = $('preview');
  const frame = box.querySelector('iframe');
  frame.style.transform = `scale(${box.clientWidth / 1920})`;
}
window.addEventListener('resize', fitPreview);
fitPreview();

document.querySelectorAll('.port').forEach(el => { el.textContent = location.port || '80'; });

/* ----------------------------------------------------------- прочее */

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
