/* Пульт трансляции для телефона и ноутбука в локальной сети.
   Всё состояние хранится на сервере и приходит по WebSocket, поэтому
   на всех открытых пультах и после перезагрузки страницы картина одинаковая. */

const $ = (id) => document.getElementById(id);

let control = null;
let match = null;
let hud = null;       // общее: какая игра в эфире, плашки CS2, реклама, пауза
let ads = null;       // список роликов (для вкладки «Реклама»)

const SCENE_NAMES = {
  auto: 'Игра', starting: 'Скоро начнём', break: 'Перерыв', bracket: 'Сетка',
  results: 'Итог-заставка', scoreboard: 'Таблица счёта', veto: 'Пики карт', blank: 'Чистый экран'
};
const GAME_NAMES = { dota: 'Dota 2', cs2: 'CS2' };

const STATE_LABEL = {
  DOTA_GAMERULES_STATE_HERO_SELECTION: 'драфт',
  DOTA_GAMERULES_STATE_STRATEGY_TIME: 'драфт',
  DOTA_GAMERULES_STATE_PRE_GAME: 'до горна',
  DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: 'идёт игра',
  DOTA_GAMERULES_STATE_POST_GAME: 'карта окончена'
};

/* ----------------------------------------------------------- связь */

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    $('dotWs').classList.add('on');
    $('offline').hidden = true;
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'control') control = msg.data;
    if (msg.type === 'match') match = msg.data;
    if (msg.type === 'hud') {
      const prevSig = hud && hud.adsSig;
      hud = msg.data;
      if (prevSig !== hud.adsSig) loadAds();
      renderHud();
      return;
    }
    if (msg.type === 'status') {
      $('dotGsi').classList.toggle('on', msg.data.gsiConnected);
      $('sourceWarning').hidden = !msg.data.warning;
      $('sourceWarning').textContent = msg.data.warning || '';
    }
    if (msg.type !== 'gsi') render();
  };
  ws.onclose = () => {
    $('dotWs').classList.remove('on');
    $('dotGsi').classList.remove('on');
    $('offline').hidden = false;
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws.close();
}
connect();

/** Отправить изменение на сервер. Сервер сам разошлёт новое состояние всем. */
async function patch(partial) {
  try {
    const res = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial)
    });
    if (!res.ok) throw new Error(res.status);
    control = await res.json();
    render();
    return true;
  } catch {
    toast('Не отправилось — нет связи с сервером');
    render();   // вернуть переключатели к последнему известному состоянию
    return false;
  }
}

function buzz() {
  if (navigator.vibrate) navigator.vibrate(12);
}

/* ----------------------------------------------------------- привязка полей */

function get(path) {
  return path.split('.').reduce((o, k) => (o ?? {})[k], control);
}

function nest(path, value) {
  return path.split('.').reverse().reduce((acc, key) => ({ [key]: acc }), value);
}

// Текст отправляем с небольшой задержкой, чтобы не слать запрос на каждую букву.
const typingTimers = new Map();

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-path]');
  if (!el || el.type === 'checkbox' || el.tagName === 'SELECT') return;
  clearTimeout(typingTimers.get(el));
  typingTimers.set(el, setTimeout(() => patch(nest(el.dataset.path, el.value)), 450));
});

document.addEventListener('change', (e) => {
  // Переключатели CS2 и общие: через быстрые действия сервера
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    buzz();
    fetch(`/api/action/${tg.dataset.toggle}`, { method: 'POST' }).catch(() => toast('Не отправилось — нет связи с сервером'));
    return;
  }
  const el = e.target.closest('[data-path]');
  if (!el) return;
  if (el.type === 'checkbox') { buzz(); patch(nest(el.dataset.path, el.checked)); }
  else if (el.tagName === 'SELECT') patch(nest(el.dataset.path, el.value));
  else {
    clearTimeout(typingTimers.get(el));
    patch(nest(el.dataset.path, el.value));
  }
});

/* ----------------------------------------------------------- фон заставок */

const updateBackgrounds = createBackgroundPanel($('bgPanel'), { patch, toast: (t) => toast(t) });

/* ----------------------------------------------------------- отрисовка */

function render() {
  if (!control) return;
  const rad = control.radiant.name || 'Radiant';
  const dire = control.dire.name || 'Dire';

  // Поля и переключатели. Поле, в котором сейчас печатают, не трогаем.
  document.querySelectorAll('[data-path]').forEach((el) => {
    if (document.activeElement === el) return;
    const value = get(el.dataset.path);
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value ?? '';
  });

  // Шапка
  $('onairScene').textContent = SCENE_NAMES[control.scene] || control.scene;
  if (match && match.gameState) {
    const parts = [`<b>${esc(rad)} — ${esc(dire)}</b>`];
    if (match.clock != null) parts.push(clock(match.clock));
    parts.push(match.paused ? 'пауза' : (STATE_LABEL[match.gameState] || 'в меню'));
    if (match.probability && !match.finished) parts.push(`${match.probability.radiant}% / ${match.probability.dire}%`);
    $('matchLine').innerHTML = parts.join(' · ');
  } else {
    $('matchLine').textContent = 'Ждём данные из игры';
  }

  // Сцены
  document.querySelectorAll('[data-scene]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.scene === control.scene);
    b.setAttribute('aria-pressed', String(b.dataset.scene === control.scene));
  });

  // Серия
  $('radWins').textContent = control.series.radiantWins;
  $('direWins').textContent = control.series.direWins;
  document.querySelectorAll('[data-path="results.winner"] option').forEach((o) => {
    o.textContent = o.value === 'radiant' ? rad : dire;
  });

  renderProbability(rad, dire);
  renderResults(rad, dire);
  renderTrivia();
  renderCountdown();
  updateBackgrounds(control);
  renderHud();   // общее состояние (и картина CS2, если в эфире она)
}

function renderProbability(rad, dire) {
  const p = match && match.probability;
  if (match && match.finished) {
    $('probPreview').textContent = 'Карта окончена — плашка вероятности в эфир не выходит';
  } else if (p) {
    $('probPreview').textContent = `${rad} ${p.radiant}% — ${p.dire}% ${dire}`;
  } else {
    $('probPreview').textContent = 'Появится, когда начнётся игра';
  }

  const c = match && match.comparison;
  const cmp = $('probCmp');
  if (control.probability.show && c && !match.finished) {
    const arrow = c.delta > 0 ? `▲${c.delta}` : c.delta < 0 ? `▼${Math.abs(c.delta)}` : '= 0';
    cmp.hidden = false;
    cmp.innerHTML = `${clock(c.from.clock)} → ${clock(c.to.clock)}: ${esc(rad)} ${c.from.radiant}% → ${c.to.radiant}% ` +
      `<span class="${c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : ''}">(${arrow})</span>`;
  } else {
    cmp.hidden = true;
  }
}

function renderResults(rad, dire) {
  const r = match && match.results;
  if (r && !r.provisional) {
    const winner = r.winner === 'radiant' ? rad : r.winner === 'dire' ? dire : null;
    $('resPreview').textContent =
      `${winner ? 'Победа ' + winner : 'Карта окончена'} · ${r.radiantScore} : ${r.direScore} · ${clock(r.duration)}`;
  } else if (r) {
    $('resPreview').textContent = 'Карта ещё идёт — покажется текущая статистика';
  } else {
    $('resPreview').textContent = 'Данных из игры пока нет';
  }
  const od = match && match.enrichment;
  $('odStatus').textContent = match && match.finished && od && od.message ? `OpenDota: ${od.message}` : '';
}

function renderTrivia() {
  const t = control.trivia;
  const btn = $('triviaToggle');
  btn.textContent = t.show ? 'Убрать из эфира' : 'Показать';
  btn.classList.toggle('is-on', !!t.show);
  $('triviaHint').textContent = t.title || t.text
    ? `«${(t.title || t.text).slice(0, 40)}»`
    : 'текст — во вкладке «Тексты»';

  const list = control.triviaLibrary || [];
  const sig = JSON.stringify([list, t.title, t.text, t.show]);
  const ul = $('triviaLibrary');
  if (ul.dataset.sig === sig) return;   // не перерисовываем список без изменений
  ul.dataset.sig = sig;
  ul.innerHTML = list.map((f, i) => {
    const live = t.show && f.title === t.title && f.text === t.text;
    return `
      <li class="fact ${live ? 'is-live' : ''}">
        <div class="fact__text">
          <div class="fact__title">${esc(f.title || 'Без заголовка')}</div>
          <div class="fact__body">${esc(f.text)}</div>
        </div>
        <button type="button" data-fact-show="${i}">${live ? 'В эфире' : 'Вывести'}</button>
        <button type="button" class="fact__del" data-fact-del="${i}" aria-label="Удалить заготовку">✕</button>
      </li>`;
  }).join('');
}

function renderCountdown() {
  const to = control.starting && control.starting.countdownTo;
  const info = $('countdownInfo');
  if (!to) { info.textContent = 'Отсчёт не задан'; return; }
  const left = Math.floor((new Date(to).getTime() - Date.now()) / 1000);
  info.textContent = left > 0 ? `До начала ${clock(left)} — видно на заставке «Скоро начнём»` : 'Отсчёт закончился';
}
setInterval(() => control && renderCountdown(), 1000);

/* ----------------------------------------------------------- действия */

document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  if (act) {
    buzz();
    try {
      const res = await fetch(`/api/action/${act.dataset.act}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      toast(res.ok ? (ACT_DONE[act.dataset.act] || 'Готово') : (body.error || 'Не получилось'));
    } catch { toast('Не отправилось — нет связи с сервером'); }
    return;
  }

  const scene = e.target.closest('[data-scene]');
  if (scene) {
    buzz();
    if (await patch({ scene: scene.dataset.scene })) toast(`В эфире: ${SCENE_NAMES[scene.dataset.scene]}`);
    return;
  }

  const inc = e.target.closest('[data-inc]');
  if (inc) {
    buzz();
    const next = Math.max(0, (get(inc.dataset.inc) || 0) + Number(inc.dataset.by));
    patch(nest(inc.dataset.inc, next));
    return;
  }

  const cd = e.target.closest('[data-countdown]');
  if (cd) {
    const min = Number(cd.dataset.countdown);
    const to = min ? new Date(Date.now() + min * 60000).toISOString() : null;
    if (await patch({ starting: { countdownTo: to } })) toast(min ? `Отсчёт: ${min} мин` : 'Отсчёт убран');
    return;
  }

  const show = e.target.closest('[data-fact-show]');
  if (show) {
    const f = control.triviaLibrary[Number(show.dataset.factShow)];
    if (!f) return;
    buzz();
    if (await patch({ trivia: { title: f.title, text: f.text, show: true } })) toast('Trivia в эфире');
    return;
  }

  const del = e.target.closest('[data-fact-del]');
  if (del) {
    const i = Number(del.dataset.factDel);
    const f = control.triviaLibrary[i];
    if (!f || !confirm(`Удалить заготовку «${f.title || f.text.slice(0, 30)}»?`)) return;
    patch({ triviaLibrary: control.triviaLibrary.filter((_, k) => k !== i) });
  }
});

$('triviaToggle').addEventListener('click', () => {
  buzz();
  patch({ trivia: { show: !control.trivia.show } });
});

$('triviaSave').addEventListener('click', async () => {
  const title = control.trivia.title.trim();
  const text = control.trivia.text.trim();
  if (!text) { toast('Сначала напишите текст факта'); return; }
  const list = control.triviaLibrary || [];
  if (list.some((f) => f.title === title && f.text === text)) { toast('Такая заготовка уже есть'); return; }
  if (await patch({ triviaLibrary: [...list, { title, text }] })) toast('Сохранено в заготовки');
});

$('swapTeams').addEventListener('click', async () => {
  if (await patch({
    radiant: { ...control.dire },
    dire: { ...control.radiant },
    series: { ...control.series, radiantWins: control.series.direWins, direWins: control.series.radiantWins }
  })) toast('Команды поменялись местами');
});

$('hideAll').addEventListener('click', async () => {
  buzz();
  if (await patch({
    probability: { show: false },
    mapResults: { show: false },
    trivia: { show: false },
    casters: { show: false },
    panels: { rosters: false }
  })) toast('Все плашки убраны');
});

$('resetMatch').addEventListener('click', async () => {
  if (!confirm('Сбросить матч? Итоги карты и снимки вероятности будут удалены.')) return;
  try {
    await fetch('/api/match/reset', { method: 'POST' });
    toast('Матч сброшен');
  } catch {
    toast('Не отправилось — нет связи с сервером');
  }
});

/* ----------------------------------------------------------- вкладки */

function showTab(name) {
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.tab === name));
  document.querySelectorAll('[data-goto]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.goto === name);
    b.setAttribute('aria-current', b.dataset.goto === name ? 'page' : 'false');
  });
  try { localStorage.setItem('caster-tab', name); } catch { /* приватный режим */ }
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));

let savedTab = 'air';
try { savedTab = localStorage.getItem('caster-tab') || 'air'; } catch { /* приватный режим */ }
showTab(document.querySelector(`[data-tab="${savedTab}"]`) ? savedTab : 'air');

/* ----------------------------------------------------------- всплывашка и хоткеи */

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 1600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// С клавиатуры ноутбука — те же хоткеи, что на пульте оператора.
bindHotkeys(window, {
  getGame: () => (hud && hud.game) || 'dota',
  onAction: (hk, res) => toast(res && res.error ? `${hk.title}: ${res.error}` : hk.title)
});

/* ----------------------------------------------------------- две игры и реклама */

const ACT_DONE = { 'ads-play': 'Реклама запускается', 'ads-stop': 'Реклама останавливается', 'ads-skip': 'Следующий ролик', 'sides-swap': 'Стороны поменялись' };

function renderHud() {
  if (!hud) return;
  const game = hud.game;
  $('gameBadge').textContent = GAME_NAMES[game] || game;
  document.querySelectorAll('[data-only]').forEach((el) => { el.hidden = el.dataset.only !== game; });
  document.querySelectorAll('[data-hud]').forEach((el) => {
    const v = el.dataset.hud.split('.').reduce((o, k) => (o ?? {})[k], hud);
    el.checked = !!v;
  });
  // В CS2 строка матча — из сводки CS2
  if (game === 'cs2') {
    const s = hud.games.cs2.summary;
    $('matchLine').innerHTML = s
      ? `<b>${esc(hud.teams.A.name)} — ${esc(hud.teams.B.name)}</b> · ${esc(s.map)} · раунд ${s.round} · ${s.score}${s.paused ? ' · пауза' : ''}`
      : 'Ждём данные из CS2';
    $('onairScene').textContent = SCENE_NAMES[hud.scene] || hud.scene;
    document.querySelectorAll('[data-scene]').forEach((b) => b.classList.toggle('is-active', b.dataset.scene === hud.scene));
  }
  const a = hud.ads;
  const playing = a.status === 'playing';
  $('pauseHint').hidden = !hud.paused || playing;
  $('adsLive').hidden = !playing;
  if (playing) $('adsLiveText').textContent = `Реклама: ${a.current} (${a.index + 1}/${a.total})`;
  $('adsStatus').textContent = playing
    ? `Идёт: ${a.current} · ${a.index + 1} из ${a.total}`
    : !a.mainConnected ? 'OBS-оверлей не подключён — реклама не запустится'
    : a.error || 'Реклама не идёт';
  renderAdsQueue();
}

async function loadAds() {
  try { ads = await fetch('/api/ads').then((r) => r.json()); } catch { return; }
  renderAdsQueue();
}

function renderAdsQueue() {
  if (!ads) return;
  const byId = Object.fromEntries(ads.clips.map((c) => [c.id, c]));
  const live = hud && hud.ads.status === 'playing' ? hud.ads.current : null;
  $('adsQueue').innerHTML = ads.queue.map((id) => byId[id]).filter(Boolean).map((c, i) =>
    `<li class="fact ${live === c.name ? 'is-live' : ''}"><div class="fact__text"><div class="fact__title">${i + 1}. ${esc(c.name)}</div>` +
    `<div class="fact__body">${c.duration ? clock(c.duration) : ''}</div></div></li>`).join('');
}
