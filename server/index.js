/**
 * Сервер трансляции для Dota 2 и CS2.
 *
 *  Dota 2 / кастомка Arena 5x5 / CS2  --HTTP POST-->  /gsi  (игра определяется по пакету)
 *                                                        |
 *                     games/dota  ·  games/cs2  — у каждой игры своя картина матча
 *                                                        |
 *  overlay.html (OBS), control.html, /control (телефон)  <--WebSocket--  рассылка
 *  агент хоткеев, Stream Deck                            --HTTP-->       /api/action/...
 *
 * Обе игры принимают данные всегда, а в эфир идёт та, что выбрана на пульте.
 * Наружу ходит только запрос в OpenDota после окончания карты Dota (можно выключить
 * в config/server.json). Всё остальное работает в локальной сети.
 */

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const { State, GAMES } = require('./core/state');
const { Hub } = require('./core/hub');
const { buildActions } = require('./core/actions');
const { backgroundRoutes } = require('./core/backgrounds');
const { createAds } = require('./core/ads');
const { createPickFx } = require('./core/pickfx');
const { mergeDeep, readJson, lanAddresses } = require('./core/util');
const { createDota } = require('./games/dota');
const { createCs2 } = require('./games/cs2');

const ROOT = path.join(__dirname, '..');
const CONFIG = loadConfig();
const PORT = CONFIG.port;

function loadConfig() {
  const fallback = {
    port: 3000,
    token: 'arena-hud',
    requireToken: true,
    results: { autoShow: true },
    comparison: { minAgeSec: 300, autoSnapshotEverySec: 0 },
    opendota: { enabled: true },
    gsiLog: { enabled: false, onlyDraft: true, compact: true },
    ads: { maxUploadMb: 1024 }
  };
  return mergeDeep(fallback, readJson(path.join(ROOT, 'config', 'server.json')) || {});
}

// ---------------------------------------------------------------- состояние и модули

const state = new State(ROOT);
const app = express();
const server = http.createServer(app);
const hub = new Hub(server);

const ctx = {
  root: ROOT,
  config: CONFIG,
  hub,
  state,
  view: (game) => state.view(game),
  /** Изменение состояния из модуля игры (в форме этой игры). */
  patch: (game, partial) => change(() => state.patch(game, partial)),
  emitPick: (pick) => pickFx.emit(pick),
  onGameEvent: () => scheduleHud()
};

const games = { dota: createDota(ctx), cs2: createCs2(ctx) };
const ads = createAds({ root: ROOT, config: CONFIG, state, hub, change, onUpdate: () => scheduleHud() });
const pickFx = createPickFx({ state, hub, change });
const actions = buildActions({ state, change, games, ads, pickFx });

let changing = false;
/**
 * Единственная точка изменения состояния: после неё модули игр узнают
 * об изменениях, а все страницы получают свежее состояние.
 */
function change(fn) {
  if (changing) { fn(); return; }        // вложенный вызов — разошлём один раз в конце
  changing = true;
  const prevDota = state.view('dota');
  try {
    fn();
  } finally {
    changing = false;
  }
  state.save();
  games.dota.afterChange(prevDota, state.view('dota'));
  games.cs2.afterChange();
  pushControl();
  pushHud();
}

function pushControl() {
  for (const ws of hub.clients((c) => c.game)) hub.send(ws, 'control', state.view(ws.game));
}

/** Короткая сводка для общих страниц: какая игра в эфире, пауза, реклама, плашки. */
function hudData() {
  const s = state.s;
  const active = games[s.game];
  return {
    game: s.game,
    scene: s.shared.scene,
    teams: s.shared.teams,
    series: { format: s.shared.series.format, aWins: s.shared.series.aWins, bWins: s.shared.series.bWins },
    radiantIs: s.dota.radiantIs,
    showHud: s.shared.showHud,
    casters: !!s.shared.casters.show,
    trivia: { show: !!s.shared.trivia.show, title: s.shared.trivia.title, count: (s.shared.triviaLibrary || []).length, index: s.shared.triviaIndex },
    countdown: { show: !!s.shared.countdown.show, to: s.shared.countdown.to },
    dota: { panels: s.dota.panels, probability: !!s.dota.probability.show, mapResults: !!s.dota.mapResults.show },
    cs2: { panels: s.cs2.panels },
    games: Object.fromEntries(GAMES.map((g) => [g, { label: games[g].label, alive: games[g].alive(), summary: games[g].summary() }])),
    paused: !!(active && active.paused()),
    ads: ads.publicState(),
    // Подпись списка роликов: изменилась — пульты перечитывают /api/ads
    adsSig: crypto.createHash('md5').update(JSON.stringify(s.ads)).digest('hex').slice(0, 10),
    pickFx: s.pickFx
  };
}

let hudTimer = null;
let lastHudJson = '';
function scheduleHud() {
  if (hudTimer) return;
  hudTimer = setTimeout(() => { hudTimer = null; pushHud(); }, 100);
}
function pushHud(force) {
  const data = hudData();
  const json = JSON.stringify(data);
  if (!force && json === lastHudJson) return;
  lastHudJson = json;
  hub.broadcast('hud', data);
}

/** Для какой игры запрос: заголовок X-Hud-Game, ?game=…, иначе — игра в эфире. */
function gameOf(req) {
  const g = String(req.get('x-hud-game') || req.query.game || '').toLowerCase();
  return GAMES.includes(g) ? g : state.game;
}

// ---------------------------------------------------------------- HTTP

app.use(express.json({ limit: '5mb' }));

// Пульт для телефона — отдельная простая страница.
app.get(['/control', '/control/'], (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'caster.html'));
});

app.use(express.static(path.join(ROOT, 'public')));

// Игры шлют состояние сюда. Путь совпадает с "uri" в конфигах GSI.
// Открыть его в браузере нельзя: браузер делает GET, а сюда приходит только POST.
app.post(['/gsi', '/', '/gsi/dota', '/gsi/cs2'], (req, res) => {
  const body = req.body || {};
  if (CONFIG.requireToken) {
    const token = body.auth && body.auth.token;
    if (token !== CONFIG.token) {
      console.warn('[gsi] отклонён пакет с токеном:', token);
      return res.status(403).end();
    }
  }
  res.status(200).end();

  let target = null;
  if (req.path === '/gsi/dota') target = games.dota;
  else if (req.path === '/gsi/cs2') target = games.cs2;
  else target = games.cs2.accepts(body) ? games.cs2 : games.dota.accepts(body) ? games.dota : null;
  if (!target) return;
  target.ingest(body);
});

app.get('/api/state', (req, res) => {
  const game = gameOf(req);
  res.json({ ...games[game].state(), forGame: game, control: state.view(game) });
});

app.get('/api/hud', (req, res) => res.json(hudData()));

app.post('/api/control', (req, res) => {
  const game = gameOf(req);
  change(() => state.patch(game, req.body || {}));
  res.json(state.view(game));
});

app.post('/api/control/reset', (req, res) => {
  const game = gameOf(req);
  change(() => state.resetGame(game));
  if (game === 'cs2') games.cs2.resetAll();
  res.json(state.view(game));
});

app.post('/api/game', (req, res) => {
  const game = String((req.body && req.body.game) || req.query.game || '');
  if (!GAMES.includes(game)) return res.status(400).json({ error: 'Игра: dota или cs2' });
  change(() => state.setGame(game));
  console.log(`[game] в эфире ${games[game].label}`);
  res.json({ game });
});

// Переключатели из пульта Dota и агента хоткеев (старый формат).
const TOGGLES = { probability: 'toggle-probability', mapResults: 'toggle-mapResults', trivia: 'toggle-trivia', casters: 'toggle-casters' };
app.post('/api/toggle/:key', (req, res) => {
  const key = req.params.key;
  const name = TOGGLES[key];
  if (!name) return res.status(404).json({ error: `Нет переключателя «${key}». Есть: ${Object.keys(TOGGLES).join(', ')}` });
  const v = state.view('dota');
  const current = key === 'probability' ? v.probability.show : key === 'mapResults' ? v.mapResults.show : v[key].show;
  const show = typeof req.body?.show === 'boolean' ? req.body.show : !current;
  if (show !== current) actions.run(name);
  res.json({ key, show });
});

// Быстрые действия — для хоткеев, агента и Stream Deck.
app.all('/api/action/:name', (req, res) => {
  const out = actions.run(req.params.name);
  if (out === null) return res.status(404).json({ error: 'Неизвестное действие', actions: actions.list(gameOf(req)).map(a => a.name) });
  if (out.error) return res.status(409).json({ ok: false, ...out });
  res.json({ ok: true, game: state.game, scene: state.s.shared.scene, ...out });
});

app.get('/api/actions', (req, res) => {
  const all = req.query.all === '1';
  res.json(actions.list(all ? null : gameOf(req)));
});

backgroundRoutes(app, express, { root: ROOT, state, change });
games.dota.routes(app, express);
games.cs2.routes(app, express);
ads.routes(app, express);
pickFx.routes(app);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    game: state.game,
    dota: games.dota.health(),
    cs2: games.cs2.health(),
    ads: ads.publicState(),
    clients: hub.size,
    // Поля для совместимости со старым /api/health Доты
    gsiConnected: games[state.game].alive(),
    warning: games.dota.status().warning
  });
});

// ---------------------------------------------------------------- WebSocket

hub.onConnect = (ws) => {
  // Новому клиенту сразу отдаём полную картину, чтобы он не ждал следующего пакета из игры.
  if (ws.game) {
    hub.send(ws, 'control', state.view(ws.game));
    games[ws.game].onConnect(ws);
    hub.send(ws, 'status', games[ws.game].status());
  }
  hub.send(ws, 'hud', hudData());
  ads.onConnect(ws);
};

hub.onMessage = (ws, msg) => ads.onMessage(ws, msg);

// Раз в 2 секунды: идут ли данные из игры и нет ли конфликта источников.
setInterval(() => {
  for (const g of GAMES) hub.broadcast('status', games[g].status(), g);
  pushHud();
}, 2000);

// ---------------------------------------------------------------- ошибки и запуск

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: req.path.startsWith('/api/backgrounds') ? 'Файл больше 20 МБ' : 'Слишком большой файл' });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Не разобрал данные запроса' });
  next(err);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Порт ${PORT} занят. Скорее всего, сервер уже запущен в другом окне`);
    console.error('  (или ещё открыт старый HUD CS2/Dota). Закройте его или поменяйте "port" в config/server.json.\n');
    process.exit(1);
  }
  throw err;
});

process.on('SIGINT', () => { state.flush(); process.exit(0); });

server.listen(PORT, () => {
  games.dota.start();
  games.cs2.start();

  const lan = lanAddresses();
  console.log('');
  console.log('  Сервер трансляции запущен (Dota 2 + CS2)');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  В эфире сейчас       ${games[state.game].label}`);
  console.log(`  Оверлей для OBS      http://localhost:${PORT}/overlay.html?obs=1`);
  console.log(`  Пульт оператора      http://localhost:${PORT}/control.html`);
  console.log(`  Пульт для телефона   http://localhost:${PORT}/control`);
  console.log(`  Приём GSI            http://localhost:${PORT}/gsi   (Dota и CS2, только POST из игры)`);
  for (const ip of lan) {
    console.log(`  С других ПК в сети   http://${ip}:${PORT}/control`);
  }
  console.log('');
  console.log('  Не закрывайте это окно во время эфира.');
  console.log('');
});
