/* Общий пульт: игра в эфире, пульты игр (Dota и CS2 — свои страницы внутри),
   реклама, анимация пика, хоткеи. */

const $ = (id) => document.getElementById(id);
let hud = null;

/* ----------------------------------------------------------- связь */

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=pult`);
  ws.onopen = () => $('pillWs').classList.add('on');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'hud') { const prev = hud; hud = msg.data; renderHud(prev); }
  };
  ws.onclose = () => {
    $('pillWs').classList.remove('on');
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws.close();
}
connect();

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'POST',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `ошибка ${res.status}`);
  return data;
}

const action = (name) => api(`/api/action/${encodeURIComponent(name)}`).catch((ex) => { toast(ex.message, true); throw ex; });

let toastTimer;
function toast(text, error) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('is-error', !!error);
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 1800);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ----------------------------------------------------------- шапка и состояние */

const GAME_NAMES = { dota: 'Dota 2', cs2: 'CS2' };
const SCENE_NAMES = {
  auto: 'Игра', starting: 'Скоро начнём', break: 'Перерыв', bracket: 'Сетка',
  results: 'Итог-заставка', scoreboard: 'Таблица счёта', veto: 'Пики карт', blank: 'Чистый экран'
};

function renderHud(prev) {
  if (!hud) return;
  const game = hud.game;

  document.querySelectorAll('.gameswitch [data-game]').forEach((b) => {
    const on = b.dataset.game === game;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('gsiDota').classList.toggle('on', !!hud.games.dota.alive);
  $('gsiCs2').classList.toggle('on', !!hud.games.cs2.alive);
  $('gsiDota').title = hud.games.dota.alive ? 'данные из Dota 2 идут' : 'данных из Dota 2 нет';
  $('gsiCs2').title = hud.games.cs2.alive ? 'данные из CS2 идут' : 'данных из CS2 нет';
  $('pillObs').classList.toggle('on', !!hud.ads.mainConnected);

  // Строка матча
  const a = hud.teams.A.name || 'Команда A';
  const b = hud.teams.B.name || 'Команда B';
  const parts = [`<b>${esc(a)} ${hud.series.aWins}:${hud.series.bWins} ${esc(b)}</b>`, `в эфире: ${SCENE_NAMES[hud.scene] || hud.scene}`];
  const sum = hud.games[game].summary;
  if (sum && game === 'dota' && sum.clock != null) parts.push(`${clockSigned(sum.clock)}${sum.paused ? ' · пауза' : ''}`);
  if (sum && game === 'cs2') parts.push(`${esc(sum.map)} · раунд ${sum.round} · ${sum.score}${sum.paused ? ' · пауза' : ''}`);
  $('matchLine').innerHTML = parts.join(' · ');

  // Пульт игры
  document.querySelectorAll('.gameframe').forEach((f) => f.classList.toggle('is-on', f.dataset.game === game));
  document.querySelectorAll('[data-only]').forEach((el) => { el.hidden = el.dataset.only !== game; });
  if (document.querySelector('.tabs .is-active')?.hidden) showTab('game');

  // Пауза и реклама
  const ads = hud.ads;
  const playing = ads.status === 'playing';
  $('noticePause').hidden = !hud.paused || playing;
  $('noticeAds').hidden = !playing;
  if (playing) {
    const phase = { in: 'переход', between: 'переход', clip: '', out: 'выход' }[ads.phase] || '';
    $('adsNowText').innerHTML = `<b>${esc(ads.current || 'Реклама')}</b> · ${ads.index + 1} из ${ads.total}` +
      (ads.phase === 'clip' && ads.duration ? ` · ${clock(ads.position)} / ${clock(ads.duration)}` : phase ? ` · ${phase}` : '');
    $('adsNowBar').style.width = ads.duration ? `${Math.min(100, (ads.position / ads.duration) * 100)}%` : '0%';
  }
  const warn = [];
  if (!ads.mainConnected) warn.push('OBS-оверлей не подключён: в OBS должен быть открыт overlay.html?obs=1 — без него реклама не запустится, а звука не будет.');
  if (ads.error && !playing) warn.push(ads.error);
  $('noticeWarn').hidden = !warn.length;
  $('noticeWarn').textContent = warn.join(' ');

  // Реклама: перечитать список, если он поменялся (в том числе с другого пульта)
  if (!prev || prev.adsSig !== hud.adsSig) loadAds();
  else renderLive();

  renderPickSettings();
  if (!prev || prev.game !== game) renderKeys();
}

function clockSigned(s) {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(Math.trunc(s));
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

/* ----------------------------------------------------------- переключение игры

   В эфире меняется весь оверлей, поэтому переключение — двумя нажатиями:
   первое спрашивает «точно?», второе (в течение 3 секунд) переключает. */

let confirmTimer = null;
document.querySelectorAll('.gameswitch [data-game]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const game = btn.dataset.game;
    if (!hud || hud.game === game) return;
    if (!btn.classList.contains('is-confirm')) {
      document.querySelectorAll('.gameswitch .is-confirm').forEach((b) => { b.classList.remove('is-confirm'); b.querySelector('b').textContent = GAME_NAMES[b.dataset.game]; });
      btn.classList.add('is-confirm');
      btn.querySelector('b').textContent = 'Точно? Ещё раз';
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { btn.classList.remove('is-confirm'); btn.querySelector('b').textContent = GAME_NAMES[game]; }, 3000);
      return;
    }
    clearTimeout(confirmTimer);
    btn.classList.remove('is-confirm');
    btn.querySelector('b').textContent = GAME_NAMES[game];
    try {
      await api('/api/game', { body: { game } });
      toast(`В эфире: ${GAME_NAMES[game]}`);
    } catch (ex) { toast(ex.message, true); }
  });
});

/* ----------------------------------------------------------- вкладки */

function showTab(name) {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === name));
  // Превью грузим только когда вкладку открыли: это ещё один оверлей с двумя HUD внутри.
  document.querySelectorAll(`.panel[data-panel="${name}"] .preview iframe[data-src]`).forEach((f) => {
    if (f.getAttribute('src') === 'about:blank') f.src = f.dataset.src;
  });
  fitPreviews();
  try { localStorage.setItem('pult-tab', name); } catch { /* приватный режим */ }
}
document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
try { const t = localStorage.getItem('pult-tab'); if (t && document.querySelector(`[data-panel="${t}"]`)) showTab(t); } catch { /* */ }

function fitPreviews() {
  document.querySelectorAll('.preview').forEach((box) => {
    const f = box.querySelector('iframe');
    if (box.clientWidth) f.style.transform = `scale(${box.clientWidth / 1920})`;
  });
}
window.addEventListener('resize', fitPreviews);

/* ----------------------------------------------------------- пульты игр */

const pults = { dota: $('pultDota'), cs2: $('pultCs2') };
pults.dota.src = '/control-dota.html';
pults.cs2.src = '/cs2/control.html';

for (const frame of Object.values(pults)) {
  frame.addEventListener('load', () => {
    const win = frame.contentWindow;
    // Хоткеи ловим и внутри пульта игры: фокус чаще всего там.
    bindHotkeys(win, { getGame: () => hud?.game || 'dota', onAction: hotkeyDone });
  });
}

bindHotkeys(window, { getGame: () => hud?.game || 'dota', onAction: hotkeyDone });

function hotkeyDone(hk, res) {
  if (res && res.error) { toast(`${hk.title}: ${res.error}`, true); return; }
  const state = res && typeof res.on === 'boolean' ? (res.on ? ' — показано' : ' — скрыто') : '';
  toast(`${hk.title}${state}`);
}

/* ----------------------------------------------------------- кнопки-действия */

document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  try {
    await action(act.dataset.act);
    if (act.dataset.act === 'ads-play') toast('Реклама запускается');
  } catch { /* toast уже показан */ }
});

/* ====================================================================== РЕКЛАМА */

let adsData = null;

async function loadAds() {
  try {
    adsData = await api('/api/ads', { method: 'GET' });
    renderAds();
  } catch { /* сервер недоступен — перечитаем по следующему hud */ }
}

function renderAds() {
  if (!adsData) return;
  const a = adsData;

  $('between').value = a.between || 'transition';

  // Очередь
  const byId = Object.fromEntries(a.clips.map((c) => [c.id, c]));
  const queue = a.queue.map((id) => byId[id]).filter(Boolean);
  $('queueEmpty').hidden = queue.length > 0;
  $('queue').innerHTML = queue.map((c, i) => `
    <li data-id="${c.id}">
      <span class="thumb" style="${c.poster ? `background-image:url('${c.poster}')` : ''}"></span>
      <span>${esc(c.name)}</span>
      <span class="dur">${c.duration ? clock(c.duration) : '—'}</span>
      <button type="button" class="btn btn--icon" data-q-move="-1" ${i === 0 ? 'disabled' : ''} title="Выше">↑</button>
      <button type="button" class="btn btn--icon" data-q-move="1" ${i === queue.length - 1 ? 'disabled' : ''} title="Ниже">↓</button>
    </li>`).join('');

  // Ролики
  const transOpts = (sel) => [
    `<option value="" ${!sel ? 'selected' : ''}>переход по умолчанию</option>`,
    `<option value="none" ${sel === 'none' ? 'selected' : ''}>без перехода</option>`,
    ...a.transitions.map((t) => `<option value="${t.id}" ${sel === t.id ? 'selected' : ''}>${esc(t.name)}</option>`)
  ].join('');
  if (!$('clips').contains(document.activeElement)) {
    $('clips').innerHTML = a.clips.length ? a.clips.map((c) => `
      <li class="file" data-kind="clip" data-id="${c.id}">
        <div class="file__poster" style="${c.poster ? `background-image:url('${c.poster}')` : ''}"><span>${c.duration ? clock(c.duration) : '—'}</span></div>
        <div class="file__body">
          <input class="file__name" data-f="name" value="${esc(c.name)}" aria-label="Название ролика">
          <div class="file__meta">
            <label class="inq"><input type="checkbox" data-f="queued" ${a.queue.includes(c.id) ? 'checked' : ''}> в очереди</label>
            <label>переход <select data-f="transition">${transOpts(c.transition)}</select></label>
            <label>громкость <input type="range" min="0" max="100" step="5" data-f="volume" value="${c.volume ?? 100}"></label>
          </div>
          ${c.warn ? `<div class="file__warn">${esc(c.warn)}</div>` : ''}
          <div class="file__actions">
            <button type="button" class="btn" data-play-one>▶ Только этот ролик</button>
            <a class="btn" href="${c.url}" target="_blank">Открыть файл</a>
            <button type="button" class="btn btn--danger" data-del>Удалить</button>
          </div>
        </div>
      </li>`).join('') : '<li class="empty">Роликов пока нет.</li>';
  }

  // Переходы
  if (!$('transitions').contains(document.activeElement)) {
    $('transitions').innerHTML = a.transitions.length ? a.transitions.map((t) => `
      <li class="file" data-kind="transition" data-id="${t.id}">
        <div class="file__poster is-trans"><span>${t.duration ? clock(t.duration) : ''}</span></div>
        <div class="file__body">
          <input class="file__name" data-f="name" value="${esc(t.name)}" aria-label="Название перехода">
          <div class="file__meta">
            <label class="inq"><input type="radio" name="defTrans" data-f="default" ${a.defaultTransition === t.id ? 'checked' : ''}> по умолчанию</label>
            <label>точка перекрытия <input type="number" min="0" step="50" data-f="cutMs" value="${t.cutMs ?? 500}"> мс</label>
            <label>громкость <input type="range" min="0" max="100" step="5" data-f="volume" value="${t.volume ?? 100}"></label>
          </div>
          <div class="file__actions">
            <button type="button" class="btn" data-tpreview>Проверить</button>
            <button type="button" class="btn btn--danger" data-del>Удалить</button>
          </div>
        </div>
      </li>`).join('') : '<li class="empty">Переходов нет — реклама будет начинаться и заканчиваться прямой склейкой.</li>';
  }
  renderLive();
  probeNew();
}

// Файлы, которые положили в папку руками, приходят без длительности и превью —
// открываем их в пульте так же, как после загрузки: заодно проверяем, что они играют.
const probed = new Set();
async function probeNew() {
  for (const [kind, list] of [['clip', adsData.clips], ['transition', adsData.transitions]]) {
    for (const item of list) {
      if (item.duration || probed.has(item.id)) continue;
      probed.add(item.id);
      await probe(kind, item);
    }
  }
}

function renderLive() {
  if (!hud || !adsData) return;
  const playing = hud.ads.status === 'playing';
  const liveName = playing ? hud.ads.current : null;
  document.querySelectorAll('#clips .file, #queue li').forEach((el) => {
    const c = adsData.clips.find((x) => x.id === el.dataset.id);
    el.classList.toggle('is-live', !!(liveName && c && c.name === liveName));
  });
}

function adsMsg(text, error) {
  const el = $('adsMsg');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('is-error', !!error);
}

// Свойства роликов и переходов
document.addEventListener('change', async (e) => {
  const f = e.target.dataset.f;
  const row = e.target.closest('.file');
  if (!f || !row) return;
  const { kind, id } = row.dataset;
  try {
    if (f === 'queued') {
      const q = adsData.queue.filter((x) => x !== id);
      if (e.target.checked) q.push(id);
      await api('/api/ads/settings', { body: { queue: q } });
    } else if (f === 'default') {
      await api('/api/ads/settings', { body: { defaultTransition: id } });
    } else {
      let value = e.target.value;
      if (f === 'cutMs' || f === 'volume') value = Math.max(0, Number(value) || 0);
      await api(`/api/ads/${kind}/${id}`, { method: 'PATCH', body: { [f]: value } });
      e.target.blur();
    }
  } catch (ex) { toast(ex.message, true); }
});

$('between').addEventListener('change', () => api('/api/ads/settings', { body: { between: $('between').value } }).catch((ex) => toast(ex.message, true)));

document.addEventListener('click', async (e) => {
  const move = e.target.closest('[data-q-move]');
  if (move) {
    const id = move.closest('li').dataset.id;
    const q = [...adsData.queue];
    const i = q.indexOf(id);
    const j = i + Number(move.dataset.qMove);
    if (i < 0 || j < 0 || j >= q.length) return;
    [q[i], q[j]] = [q[j], q[i]];
    api('/api/ads/settings', { body: { queue: q } }).catch((ex) => toast(ex.message, true));
    return;
  }
  const del = e.target.closest('.file [data-del]');
  if (del) {
    const row = del.closest('.file');
    const name = row.querySelector('.file__name').value;
    if (!confirm(`Удалить «${name}»? Файл будет удалён с диска.`)) return;
    api(`/api/ads/${row.dataset.kind}/${row.dataset.id}`, { method: 'DELETE' }).catch((ex) => toast(ex.message, true));
    return;
  }
  const one = e.target.closest('[data-play-one]');
  if (one) {
    try {
      await api('/api/ads/play', { body: { ids: [one.closest('.file').dataset.id] } });
      adsMsg('');
      toast('Реклама запускается');
    } catch (ex) { adsMsg(ex.message, true); }
    return;
  }
  const tp = e.target.closest('[data-tpreview]');
  if (tp) previewTransition(tp.closest('.file').dataset.id);
});

// Ошибки запуска рекламы из кнопок показываем и под очередью
document.querySelectorAll('[data-act="ads-play"]').forEach((b) => b.addEventListener('click', () => adsMsg('')));

/* ----------------------------------------------------------- проверка перехода */

let tpTimer = null;
function previewTransition(id) {
  const t = adsData.transitions.find((x) => x.id === id);
  if (!t) return;
  const box = $('tpreview');
  const v = $('tpVideo');
  box.hidden = false;
  v.src = t.url;
  v.currentTime = 0;
  v.play().catch(() => {});
  cancelAnimationFrame(tpTimer);
  const flag = $('tpFlag');
  const tick = () => {
    const ms = v.currentTime * 1000;
    flag.classList.toggle('is-on', ms >= t.cutMs && ms < t.cutMs + 400);
    if (ms >= t.cutMs && ms < t.cutMs + 60 && !v.dataset.paused) { v.pause(); v.dataset.paused = '1'; setTimeout(() => { v.play().catch(() => {}); }, 900); }
    if (!v.ended) tpTimer = requestAnimationFrame(tick);
  };
  v.dataset.paused = '';
  tpTimer = requestAnimationFrame(tick);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ----------------------------------------------------------- загрузка файлов */

document.querySelectorAll('[data-upload]').forEach((zone) => {
  const kind = zone.dataset.upload;
  const input = zone.querySelector('input[type=file]');
  input.addEventListener('change', () => { [...input.files].forEach((f) => upload(kind, f)); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    [...e.dataTransfer.files].forEach((f) => upload(kind, f));
  });
});

function upload(kind, file) {
  const list = $(kind === 'clip' ? 'uploadsClip' : 'uploadsTransition');
  const row = document.createElement('div');
  row.className = 'upload';
  row.innerHTML = `<span>${esc(file.name)}</span><span class="upload__pct">0%</span><div class="upload__bar"><span></span></div>`;
  list.append(row);
  const pct = row.querySelector('.upload__pct');
  const bar = row.querySelector('.upload__bar span');

  const type = file.type || (/\.webm$/i.test(file.name) ? 'video/webm' : /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/ads/upload/${kind}`);
  xhr.setRequestHeader('Content-Type', type);
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const p = Math.round((e.loaded / e.total) * 100);
    pct.textContent = `${p}%`;
    bar.style.width = `${p}%`;
  };
  xhr.onload = async () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch { /* */ }
    if (xhr.status !== 200) {
      row.classList.add('is-error');
      pct.textContent = body.error || `ошибка ${xhr.status}`;
      return;
    }
    pct.textContent = 'проверяю…';
    await probe(kind, body);
    row.remove();
  };
  xhr.onerror = () => { row.classList.add('is-error'); pct.textContent = 'нет связи с сервером'; };
  xhr.send(file);
}

/**
 * Открывает загруженный файл в браузере пульта: длительность, превью-кадр,
 * и главное — проверка, что видео вообще декодируется. OBS построен на том же
 * Chromium: если пульт не смог открыть файл, OBS его, скорее всего, тоже не сыграет.
 */
function probe(kind, item) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = item.url;
    let done = false;
    const finish = async (patch) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (patch) await api(`/api/ads/${kind}/${item.id}`, { method: 'PATCH', body: patch }); } catch { /* */ }
      v.removeAttribute('src'); v.load();
      resolve();
    };
    const timer = setTimeout(() => { warnFile(item, 'Браузер не смог открыть файл за 15 секунд. Проверьте ролик в превью — возможно, нужен другой кодек (см. README).'); finish(null); }, 15000);
    v.onerror = () => {
      warnFile(item, 'Браузер не открыл этот файл — OBS его, скорее всего, тоже не сыграет. Перекодируйте в MP4 (H.264 + AAC) или WebM — команда в README.');
      finish(null);
    };
    v.onloadedmetadata = () => {
      const duration = Math.round(v.duration * 10) / 10;
      if (!v.videoWidth) warnFile(item, 'В файле нет картинки, которую понимает браузер (часто так с H.265/HEVC). Перекодируйте в H.264.');
      if (kind === 'transition') { finish({ duration }); return; }
      v.currentTime = Math.min(1.5, (v.duration || 4) * 0.25);
      v.onseeked = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 320; c.height = 180;
          const g = c.getContext('2d');
          g.fillStyle = '#000'; g.fillRect(0, 0, 320, 180);
          const k = Math.min(320 / v.videoWidth, 180 / v.videoHeight);
          const w = v.videoWidth * k, h = v.videoHeight * k;
          g.drawImage(v, (320 - w) / 2, (180 - h) / 2, w, h);
          c.toBlob(async (blob) => {
            if (blob) await fetch(`/api/ads/clip/${item.id}/poster`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob }).catch(() => {});
            finish({ duration });
          }, 'image/jpeg', 0.8);
        } catch { finish({ duration }); }
      };
    };
  });
}

function warnFile(item, text) {
  toast(text, true);
  adsMsg(`«${item.name}»: ${text}`, true);
}

/* ====================================================================== ПИК ГЕРОЯ */

function renderPickSettings() {
  const p = hud.pickFx || {};
  if (document.activeElement !== $('pfEnabled')) $('pfEnabled').checked = !!p.enabled;
  if (document.activeElement !== $('pfVoice')) $('pfVoice').checked = p.voice !== false;
  if (document.activeElement !== $('pfVolume')) $('pfVolume').value = p.volume ?? 80;
  $('pfVolLabel').textContent = p.volume ?? 80;
}

$('pfEnabled').addEventListener('change', () => api('/api/pickfx/settings', { body: { enabled: $('pfEnabled').checked } }));
$('pfVoice').addEventListener('change', () => api('/api/pickfx/settings', { body: { voice: $('pfVoice').checked } }));
$('pfVolume').addEventListener('input', () => { $('pfVolLabel').textContent = $('pfVolume').value; });
$('pfVolume').addEventListener('change', () => api('/api/pickfx/settings', { body: { volume: Number($('pfVolume').value) } }));

const TEST_HEROES = ['juggernaut', 'pudge', 'invoker', 'crystal_maiden', 'phantom_assassin', 'earthshaker', 'lina', 'sven', 'witch_doctor', 'storm_spirit', 'axe'];
let testSide = 'radiant';
$('pfTest').addEventListener('click', async () => {
  const hero = TEST_HEROES[Math.floor(Math.random() * TEST_HEROES.length)];
  testSide = testSide === 'radiant' ? 'dire' : 'radiant';
  try {
    const r = await api(`/api/pickfx/test?hero=${hero}&side=${testSide}`);
    toast(`Пик: ${hero}${r.voice ? ' (с фразой)' : ' (фразы нет)'}`);
  } catch (ex) { toast(ex.message, true); }
});

async function loadVoices() {
  try {
    const v = await api('/api/pickfx/voices', { method: 'GET' });
    $('pfVoices').textContent = v.count
      ? `Фраз героев в папке: ${v.count}.`
      : 'Фраз героев в папке пока нет — анимация будет без звука.';
  } catch { /* */ }
}
loadVoices();

/* ====================================================================== ХОТКЕИ */

function renderKeys() {
  const game = hud?.game || 'dota';
  $('keysGame').textContent = `сейчас — ${GAME_NAMES[game]}`;
  const other = game === 'dota' ? 'cs2' : 'dota';
  const row = (h) => `<dt><kbd>${esc(h.label)}</kbd></dt><dd>${esc(h.title)}</dd>`;
  $('keysList').innerHTML =
    `<div class="sep">Общие</div>${HOTKEYS.common.map(row).join('')}` +
    `<div class="sep">${GAME_NAMES[game]}</div>${HOTKEYS[game].map(row).join('')}` +
    `<div class="sep">${GAME_NAMES[other]} (когда она в эфире)</div>${HOTKEYS[other].map(row).join('')}`;
  api(`/api/actions?all=1`, { method: 'GET' }).then((list) => {
    $('actionsList').innerHTML = list.map((a) => `<li><code>${esc(a.name)}</code>${esc(a.title)}</li>`).join('');
  }).catch(() => {});
}

document.querySelectorAll('.port').forEach((el) => { el.textContent = location.port || '80'; });
