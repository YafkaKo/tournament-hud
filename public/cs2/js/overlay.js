/* Оверлей CS2: получает по WebSocket состояние пульта (control) и готовую
   картину матча (game) и рисует сцены.

   Данных из игры может не быть вообще — это нормально: заставки, сетка
   и пики карт работают и без CS2. */

const params = new URLSearchParams(location.search);
if (params.get('obs') === '1') document.body.classList.add('obs');

const $ = id => document.getElementById(id);

let control = null;
let game = null;
let gameAt = 0;               // performance.now() в момент получения game — для плавных таймеров
let gsiConnected = false;

/* ----------------------------------------------------------- соединение */

let retry = 0;
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { retry = 0; document.body.classList.add('is-connected'); document.body.classList.remove('is-loading'); };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'control') control = msg.data;
    if (msg.type === 'game') { game = msg.data; gameAt = performance.now(); gsiConnected = true; }
    if (msg.type === 'status') gsiConnected = msg.data.gsiConnected;
    render();
  };
  ws.onclose = () => {
    document.body.classList.remove('is-connected');
    retry = Math.min(retry + 1, 10);
    setTimeout(connect, 400 * retry);
  };
  ws.onerror = () => ws.close();
}
connect();

/* ----------------------------------------------------------- утилиты */

const esc = str => String(str ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const icon = (name, cls = '') => `<svg class="ico ${cls}"><use href="#i-${name}"/></svg>`;
const money = n => '$' + Math.round(n || 0).toLocaleString('en-US');
const sideClass = side => (side === 'T' ? 'is-t' : 'is-ct');

function clock(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return '—';
  const s = Math.max(0, Math.ceil(Number(sec)));
  const pad = n => String(n).padStart(2, '0');
  if (s >= 3600) return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

// Пишем в DOM только если значение поменялось: пакеты идут 10 раз в секунду
function text(el, value) {
  const v = String(value ?? '');
  if (el.textContent !== v) el.textContent = v;
}
function html(el, value) {
  if (el._html !== value) { el.innerHTML = value; el._html = value; }
}
function setSide(el, side) {
  el.classList.toggle('is-ct', side === 'CT');
  el.classList.toggle('is-t', side === 'T');
}
function setLogo(el, url) {
  const v = url ? `url("${new URL(url, location.href).href.replace(/"/g, '%22')}")` : '';
  if (el.style.backgroundImage !== v) el.style.backgroundImage = v;
  el.style.display = url ? '' : 'none';
}

const teamName = key => (key === 'B' ? control.teamB.name || 'Команда B' : control.teamA.name || 'Команда A');
const teamTag = key => {
  const t = key === 'B' ? control.teamB : control.teamA;
  return t.tag || t.name || key;
};
const winsNeeded = format => ({ bo1: 1, bo2: 2, bo3: 2, bo5: 3 }[format] ?? 2);

// Сколько секунд осталось с поправкой на время с прихода пакета
function liveLeft(value) {
  if (value === null || value === undefined) return null;
  return Math.max(0, value - (performance.now() - gameAt) / 1000);
}

/* ----------------------------------------------------------- сцены */

const SCENES = {
  starting: 'sceneStarting',
  break: 'sceneBreak',
  bracket: 'sceneBracket',
  veto: 'sceneVeto',
  results: 'sceneResults',
  scoreboard: 'sceneScoreboard'
};

function render() {
  if (!control) return;
  const scene = control.scene;

  const gameVisible = scene === 'auto' && control.showHud;
  $('layerGame').hidden = !gameVisible;
  for (const [key, id] of Object.entries(SCENES)) $(id).hidden = scene !== key;

  document.body.classList.toggle('has-ticker', gameVisible && !!control.ticker);
  $('nodata').hidden = !(gameVisible && !game?.live);

  if (gameVisible) renderGame();
  if (scene === 'starting') renderStarting();
  if (scene === 'break') renderBreak();
  if (scene === 'bracket') renderBracket();
  if (scene === 'veto') renderVeto();
  if (scene === 'results') renderResults();
  if (scene === 'scoreboard') renderScoreboard();

  renderBackgrounds();
  renderTrivia();
  tick();
}

/* ======================================================= ИГРОВОЙ СЛОЙ */

function renderGame() {
  const p = control.panels || {};
  const g = game && game.live ? game : null;

  renderBoard(g);

  // Игроки
  // Пока открыта большая таблица игроков, карточки по углам дублируют её и мешают — прячем
  const showPlayers = !!g && p.players !== false && !p.stats;
  $('colA').hidden = !showPlayers;
  $('colB').hidden = !showPlayers;
  if (showPlayers) {
    fillColumn($('colA'), g.a.players, 'a');
    fillColumn($('colB'), g.b.players, 'b');
  }

  // Экономика — только в закупку
  const showEcon = !!g && p.economy !== false && !p.stats && g.roundPhase === 'freezetime' && g.phase !== 'warmup';
  $('econA').hidden = !showEcon;
  $('econB').hidden = !showEcon;
  if (showEcon) {
    renderEcon($('econA'), g.a);
    renderEcon($('econB'), g.b);
  }

  // Игрок в камере
  const observed = g && g.observed ? [...g.a.players, ...g.b.players].find(x => x.steamid === g.observed) : null;
  const showFocus = !!observed && p.observed !== false && !p.stats;
  $('focus').hidden = !showFocus;
  if (showFocus) renderFocus(observed);

  // История раундов поверх игры
  const showHistory = !!g && !!p.rounds;
  $('historyFloat').hidden = !showHistory;
  if (showHistory) html($('historyFloat'), historyHtml(g, false));

  // Таблица игроков поверх игры
  const showStats = !!g && !!p.stats;
  $('statsFloat').hidden = !showStats;
  if (showStats) html($('statsFloat'), statsTeam(g, 'A', g.a) + statsTeam(g, 'B', g.b));

  // Лента убийств
  const showFeed = !!g && !!p.killfeed && !p.stats;
  $('feed').hidden = !showFeed;
  if (showFeed) renderFeed(g.killfeed || []);

  // Событие под табло (итог раунда, тайм-аут…). История раундов, если включена, важнее.
  renderEvent(g, showHistory);

  // Комментаторы
  const cs = control.casters || {};
  $('casters').hidden = !cs.show;
  if (cs.show) {
    text($('castersTopic'), cs.topic || '');
    $('castersTopic').hidden = !cs.topic;
    text($('casterLeft'), cs.left || '');
    text($('casterRight'), cs.right || '');
    $('castersSep').hidden = !(cs.left && cs.right);
  }

  // Бегущая строка
  $('ticker').hidden = !control.ticker;
  text($('tickerText'), control.ticker || '');
}

/* ----------------------------------------------------------- табло */

function renderBoard(g) {
  const aSide = g ? g.a.side : (control.sides?.aStart === 'T' ? 'T' : 'CT');
  const bSide = aSide === 'CT' ? 'T' : 'CT';
  setSide($('boardA'), aSide);
  setSide($('boardB'), bSide);
  text($('sideA'), aSide);
  text($('sideB'), bSide);

  text($('nameA'), teamName('A'));
  text($('nameB'), teamName('B'));
  setLogo($('logoA'), control.teamA.logo);
  setLogo($('logoB'), control.teamB.logo);
  text($('scoreA'), g ? g.a.score : 0);
  text($('scoreB'), g ? g.b.score : 0);

  const need = winsNeeded(control.series.format);
  html($('seriesA'), chips(need, control.series.aWins));
  html($('seriesB'), chips(need, control.series.bWins));

  const mapPart = g ? [g.map.label || mapLabel(g.map.name), g.phase === 'warmup' ? 'разминка' : g.half].filter(Boolean).join(' · ') : '';
  const parts = [control.tournament, control.stage, mapPart].filter(Boolean);
  $('subbar').hidden = !parts.length;
  html($('subbar'), parts.map(x => `<span>${esc(x)}</span>`).join('<i></i>'));

  text($('roundLabel'), !g ? 'Ожидание' : g.phase === 'warmup' ? 'Разминка' : g.phase === 'gameover' ? 'Карта завершена' : `Раунд ${g.round}`);
}

function chips(total, won) {
  let s = '';
  for (let i = 0; i < total; i++) s += `<span class="series__chip ${i < won ? 'series__chip--won' : ''}"></span>`;
  return s;
}

/* ----------------------------------------------------------- карточки игроков */

function buildCard() {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="card__trail"></div>
    <div class="card__fill"></div>
    <div class="card__slot"></div>
    <div class="card__hp"></div>
    <div class="card__name"><span class="card__nick"></span><span class="card__rk"></span></div>
    <div class="card__money"></div>
    <div class="card__gear">
      <span class="card__armor"></span>
      <span class="card__weapon"></span>
      <span class="card__nades"></span>
      <span class="card__items"></span>
    </div>
    <div class="card__kd"></div>
    <div class="card__flash"></div>`;
  const q = s => el.querySelector(s);
  el._ = {
    trail: q('.card__trail'), fill: q('.card__fill'), slot: q('.card__slot'), hp: q('.card__hp'),
    nick: q('.card__nick'), rk: q('.card__rk'), money: q('.card__money'), armor: q('.card__armor'),
    weapon: q('.card__weapon'), nades: q('.card__nades'), items: q('.card__items'), kd: q('.card__kd'),
    flash: q('.card__flash')
  };
  return el;
}

function fillColumn(col, players, key) {
  // Пять карточек создаём один раз и потом только обновляем —
  // иначе плавные полосы здоровья и анимации сбрасывались бы 10 раз в секунду.
  while (col.children.length < 5) col.appendChild(buildCard());
  for (let i = 0; i < 5; i++) {
    const card = col.children[i];
    const pl = players[i];
    card.hidden = !pl;
    if (pl) fillCard(card, pl);
  }
}

function fillCard(card, p) {
  const r = card._;
  setSide(card, p.side);
  card.classList.toggle('is-dead', !p.alive);
  card.classList.toggle('is-observed', p.observed);

  const share = Math.max(0, Math.min(100, p.hp)) / 100;
  const scale = `scaleX(${share})`;
  if (r.fill.style.transform !== scale) { r.fill.style.transform = scale; r.trail.style.transform = scale; }
  r.flash.style.opacity = p.alive ? Math.min(0.75, (p.flashed || 0) / 255 * 0.8).toFixed(2) : 0;

  text(r.slot, p.slot ?? '');
  html(r.hp, p.alive ? String(p.hp) : icon('skull'));
  r.hp.classList.toggle('is-low', p.alive && p.hp <= 25);
  text(r.nick, p.name);
  html(r.rk, p.roundKills > 0 ? icon('skull').repeat(Math.min(5, p.roundKills)) : '');
  text(r.money, money(p.money));

  if (p.alive) {
    html(r.armor, p.armor > 0 ? icon(p.helmet ? 'helmet' : 'armor') : icon('armor'));
    r.armor.classList.toggle('is-none', p.armor <= 0);
    r.armor.hidden = false;
    text(r.weapon, p.weapon);
    html(r.nades, p.grenades.map(n => icon(n)).join(''));
    html(r.items, (p.hasBomb ? icon('bomb', 'card__item card__item--bomb') : '') + (p.defusekit ? icon('kit', 'card__item card__item--kit') : '') + (p.taser ? icon('zeus', 'card__item') : ''));
  } else {
    r.armor.hidden = true;
    text(r.weapon, p.roundDmg ? `урон за раунд ${p.roundDmg}` : '');
    html(r.nades, '');
    html(r.items, '');
  }
  html(r.kd, `<b>${p.kills}</b> / <b>${p.deaths}</b>${p.adr ? ` · ADR <b>${p.adr}</b>` : ''}`);
}

/* ----------------------------------------------------------- экономика */

function renderEcon(el, team) {
  setSide(el, team.side);
  html(el, `
    <div class="econ__buy"><b>${esc(team.buy || '—')}</b><span>${team.side}</span></div>
    <div class="econ__cell"><div class="econ__label">Деньги</div><div class="econ__value econ__value--money">${money(team.money)}</div></div>
    <div class="econ__cell"><div class="econ__label">Экипировка</div><div class="econ__value">${money(team.equip)}</div></div>
    <div class="econ__cell"><div class="econ__label">При поражении</div><div class="econ__value">${money(team.lossBonus)}</div></div>`);
}

/* ----------------------------------------------------------- игрок в камере */

function renderFocus(p) {
  const el = $('focus');
  setSide(el, p.side);
  text($('fSlot'), p.slot ?? '');
  text($('fName'), p.name);
  text($('fTeam'), teamName(p.team));
  text($('fK'), p.kills);
  text($('fA'), p.assists);
  text($('fD'), p.deaths);
  text($('fAdr'), p.adr ?? '—');
  text($('fHs'), p.hsPct === null ? '—' : p.hsPct + '%');
  text($('fHp'), p.hp);
  $('fHp').parentElement.classList.toggle('is-low', p.hp <= 25);
  text($('fArmor'), p.armor);
  $('fArmorWrap').classList.toggle('is-none', p.armor <= 0);
  $('fArmorIcon').setAttribute('href', p.helmet ? '#i-helmet' : '#i-armor');

  const a = p.active;
  text($('fWeapon'), a ? a.label : p.weapon || '—');
  const ammo = a && a.clipMax ? `<em>${a.clip ?? 0}</em> / ${a.reserve ?? 0}` : '';
  html($('fAmmo'), ammo);

  html($('fGear'), p.grenades.map(n => icon(n)).join('') +
    (p.hasBomb ? icon('bomb', 'card__item--bomb') : '') +
    (p.defusekit ? icon('kit', 'card__item--kit') : '') +
    (p.taser ? icon('zeus') : ''));
  text($('fMoney'), money(p.money));
  $('fHpFill').style.width = Math.max(0, Math.min(100, p.hp)) + '%';
}

/* ----------------------------------------------------------- событие под табло */

const REASON_ICON = { kill: 'skull', bomb: 'bomb', defuse: 'defuse', time: 'time' };

function renderEvent(g, blocked) {
  const el = $('event');
  let title = '', sub = '', side = null, mode = '', bar = null;

  if (g && !blocked) {
    const b = g.bomb || {};
    if (b.state === 'defusing' && b.defuser) {
      title = `${b.defuser} разминирует`;
      sub = b.defuseTotal === 5 ? 'с набором сапёра' : 'без набора сапёра';
      side = 'CT';
      bar = 'defuse';
    } else if (b.state === 'planting' && b.planter) {
      title = `${b.planter} закладывает бомбу`;
      sub = '';
      side = 'T';
    } else if (g.result && (control.panels?.roundResult !== false)) {
      title = teamName(g.result.team);
      sub = `выигрывает раунд ${g.result.round}${g.result.reason ? ' · ' + g.result.reason : ''}`;
      side = g.result.side;
    } else if (g.timeoutTeam) {
      title = 'Тактический тайм-аут';
      sub = teamName(g.timeoutTeam);
      mode = 'event--neutral';
    } else if (g.phase === 'paused') {
      title = 'Техническая пауза';
      sub = 'игра скоро продолжится';
      mode = 'event--neutral';
    } else if (g.phase === 'gameover') {
      const a = g.a.score, bb = g.b.score;
      title = a === bb ? 'Карта завершена' : `Победа: ${teamName(a > bb ? 'A' : 'B')}`;
      sub = `${g.map.label} · ${a} : ${bb}`;
      mode = 'event--neutral';
    }
  }

  el.hidden = !title;
  if (!title) return;
  el.className = `event ${mode}`;
  if (side) el.classList.add(sideClass(side));
  text($('eventTitle'), title);
  text($('eventSub'), sub);
  $('eventSub').hidden = !sub;
  $('eventBar').hidden = bar !== 'defuse';
  el.dataset.bar = bar || '';
}

/* ----------------------------------------------------------- история раундов */

function historyHtml(g, wide) {
  const rounds = g.rounds || [];
  const total = rounds.length;
  const cell = (r, team) => {
    if (r.winner !== team) return `<div class="hr ${r.round === g.round ? 'is-current' : ''}"></div>`;
    return `<div class="hr ${sideClass(r.side)}">${icon(REASON_ICON[r.kind] || 'skull')}</div>`;
  };
  const row = team => {
    let s = `<div class="hr-team">${esc((team === 'A' ? control.teamA.tag : control.teamB.tag) || team)}</div>`;
    for (let i = 0; i < total; i++) {
      const r = rounds[i];
      if (i === 12 || (i >= 24 && (i - 24) % 3 === 0)) s += '<div class="hr-split"></div>';
      s += cell(r, team);
    }
    return `<div class="history">${s}</div>`;
  };
  return `<div style="display:flex;flex-direction:column;gap:3px">${row('A')}${row('B')}</div>`;
}

/* ----------------------------------------------------------- таблица игроков */

function statsTeam(g, key, team) {
  const rows = team.players.map(p => {
    const diff = p.kills - p.deaths;
    return `
      <div class="st-row ${p.alive ? '' : 'is-dead'}">
        <div class="st-slot">${p.slot ?? ''}</div>
        <div class="st-name">${esc(p.name)}</div>
        <div>${p.kills}</div>
        <div>${p.assists}</div>
        <div>${p.deaths}</div>
        <div class="${diff > 0 ? 'st-pos' : diff < 0 ? 'st-neg' : ''}">${diff > 0 ? '+' : ''}${diff}</div>
        <div class="st-adr">${p.adr ?? '—'}</div>
        <div>${p.hsPct === null ? '—' : p.hsPct + '%'}</div>
        <div>${p.mvps}</div>
        <div class="st-money">${money(p.money)}</div>
      </div>`;
  }).join('');
  return `
    <div class="st-team ${sideClass(team.side)}">
      <div class="st-team__head"><span class="st-team__name">${esc(teamName(key))}</span><span class="side-pill">${team.side}</span><span class="st-team__score">${team.score}</span></div>
      <div class="st-cols"><span>#</span><span>Игрок</span><span>K</span><span>A</span><span>D</span><span>+/−</span><span>ADR</span><span>HS</span><span>MVP</span><span>Деньги</span></div>
      ${rows}
    </div>`;
}

/* ----------------------------------------------------------- лента убийств */

function renderFeed(list) {
  const now = Date.now();
  const fresh = list.filter(k => now - k.at < 9000).slice(-5);
  const key = fresh.map(k => k.id).join('|');
  const el = $('feed');
  if (el._key !== key) {
    el._key = key;
    el.innerHTML = fresh.map(k => {
      const killer = k.killer ? `<span class="${sideClass(k.killer.side)}">${esc(k.killer.name)}</span>` : '';
      const assist = k.assist ? `<span class="kill__assist ${sideClass(k.assist.side)}">+ ${esc(k.assist.name)}</span>` : '';
      const weapon = k.weapon ? `<span class="kill__weapon">${esc(k.weapon)}</span>` : icon('skull');
      return `<div class="kill ${k.killer ? '' : 'kill--world'}" data-at="${k.at}">${killer}${assist}${weapon}${k.headshot ? icon('hs', 'kill__hs') : ''}<span class="kill__victim ${sideClass(k.victim.side)}">${esc(k.victim.name)}</span></div>`;
    }).join('');
  }
}

/* ======================================================= ЗАСТАВКИ */

function seriesMaps() {
  return (control.series.maps || []).filter(m => m && m.map);
}

function miniMaps() {
  const live = game?.live ? game.map.name : null;
  return seriesMaps().map(m => {
    const done = !!m.winner;
    const current = !done && live && m.map === live;
    const info = done
      ? `<b>${esc(teamName(m.winner))}</b> · ${m.scoreA ?? '?'}:${m.scoreB ?? '?'}`
      : current ? 'идёт сейчас' : m.pick === 'decider' ? 'десайдер' : `пик ${esc(teamName(m.pick))}`;
    return `<div class="mini-map ${done ? 'is-done' : ''} ${current ? 'is-current' : ''}"><div class="mini-map__name">${esc(mapLabel(m.map))}</div><div class="mini-map__info">${info}</div></div>`;
  }).join('');
}

function renderStarting() {
  const s = control.starting || {};
  text($('startEyebrow'), control.tournament || '');
  text($('startTitle'), s.title || 'Трансляция скоро начнётся');
  text($('startSub'), s.subtitle || '');
  $('startSub').hidden = !s.subtitle;
  text($('vsA'), teamName('A'));
  text($('vsB'), teamName('B'));
  setLogo($('vsLogoA'), control.teamA.logo);
  setLogo($('vsLogoB'), control.teamB.logo);
  const maps = seriesMaps().map(m => mapLabel(m.map));
  text($('startFormat'), [control.stage, control.series.format.toUpperCase(), maps.join(' · ')].filter(Boolean).join('   /   '));
}

function renderBreak() {
  text($('breakEyebrow'), [control.tournament, control.stage].filter(Boolean).join(' · '));
  text($('breakTitle'), control.breakText || 'Технический перерыв');
  html($('breakSeries'), miniMaps());
}

function renderBracket() {
  const b = control.bracket || {};
  text($('bracketTitle'), b.title || 'Турнирная сетка');
  const rounds = Array.isArray(b.rounds) ? b.rounds : [];
  html($('bracket'), rounds.length ? rounds.map(round => `
    <div class="round">
      <div class="round__name">${esc(round.name || '')}</div>
      <div class="round__matches">
        ${(round.matches || []).map(m => `<div class="match">${matchRow(m.a)}${matchRow(m.b)}</div>`).join('')}
      </div>
    </div>`).join('') : '<div class="bracket__empty">Сетка ещё не заполнена — вставьте её на пульте</div>');
}

function matchRow(side) {
  if (!side) return '<div class="match__row"><span>—</span><span class="match__score"></span></div>';
  return `<div class="match__row ${side.won ? 'match__row--won' : ''}"><span>${esc(side.name || '—')}</span><span class="match__score">${side.score ?? ''}</span></div>`;
}

function renderVeto() {
  text($('vetoEyebrow'), [control.tournament, control.series.format.toUpperCase()].filter(Boolean).join(' · '));
  text($('vetoTitle'), `${teamName('A')}  vs  ${teamName('B')}`);
  const live = game?.live ? game.map.name : null;
  const maps = seriesMaps();
  html($('veto'), maps.map((m, i) => {
    const done = !!m.winner;
    const current = !done && live && m.map === live;
    const pick = m.pick === 'decider' ? 'Десайдер' : `Пик · ${esc(teamName(m.pick))}`;
    const badge = done ? '<span class="vmap__badge">Сыграна</span>' : current ? '<span class="vmap__badge vmap__badge--live">Идёт</span>' : '';
    const winA = m.winner === 'A', winB = m.winner === 'B';
    const score = done ? `
      <div class="vmap__score">
        <span class="vmap__team ${winA ? 'is-win' : ''}">${esc(teamTag('A'))}</span>
        <span class="vmap__nums"><span class="${winA ? 'is-win' : ''}">${m.scoreA ?? '–'}</span> : <span class="${winB ? 'is-win' : ''}">${m.scoreB ?? '–'}</span></span>
        <span class="vmap__team ${winB ? 'is-win' : ''}" style="text-align:right">${esc(teamTag('B'))}</span>
      </div>` : current && game ? `
      <div class="vmap__score">
        <span class="vmap__team">${esc(teamTag('A'))}</span>
        <span class="vmap__nums">${game.a.score} : ${game.b.score}</span>
        <span class="vmap__team" style="text-align:right">${esc(teamTag('B'))}</span>
      </div>` : '';
    return `
      <div class="vmap ${done ? 'vmap--done' : current ? 'vmap--live' : 'vmap--tbd'}" data-map="${esc(m.map)}"
           style="background-image:url('/assets/maps/${encodeURIComponent(m.map)}.jpg');animation-delay:${i * 90}ms">
        <span class="vmap__num">${String(i + 1).padStart(2, '0')}</span>
        ${badge}
        <div class="vmap__pick">${pick}</div>
        <div class="vmap__name">${esc(mapLabel(m.map))}</div>
        ${score}
      </div>`;
  }).join(''));
}

function renderResults() {
  const r = control.results || {};
  const winner = r.winner === 'B' ? 'B' : 'A';
  // Карта для итога: последняя отмеченная сыгранной, иначе та, что идёт в игре
  const played = seriesMaps().filter(m => m.winner);
  const last = played[played.length - 1];
  let mapName = last?.map || game?.map?.name || '';
  let sa = last ? last.scoreA : game?.a?.score;
  let sb = last ? last.scoreB : game?.b?.score;
  text($('resultEyebrow'), mapName ? `Победа на карте ${mapLabel(mapName)}` : 'Победа на карте');
  text($('resultWinner'), teamName(winner));
  setLogo($('resultLogo'), winner === 'A' ? control.teamA.logo : control.teamB.logo);
  html($('resultMap'), sa !== undefined && sa !== null ? `<span>Счёт карты</span>${sa} : ${sb}` : '');
  html($('resultSeries'), miniMaps());
  text($('resultNote'), r.note || `Серия ${control.series.aWins} : ${control.series.bWins}`);
}

function renderScoreboard() {
  const g = game && game.live ? game : null;
  text($('sbNameA'), teamName('A'));
  text($('sbNameB'), teamName('B'));
  text($('sbScoreA'), g ? g.a.score : 0);
  text($('sbScoreB'), g ? g.b.score : 0);
  setSide($('sbScoreA').parentElement, g?.a.side);
  setSide($('sbScoreB').parentElement, g?.b.side);
  text($('sbMap'), g ? g.map.label : 'Нет данных из игры');
  text($('sbRound'), g ? (g.phase === 'gameover' ? 'Карта завершена' : `Раунд ${g.round} · ${g.half}`) : '');
  html($('historyWide'), g ? historyHtml(g, true) : '');
  html($('sbBody'), g ? statsTeam(g, 'A', g.a) + statsTeam(g, 'B', g.b) : '');
}

/* ----------------------------------------------------------- фоны сцен */

function renderBackgrounds() {
  const all = control.backgrounds || {};
  for (const [scene, id] of Object.entries(SCENES)) {
    const el = $(id);
    const bg = all[scene] || {};
    const url = (bg.image || '').trim();
    el.classList.toggle('has-bg', !!url);
    el.classList.toggle('bg-only', !!url && !!bg.hideContent);
    const abs = url ? new URL(url, location.href).href.replace(/"/g, '%22') : '';
    // Фон-видео (MP4/WebM) — общий фон из пульта Dota: играет под содержимым сцены.
    const isVideo = /\.(mp4|webm)(\?|#|$)/i.test(url);
    el.classList.toggle('has-video', isVideo);
    el.style.setProperty('--scene-bg', abs && !isVideo ? `url("${abs}")` : 'none');
    let video = el.querySelector(':scope > .scene-video');
    if (isVideo && scene === control.scene) {
      if (!video) {
        video = document.createElement('video');
        video.className = 'scene-video';
        video.muted = true; video.loop = true; video.playsInline = true; video.autoplay = true;
        el.prepend(video);
      }
      if (video.dataset.src !== abs) { video.dataset.src = abs; video.src = abs; }
      video.play().catch(() => {});
    } else if (video) {
      video.pause(); video.remove();
    }
  }
}

function renderTrivia() {
  const t = control.trivia || {};
  $('trivia').hidden = !t.show;
  if (!t.show) return;
  text($('triviaTitle'), t.title || '');
  $('triviaTitle').hidden = !t.title;
  text($('triviaText'), t.text || '');
}

/* ======================================================= ТАЙМЕРЫ (каждый кадр) */

function tick() {
  if (!control) return;

  // Таймер «Матч скоро начнётся»
  const cd = control.countdown || {};
  const big = $('startCountdown');
  const widget = $('countdown');
  if (!cd.show || !cd.to) {
    big.hidden = true; widget.hidden = true;
  } else {
    const left = Math.max(0, Math.floor((new Date(cd.to).getTime() - Date.now()) / 1000));
    const label = left > 0 ? clock(left) : (cd.doneText || '0:00');
    const onStarting = control.scene === 'starting' && !control.backgrounds?.starting?.hideContent;
    big.hidden = !onStarting;
    widget.hidden = onStarting;
    text(big, label);
    text($('countdownTime'), label);
    text($('countdownLabel'), cd.label || 'Матч скоро начнётся');
    widget.classList.toggle('cd--done', left === 0);
    widget.dataset.pos = cd.position || 'top-right';
  }

  // Часы раунда и бомба
  if ($('layerGame').hidden) return;
  const g = game && game.live ? game : null;
  const center = $('boardCenter');
  const b = g?.bomb || {};
  const bombOn = !!g && (b.state === 'planted' || b.state === 'defusing') && b.explodeLeft !== null;
  center.classList.toggle('is-bomb', bombOn);
  $('bombClock').hidden = !bombOn;
  $('clock').hidden = bombOn;

  const fill = $('bombFill');
  if (bombOn) {
    const left = liveLeft(b.explodeLeft);
    text($('bombTime'), left < 10 ? left.toFixed(1) : Math.ceil(left));
    fill.style.width = (left / (b.explodeTotal || 40) * 100) + '%';
  } else if (g && g.timeLeft !== null && !['warmup', 'gameover'].includes(g.phase)) {
    const left = liveLeft(g.timeLeft);
    const c = $('clock');
    text(c, clock(left));
    c.classList.toggle('is-low', g.phase === 'live' && left <= 10);
    c.classList.toggle('is-freeze', g.roundPhase === 'freezetime');
    const total = g.roundPhase === 'freezetime' ? 20 : 115;
    fill.style.width = g.phase === 'live' || g.roundPhase === 'freezetime' ? Math.min(100, left / total * 100) + '%' : '0%';
  } else {
    const c = $('clock');
    text(c, g?.phase === 'warmup' ? '—' : g?.phase === 'gameover' ? 'GG' : '—');
    c.classList.remove('is-low', 'is-freeze');
    fill.style.width = '0%';
  }

  // Полоса разминирования
  if ($('event').dataset.bar === 'defuse' && b.defuseLeft !== null && b.defuseTotal) {
    const left = liveLeft(b.defuseLeft);
    $('eventFill').style.width = Math.max(0, 100 - left / b.defuseTotal * 100) + '%';
  }

  // Старые записи ленты убийств гаснут
  const now = Date.now();
  for (const k of $('feed').children) k.classList.toggle('is-old', now - Number(k.dataset.at) > 7000);
}

(function loop() {
  try { tick(); } catch (e) { console.error(e); }
  requestAnimationFrame(loop);
})();

// Лента убийств должна обновляться и без новых пакетов
setInterval(() => { if (control && game && control.panels?.killfeed) renderFeed(game.killfeed || []); }, 1000);
