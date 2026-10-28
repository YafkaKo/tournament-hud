/**
 * CS2: приём GSI, картина матча (cs2.js), стороны, статистика карты, логотипы и фоны.
 * Логика перенесена из CS2-HUD без изменений; состояние пульта — через ctx.
 */

const fs = require('fs');
const path = require('path');
const { Cs2Match } = require('./cs2');
const { readJson, writeJson } = require('../../core/util');

function createCs2(ctx) {
  const { root, hub } = ctx;

  const MATCH_FILE = path.join(root, 'data', 'cs2-match.json');
  const match = new Cs2Match(readJson(MATCH_FILE));
  let raw = null;             // последний пакет CS2 как есть
  let rawAt = 0;
  let game = null;            // картина матча для оверлея

  // Статистику пишем на диск не чаще раза в 2 секунды: GSI приходит 10 раз в секунду.
  setInterval(() => {
    if (!match.dirty) return;
    match.dirty = false;
    writeJson(MATCH_FILE, match.store);
  }, 2000);

  const control = () => ctx.view('cs2');

  function rebuild() {
    if (!raw) return;
    try {
      game = match.ingest(raw, control());
    } catch (err) {
      console.error('[cs2] не разобрал пакет:', err.stack || err.message);
    }
  }

  function push() {
    if (game) hub.broadcast('game', game, 'cs2');
    ctx.onGameEvent();
  }

  function ingest(body) {
    delete body.auth;
    raw = body;
    rawAt = Date.now();
    const wasPaused = isPaused();
    rebuild();
    if (game) hub.broadcast('game', game, 'cs2');
    if (wasPaused !== isPaused()) ctx.onGameEvent();
  }

  function alive() {
    return raw !== null && Date.now() - rawAt < 15000;
  }

  function isPaused() {
    const ph = game && game.live ? game.phase : '';
    return ph === 'paused' || ph === 'timeout_ct' || ph === 'timeout_t';
  }

  // ---------------------------------------------------------------- HTTP

  const BG_DIR = path.join(root, 'public', 'assets', 'backgrounds');
  const LOGO_DIR = path.join(root, 'public', 'assets', 'logos');
  const BG_SCENES = ['starting', 'break', 'bracket', 'veto', 'results', 'scoreboard'];
  const IMG_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };

  function routes(app, express) {
    // Стороны: перевернуть привязку игроков или начать её заново
    app.post('/api/sides/swap', (req, res) => { swapSides(); res.json({ ok: true }); });

    app.post('/api/sides/reset', (req, res) => {
      match.resetPlayers();
      rebuild(); push();
      res.json({ ok: true });
    });

    app.post('/api/stats/reset', (req, res) => {
      match.resetMapStats();
      rebuild(); push();
      res.json({ ok: true });
    });

    // «Карта сыграна»: счёт из игры, победитель в списке карт, очко серии.
    app.post('/api/map/finish', (req, res) => {
      const body = req.body || {};
      const scoreA = Number.isFinite(body.scoreA) ? body.scoreA : game?.a?.score ?? null;
      const scoreB = Number.isFinite(body.scoreB) ? body.scoreB : game?.b?.score ?? null;
      if (scoreA === null || scoreB === null || scoreA === scoreB) {
        return res.status(400).json({ error: 'Нет счёта карты или ничья — победителя отметьте вручную.' });
      }
      const c = control();
      const winner = scoreA > scoreB ? 'A' : 'B';
      const maps = (c.series.maps || []).map(m => ({ ...m }));
      let idx = maps.findIndex(m => game?.map?.name && m.map === game.map.name && !m.winner);
      if (idx < 0) idx = maps.findIndex(m => !m.winner);
      if (idx >= 0) Object.assign(maps[idx], { winner, scoreA, scoreB });
      ctx.patch('cs2', {
        series: {
          maps,
          aWins: c.series.aWins + (winner === 'A' ? 1 : 0),
          bWins: c.series.bWins + (winner === 'B' ? 1 : 0)
        },
        results: { winner }
      });
      res.json(control());
    });

    // Фон сцены: картинка ложится в public/assets/backgrounds/cs2-<сцена>.<ext>
    app.post('/api/background/:scene', express.raw({ type: 'image/*', limit: '30mb' }), (req, res) => {
      const scene = req.params.scene;
      const ext = IMG_TYPES[(req.headers['content-type'] || '').split(';')[0]];
      if (!BG_SCENES.includes(scene)) return res.status(400).json({ error: 'Неизвестная сцена' });
      if (!ext) return res.status(415).json({ error: 'Нужна картинка: PNG, JPG, WebP, GIF или SVG' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Пустой файл' });
      const name = `cs2-${scene}-${Date.now()}.${ext}`;
      try {
        fs.mkdirSync(BG_DIR, { recursive: true });
        fs.writeFileSync(path.join(BG_DIR, name), req.body);
      } catch (err) {
        console.error('[bg] не удалось сохранить фон:', err.message);
        return res.status(500).json({ error: 'Не удалось сохранить файл' });
      }
      ctx.patch('cs2', { backgrounds: { [scene]: { image: `/assets/backgrounds/${name}` } } });
      res.json(control());
    });

    // Логотип команды: файл ложится в public/assets/logos/. Логотип общий для обеих игр.
    app.post('/api/logo/:team', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
      const team = req.params.team === 'B' ? 'B' : req.params.team === 'A' ? 'A' : null;
      const ext = IMG_TYPES[(req.headers['content-type'] || '').split(';')[0]];
      if (!team) return res.status(400).json({ error: 'Команда A или B' });
      if (!ext) return res.status(415).json({ error: 'Нужна картинка: PNG, JPG, WebP, GIF или SVG' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Пустой файл' });
      const c = control();
      const safe = (c[`team${team}`].name || team).replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40) || team;
      const file = `${safe}-${Date.now()}.${ext}`;
      try {
        fs.mkdirSync(LOGO_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOGO_DIR, file), req.body);
      } catch (err) {
        return res.status(500).json({ error: 'Не удалось сохранить файл' });
      }
      ctx.patch('cs2', { [`team${team}`]: { logo: `/assets/logos/${file}` } });
      res.json(control());
    });
  }

  function swapSides() {
    match.swapSides();
    rebuild(); push();
  }

  return {
    id: 'cs2',
    label: 'CS2',
    accepts(body) {
      const p = body && body.provider;
      return !!p && (Number(p.appid) === 730 || /counter-strike/i.test(p.name || ''));
    },
    ingest,
    routes,
    alive,
    paused: isPaused,
    status: () => ({ gsiConnected: alive(), warning: null }),
    health: () => ({ gsiConnected: alive(), gsiAgeMs: raw ? Date.now() - rawAt : null, map: game?.map?.name || null }),
    summary: () => (game && game.live ? { map: game.map.label, round: game.round, score: `${game.a.score}:${game.b.score}`, paused: isPaused() } : null),
    onConnect(ws) { if (game) hub.send(ws, 'game', game); },
    afterChange() { rebuild(); push(); },
    start() {},
    swapSides,
    resetAll() { match.resetPlayers(); match.resetMapStats(); rebuild(); push(); },
    state: () => ({ game, raw, rawAgeMs: raw ? Date.now() - rawAt : null })
  };
}

module.exports = { createCs2 };
