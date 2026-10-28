/**
 * Общее состояние трансляции для обеих игр — data/control.json.
 *
 *   game     — какая игра сейчас в эфире: 'dota' | 'cs2'
 *   shared   — всё общее: сцена, турнир, команды A и B, серия, тексты, фоны, сетка
 *   dota     — только для Dota 2: какая команда за Radiant, плашки, вероятность, итоги
 *   cs2      — только для CS2: стартовая сторона, плашки
 *   ads      — реклама (список роликов и переходов, очередь)
 *   pickFx   — анимация пика героя
 *
 * Страницы каждой игры (оверлей, пульт) работают со «своей» формой состояния —
 * той же, что была у отдельных HUD-ов. Её собирают view(game), а изменения
 * из неё раскладывает обратно patch(game, partial). Поэтому старые страницы
 * Dota и CS2 почти не менялись, а названия команд и счёт серии хранятся один раз.
 */

const fs = require('fs');
const path = require('path');
const { mergeDeep, readJson, writeJson } = require('./util');

const VERSION = 2;
const GAMES = ['dota', 'cs2'];
const SCENES = ['auto', 'starting', 'break', 'bracket', 'results', 'scoreboard', 'veto', 'blank'];
const BG_KEYS = ['starting', 'break', 'bracket', 'results', 'scoreboard', 'mapResults', 'draft', 'veto'];
const CS2_BG_SCENES = ['starting', 'break', 'bracket', 'veto', 'results', 'scoreboard'];

function defaults() {
  return {
    version: VERSION,
    game: 'dota',
    shared: {
      scene: 'auto',
      tournament: 'Кубок киберспортивной арены ЮРГПУ (НПИ)',
      stage: 'Групповой этап',
      teams: {
        A: { name: 'Команда A', tag: 'A', logo: '' },
        B: { name: 'Команда B', tag: 'B', logo: '' }
      },
      series: {
        format: 'bo3',
        aWins: 0,
        bWins: 0,
        // Карты серии (для CS2: сцена «Пики карт»). pick: A | B | decider; winner: A | B | ''
        maps: [
          { map: 'de_mirage', pick: 'A', winner: '', scoreA: null, scoreB: null },
          { map: 'de_inferno', pick: 'B', winner: '', scoreA: null, scoreB: null },
          { map: 'de_nuke', pick: 'decider', winner: '', scoreA: null, scoreB: null }
        ]
      },
      casters: { show: false, left: '', right: '', topic: 'Комментируют' },
      starting: { title: 'Трансляция скоро начнётся', subtitle: '' },
      breakText: 'Технический перерыв',
      // Таймер «скоро начнётся». В Dota — на заставке «Скоро начнём»,
      // в CS2 — ещё и плашкой поверх любой сцены.
      countdown: { show: false, label: 'Матч скоро начнётся', to: null, doneText: 'Начинаем!', position: 'top-right' },
      // «Только фон»: заставка без текста — остаётся один фон сцены.
      bgOnly: { starting: false, break: false, results: false },
      results: { winner: 'A', note: '' },
      bracket: { title: 'Турнирная сетка', rounds: [] },
      ticker: '',
      showHud: true,
      trivia: { show: false, title: '', text: '' },
      triviaLibrary: [],          // заготовки фактов: [{ title, text }]
      triviaIndex: -1,            // какой факт показан последним (для «следующий факт»)
      // Фон полноэкранных сцен: картинка или видео. scenes.<сцена> важнее all. dim — затемнение 0–80 %.
      background: {
        all: '',
        scenes: Object.fromEntries(BG_KEYS.map(k => [k, ''])),
        dim: 40
      }
    },
    dota: {
      radiantIs: 'A',             // какая команда (A или B) играет за Radiant
      panels: { networth: true, objectives: true, rosters: false },
      probability: { show: false },
      mapResults: { show: false }
    },
    cs2: {
      sides: { aStart: 'CT' },    // за какую сторону команда A начинает карту
      panels: {
        players: true, observed: true, economy: true, roundResult: true,
        killfeed: false, rounds: false, stats: false
      }
    },
    ads: {
      defaultTransition: '',      // id перехода по умолчанию
      transitions: [],            // [{ id, file, name, cutMs, volume }]
      clips: [],                  // [{ id, file, name, duration, poster, transition, volume }]
      queue: [],                  // id роликов в очереди
      between: 'transition'       // между роликами очереди: transition | cut
    },
    pickFx: { enabled: true, volume: 80, voice: true }
  };
}

class State {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'data', 'control.json');
    this.s = this.load();
    this.saveTimer = null;
  }

  // ---------------------------------------------------------------- загрузка и перенос

  load() {
    const raw = readJson(this.file);
    if (raw && raw.version === VERSION) return mergeDeep(defaults(), raw);

    // Старый формат (до объединения) или файла нет: переносим, что есть.
    const out = defaults();
    const backupDir = path.join(this.root, 'data', 'backup');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (raw) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(this.file, path.join(backupDir, `control-dota-${stamp}.json`));
      migrateDota(out, raw);
      console.log(`[state] перенёс data/control.json Dota в новый формат (копия в data/backup)`);
    }

    // Состояние CS2-HUD: положите его control.json как data/cs2-control.json —
    // при первом запуске возьмём оттуда стороны, плашки, карты серии и таймер.
    const cs2File = path.join(this.root, 'data', 'cs2-control.json');
    const cs2 = readJson(cs2File);
    if (cs2) {
      migrateCs2(out, cs2, !raw);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(cs2File, path.join(backupDir, `control-cs2-${stamp}.json`));
      console.log('[state] перенёс data/cs2-control.json (копия в data/backup)');
    }

    writeJson(this.file, out);
    return out;
  }

  // ---------------------------------------------------------------- сохранение

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => writeJson(this.file, this.s), 150);
  }

  flush() {
    clearTimeout(this.saveTimer);
    writeJson(this.file, this.s);
  }

  get game() { return this.s.game; }

  setGame(game) {
    if (!GAMES.includes(game)) return false;
    this.s.game = game;
    // Пики карт есть только в CS2 — в Доте вернёмся к игре.
    if (game === 'dota' && this.s.shared.scene === 'veto') this.s.shared.scene = 'auto';
    this.save();
    return true;
  }

  /** Прямое изменение общего состояния (без форм отдельных игр). */
  merge(partial) {
    this.s = mergeDeep(this.s, partial);
    this.save();
  }

  resetGame(game) {
    const d = defaults();
    this.s.shared = d.shared;
    if (game === 'dota') this.s.dota = d.dota;
    if (game === 'cs2') this.s.cs2 = d.cs2;
    this.save();
  }

  // ---------------------------------------------------------------- формы для страниц игр

  view(game) {
    return game === 'cs2' ? cs2View(this.s) : dotaView(this.s);
  }

  patch(game, partial) {
    if (game === 'cs2') cs2Patch(this.s, partial || {});
    else dotaPatch(this.s, partial || {});
    this.save();
  }
}

// ==================================================================== Dota

function radiantKey(s) { return s.dota.radiantIs === 'B' ? 'B' : 'A'; }
function other(k) { return k === 'A' ? 'B' : 'A'; }
function winsKey(k) { return k === 'A' ? 'aWins' : 'bWins'; }

function dotaView(s) {
  const sh = s.shared;
  const rad = radiantKey(s);
  const dire = other(rad);
  const cd = sh.countdown || {};
  return {
    game: s.game,
    scene: sh.scene === 'veto' ? 'auto' : sh.scene,
    tournament: sh.tournament,
    stage: sh.stage,
    radiant: { ...sh.teams[rad] },
    dire: { ...sh.teams[dire] },
    series: { format: sh.series.format, radiantWins: sh.series[winsKey(rad)], direWins: sh.series[winsKey(dire)] },
    casters: sh.casters,
    starting: { title: sh.starting.title, subtitle: sh.starting.subtitle, countdownTo: cd.show && cd.to ? cd.to : null },
    breakText: sh.breakText,
    bgOnly: { starting: !!sh.bgOnly.starting, break: !!sh.bgOnly.break },
    results: { show: false, winner: sh.results.winner === dire ? 'dire' : 'radiant', note: sh.results.note },
    bracket: sh.bracket,
    ticker: sh.ticker,
    showHud: sh.showHud,
    panels: s.dota.panels,
    trivia: sh.trivia,
    background: sh.background,
    triviaLibrary: sh.triviaLibrary,
    probability: s.dota.probability,
    mapResults: s.dota.mapResults
  };
}

const DOTA_SHARED = ['tournament', 'stage', 'casters', 'breakText', 'bracket', 'ticker', 'showHud', 'trivia', 'background', 'triviaLibrary', 'bgOnly'];

function dotaPatch(s, p) {
  const sh = s.shared;
  const rad = radiantKey(s);
  const dire = other(rad);

  // «Команды поменялись сторонами»: пульт присылает radiant и dire наоборот.
  // Названия остаются за командами A и B — меняется только, кто за Radiant.
  if (p.radiant && p.dire && sameTeam(p.radiant, sh.teams[dire]) && sameTeam(p.dire, sh.teams[rad])) {
    s.dota.radiantIs = dire;
    delete p.radiant; delete p.dire;
    if (p.series) { delete p.series.radiantWins; delete p.series.direWins; }
  }

  if (typeof p.scene === 'string' && SCENES.includes(p.scene)) sh.scene = p.scene;
  for (const key of DOTA_SHARED) {
    if (p[key] !== undefined) sh[key] = mergeValue(sh[key], p[key]);
  }
  if (p.radiant) sh.teams[rad] = mergeDeep(sh.teams[rad], p.radiant);
  if (p.dire) sh.teams[dire] = mergeDeep(sh.teams[dire], p.dire);
  if (p.series) {
    if (p.series.format) sh.series.format = p.series.format;
    if (Number.isFinite(p.series.radiantWins)) sh.series[winsKey(rad)] = Math.max(0, p.series.radiantWins);
    if (Number.isFinite(p.series.direWins)) sh.series[winsKey(dire)] = Math.max(0, p.series.direWins);
  }
  if (p.starting) {
    if (p.starting.title !== undefined) sh.starting.title = p.starting.title;
    if (p.starting.subtitle !== undefined) sh.starting.subtitle = p.starting.subtitle;
    if ('countdownTo' in p.starting) {
      const to = p.starting.countdownTo;
      sh.countdown = { ...sh.countdown, to: to || null, show: !!to };
    }
  }
  if (p.results) {
    if (p.results.winner) sh.results.winner = p.results.winner === 'dire' ? dire : rad;
    if (p.results.note !== undefined) sh.results.note = p.results.note;
  }
  if (p.panels) s.dota.panels = mergeDeep(s.dota.panels, p.panels);
  if (p.probability) s.dota.probability = mergeDeep(s.dota.probability, p.probability);
  if (p.mapResults) s.dota.mapResults = mergeDeep(s.dota.mapResults, p.mapResults);
}

function sameTeam(a, b) {
  return a && b && (a.name || '') === (b.name || '') && (a.logo || '') === (b.logo || '') && (a.tag || '') === (b.tag || '');
}

// ==================================================================== CS2

function bgImage(sh, key) {
  const url = (sh.background.scenes && sh.background.scenes[key]) || sh.background.all || '';
  return url;
}

function cs2View(s) {
  const sh = s.shared;
  const backgrounds = {};
  for (const k of CS2_BG_SCENES) {
    backgrounds[k] = { image: bgImage(sh, k), hideContent: !!sh.bgOnly[k] };
  }
  return {
    game: s.game,
    scene: sh.scene,
    tournament: sh.tournament,
    stage: sh.stage,
    teamA: { ...sh.teams.A },
    teamB: { ...sh.teams.B },
    sides: s.cs2.sides,
    series: sh.series,
    casters: sh.casters,
    starting: { title: sh.starting.title, subtitle: sh.starting.subtitle },
    breakText: sh.breakText,
    countdown: sh.countdown,
    backgrounds,
    backgroundDim: sh.background.dim,
    results: sh.results,
    bracket: sh.bracket,
    ticker: sh.ticker,
    showHud: sh.showHud,
    panels: s.cs2.panels,
    trivia: { ...sh.trivia, list: libraryToText(sh.triviaLibrary), index: sh.triviaIndex }
  };
}

const CS2_SHARED = ['tournament', 'stage', 'casters', 'breakText', 'bracket', 'ticker', 'showHud', 'countdown', 'results'];

function cs2Patch(s, p) {
  const sh = s.shared;
  if (typeof p.scene === 'string' && SCENES.includes(p.scene)) sh.scene = p.scene;
  for (const key of CS2_SHARED) {
    if (p[key] !== undefined) sh[key] = mergeValue(sh[key], p[key]);
  }
  if (p.teamA) sh.teams.A = mergeDeep(sh.teams.A, p.teamA);
  if (p.teamB) sh.teams.B = mergeDeep(sh.teams.B, p.teamB);
  if (p.series) sh.series = mergeDeep(sh.series, p.series);
  if (p.starting) sh.starting = mergeDeep(sh.starting, pick(p.starting, ['title', 'subtitle']));
  if (p.sides) s.cs2.sides = mergeDeep(s.cs2.sides, p.sides);
  if (p.panels) s.cs2.panels = mergeDeep(s.cs2.panels, p.panels);
  if (p.backgrounds) {
    for (const [k, v] of Object.entries(p.backgrounds)) {
      if (!CS2_BG_SCENES.includes(k) || !v) continue;
      if (v.image !== undefined) sh.background.scenes[k] = v.image;
      if (v.hideContent !== undefined) sh.bgOnly[k] = !!v.hideContent;
    }
  }
  if (p.trivia) {
    const t = { ...p.trivia };
    if (t.list !== undefined) { sh.triviaLibrary = textToLibrary(t.list); delete t.list; }
    if (t.index !== undefined) { sh.triviaIndex = Number(t.index); delete t.index; }
    sh.trivia = mergeDeep(sh.trivia, t);
  }
}

function libraryToText(list) {
  return (list || []).map(f => (f.title ? `${f.title} | ${f.text}` : f.text)).join('\n');
}

function textToLibrary(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [title, ...rest] = line.split('|');
    return rest.length ? { title: title.trim(), text: rest.join('|').trim() } : { title: '', text: title.trim() };
  });
}

// ==================================================================== перенос старых файлов

function migrateDota(out, d) {
  const sh = out.shared;
  for (const k of ['tournament', 'stage', 'breakText', 'ticker', 'showHud']) if (d[k] !== undefined) sh[k] = d[k];
  if (d.scene && SCENES.includes(d.scene)) sh.scene = d.scene;
  if (d.radiant) sh.teams.A = { ...sh.teams.A, ...d.radiant };
  if (d.dire) sh.teams.B = { ...sh.teams.B, ...d.dire };
  if (d.series) {
    sh.series.format = d.series.format || sh.series.format;
    sh.series.aWins = Number(d.series.radiantWins) || 0;
    sh.series.bWins = Number(d.series.direWins) || 0;
  }
  if (d.casters) sh.casters = { ...sh.casters, ...d.casters };
  if (d.starting) {
    sh.starting = { title: d.starting.title ?? sh.starting.title, subtitle: d.starting.subtitle ?? '' };
    if (d.starting.countdownTo) sh.countdown = { ...sh.countdown, to: d.starting.countdownTo, show: true };
  }
  if (d.bgOnly) sh.bgOnly = { ...sh.bgOnly, ...d.bgOnly };
  if (d.results) sh.results = { winner: d.results.winner === 'dire' ? 'B' : 'A', note: d.results.note || '' };
  if (d.bracket) sh.bracket = { ...sh.bracket, ...d.bracket };
  if (d.trivia) sh.trivia = { show: !!d.trivia.show, title: d.trivia.title || '', text: d.trivia.text || '' };
  if (Array.isArray(d.triviaLibrary)) sh.triviaLibrary = d.triviaLibrary;
  if (d.background) sh.background = mergeDeep(sh.background, d.background);
  if (d.panels) out.dota.panels = { ...out.dota.panels, ...d.panels };
  if (d.probability) out.dota.probability = { ...out.dota.probability, ...d.probability };
  if (d.mapResults) out.dota.mapResults = { ...out.dota.mapResults, ...d.mapResults };
}

/** onlyCs2 — Dota-состояния не было, тогда CS2 отдаёт и общие поля. */
function migrateCs2(out, c, onlyCs2) {
  const sh = out.shared;
  if (c.sides) out.cs2.sides = { ...out.cs2.sides, ...c.sides };
  if (c.panels) out.cs2.panels = { ...out.cs2.panels, ...c.panels };
  if (c.series && Array.isArray(c.series.maps)) sh.series.maps = c.series.maps;
  if (c.countdown) {
    const to = sh.countdown.to || c.countdown.to || null;
    sh.countdown = { ...sh.countdown, ...c.countdown, to, show: !!to && (sh.countdown.show || !!c.countdown.show) };
  }
  if (c.trivia && c.trivia.list) {
    const have = new Set(sh.triviaLibrary.map(f => f.title + '|' + f.text));
    for (const f of textToLibrary(c.trivia.list)) if (!have.has(f.title + '|' + f.text)) sh.triviaLibrary.push(f);
  }
  const fixUrl = u => (u && !/^(https?:|\/|data:)/i.test(u) ? '/' + u : u || '');
  if (c.backgrounds) {
    for (const [k, v] of Object.entries(c.backgrounds)) {
      if (v && v.image && !sh.background.scenes[k]) sh.background.scenes[k] = fixUrl(v.image);
      if (v && v.hideContent && sh.bgOnly[k] === undefined) sh.bgOnly[k] = true;
    }
  }
  if (onlyCs2) {
    for (const k of ['tournament', 'stage', 'breakText', 'ticker', 'showHud']) if (c[k] !== undefined) sh[k] = c[k];
    if (c.teamA) sh.teams.A = { ...sh.teams.A, ...c.teamA, logo: fixUrl(c.teamA.logo) };
    if (c.teamB) sh.teams.B = { ...sh.teams.B, ...c.teamB, logo: fixUrl(c.teamB.logo) };
    if (c.series) { sh.series.format = c.series.format || sh.series.format; sh.series.aWins = c.series.aWins || 0; sh.series.bWins = c.series.bWins || 0; }
    if (c.casters) sh.casters = { ...sh.casters, ...c.casters };
    if (c.results) sh.results = { ...sh.results, ...c.results };
    if (c.bracket) sh.bracket = { ...sh.bracket, ...c.bracket };
  }
}

function mergeValue(current, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
    return mergeDeep(current, value);
  }
  return value;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = { State, defaults, GAMES, SCENES, textToLibrary, libraryToText };
