/**
 * Dota 2: приём GSI, склейка снимка матча, итоги карты, вероятность победы,
 * защита от двух источников данных, OpenDota.
 *
 * Логика перенесена из прежнего server/index.js без изменений — поменялось
 * только то, как модуль читает и меняет состояние пульта (через ctx).
 */

const fs = require('fs');
const path = require('path');

const { MatchState } = require('./match');
const { computeProbability } = require('./probability');
const { OpenDotaEnricher } = require('./opendota');
const { GsiLog } = require('./gsi-log');
const { matchIdOf } = require('./snapshot');

function createDota(ctx) {
  const { root, config, hub } = ctx;

  const match = new MatchState({ file: path.join(root, 'data', 'match.json') });
  let gsiUpdatedAt = 0;          // когда пришёл последний пакет любого вида
  let probability = null;        // последняя посчитанная вероятность (с разбивкой)
  let lastMatchJson = '';

  // Защита от двух источников данных сразу: имитатор + игра, два клиента с разными матчами,
  // кастомка Arena 5x5 + обычный GSI клиента.
  const sources = { realAt: 0, mockAt: 0, customAt: 0, currentIdAt: 0, currentFromMock: false, conflictAt: 0, conflictId: null };
  const gsiLog = new GsiLog(config.gsiLog, root);

  // Пики драфта, о которых уже сообщили (для анимации пика). Ключ — matchid.
  const draftSeen = { matchId: null, keys: new Set(), primed: false };

  // Модель вероятности перечитывается при изменении файла — удобно подбирать коэффициенты.
  const MODEL_FILE = path.join(root, 'config', 'probability.json');
  let model = loadModel();
  fs.watchFile(MODEL_FILE, { interval: 2000 }, () => {
    model = loadModel();
    console.log('[probability] config/probability.json перечитан');
    probability = computeProbability(match.live, model);
    pushMatch();
  });

  function loadModel() {
    try {
      return JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
    } catch (err) {
      if (fs.existsSync(MODEL_FILE)) console.error('[probability] не разобрал config/probability.json:', err.message);
      return {};
    }
  }

  const control = () => ctx.view('dota');

  // ---------------------------------------------------------------- OpenDota

  const opendota = new OpenDotaEnricher(config.opendota);

  function startEnrichment() {
    // Матчи кастомки не попадают в OpenDota, а вся статистика и так приходит из игры.
    if (match.live && match.live.provider && match.live.provider.custom) {
      match.setEnrichment({ state: 'off', message: 'Кастомка Arena 5x5: статистика приходит из игры, OpenDota не нужна' }, null, opendota.constants);
      pushMatch();
      return;
    }
    opendota.start(match.matchId, (status, data) => {
      match.setEnrichment(status, data, opendota.constants);
      pushMatch();
    });
  }

  // ---------------------------------------------------------------- приём пакета

  /** Пакет уже прошёл проверку токена. */
  function ingest(body) {
    delete body.auth;           // токен не рассылаем клиентам
    delete body.previously;     // служебные диффы GSI нам не нужны
    delete body.added;

    const verdict = checkSource(body);
    gsiLog.write(body, verdict);
    if (verdict !== 'accepted') return;

    gsiUpdatedAt = Date.now();
    const result = match.ingest(body);

    if (result.ignored) return;  // heartbeat без данных матча — снимок не трогаем

    if (result.newMatch) {
      opendota.stop();
      if (control().mapResults.show) ctx.patch('dota', { mapResults: { show: false } });
    }

    if (result.froze) {
      if (config.results.autoShow && !control().mapResults.show) ctx.patch('dota', { mapResults: { show: true } });
      startEnrichment();
    }

    probability = computeProbability(match.live, model);
    match.maybeAutoSnapshot(probability, config.comparison.autoSnapshotEverySec);

    hub.broadcast('gsi', match.live, 'dota');
    pushMatch();
    detectPicks(body);
  }

  /**
   * Решает, принимать ли пакет. Возвращает 'accepted' или причину отказа.
   *   — пакеты имитатора игнорируются, пока идут данные из настоящей игры;
   *   — пакет с другим matchid игнорируется, пока текущий матч ещё присылает
   *     данные (значит, это второй клиент, а не новая карта).
   */
  function checkSource(body) {
    const now = Date.now();
    const isMock = !!(body.provider && body.provider.mock);
    // Пока в эфире кастомка Arena 5x5, пакеты обычного клиента Dota игнорируем —
    // иначе они перемешаются с данными кастомки.
    const isCustom = !!(body.provider && body.provider.custom);
    if (isCustom && body.map && body.map.game_state) sources.customAt = now;
    if (!isCustom && !isMock && now - sources.customAt < 10000) return 'ignored: идут данные из кастомки Arena 5x5';

    if (isMock) {
      sources.mockAt = now;
      if (now - sources.realAt < 10000) return 'ignored: имитатор, пока идут данные из игры';
    } else if (body.map && body.map.game_state) {
      // Пакеты из главного меню (без матча) не считаем: с открытой в меню Dota имитатор должен работать.
      sources.realAt = now;
    }

    const id = matchIdOf(body);
    if (id && match.matchId && id === match.matchId) sources.currentIdAt = now;
    const realOverMock = !isMock && sources.currentFromMock;
    if (id && match.matchId && id !== match.matchId && now - sources.currentIdAt < 5000 && !realOverMock) {
      sources.conflictAt = now;
      sources.conflictId = id;
      return `ignored: второй матч ${id}, пока идёт ${match.matchId}`;
    }
    if (id) { sources.currentFromMock = isMock; sources.currentIdAt = now; }
    return 'accepted';
  }

  function sourceWarning() {
    const now = Date.now();
    if (now - sources.mockAt < 10000 && now - sources.realAt < 10000) {
      return 'Одновременно идут данные из игры и из имитатора. Закройте окно start-test-data.bat — данные имитатора сейчас игнорируются.';
    }
    if (now - sources.conflictAt < 10000) {
      return `Данные приходят сразу по двум матчам (${match.matchId} и ${sources.conflictId}). Оставьте один клиент-наблюдатель с этим .cfg.`;
    }
    return null;
  }

  // ---------------------------------------------------------------- пики драфта

  /**
   * Сообщает о новых пиках (для анимации). Не срабатывает на уже готовый драфт:
   * первый пакет матча только запоминает, что уже выбрано. Ключ пика — команда
   * и номер слота, поэтому повторные пакеты и прыжки между источниками
   * (их отсекает checkSource) не дают повторов.
   */
  function detectPicks(body) {
    const id = match.matchId || 'nomatch';
    if (draftSeen.matchId !== id) { draftSeen.matchId = id; draftSeen.keys = new Set(); draftSeen.primed = false; }
    const draft = match.live && match.live.draft;
    const fresh = [];
    if (draft) {
      for (const [teamKey, side] of [['team2', 'radiant'], ['team3', 'dire']]) {
        const team = draft[teamKey] || {};
        for (const key of Object.keys(team)) {
          const m = key.match(/^pick(\d+)_class$/);
          if (!m || !team[key]) continue;
          const sig = `${side}:${m[1]}:${team[key]}`;
          if (draftSeen.keys.has(sig)) continue;
          draftSeen.keys.add(sig);
          fresh.push({ hero: String(team[key]), side, slot: Number(m[1]) });
        }
      }
    }
    // All Pick и другие режимы без драфта: герой появился у игрока.
    if (!draft || !Object.keys(draft).length) {
      for (const [teamKey, side] of [['team2', 'radiant'], ['team3', 'dire']]) {
        const heroes = (match.live && match.live.hero && match.live.hero[teamKey]) || {};
        for (const [pk, h] of Object.entries(heroes)) {
          if (!h || !h.name) continue;
          const sig = `${side}:${pk}:${h.name}`;
          if (draftSeen.keys.has(sig)) continue;
          draftSeen.keys.add(sig);
          fresh.push({ hero: String(h.name), side, slot: Number(String(pk).replace(/\D/g, '')) || 0 });
        }
      }
    }
    if (!draftSeen.primed) { draftSeen.primed = true; return; }   // готовый драфт не анимируем
    const state = match.live && match.live.map && match.live.map.game_state;
    const inDraft = state === 'DOTA_GAMERULES_STATE_HERO_SELECTION' || state === 'DOTA_GAMERULES_STATE_STRATEGY_TIME';
    if (!inDraft) return;
    for (const p of fresh) ctx.emitPick({ game: 'dota', ...p, matchId: id });
  }

  // ---------------------------------------------------------------- состояние для страниц

  function matchView() {
    const map = (match.live && match.live.map) || {};
    const prob = probability
      ? { radiant: Math.round(probability.radiant), dire: 100 - Math.round(probability.radiant) }
      : null;
    return {
      matchId: match.matchId,
      gameState: map.game_state ?? null,
      clock: Number.isFinite(Number(map.clock_time)) ? Number(map.clock_time) : null,
      paused: !!map.paused,
      probability: prob,
      comparison: match.comparison(probability),
      finished: !!match.final,
      results: match.resultsView(),
      enrichment: match.enrichment
    };
  }

  /** Рассылает состояние карты, только если оно изменилось. */
  function pushMatch() {
    const view = matchView();
    const json = JSON.stringify(view);
    if (json === lastMatchJson) return;
    lastMatchJson = json;
    hub.broadcast('match', view, 'dota');
    ctx.onGameEvent();
  }

  function alive() {
    return gsiUpdatedAt > 0 && Date.now() - gsiUpdatedAt < 15000;
  }

  // ---------------------------------------------------------------- HTTP

  function routes(app) {
    app.get('/api/match', (req, res) => {
      res.json({ view: matchView(), probability, snapshots: match.snapshots, comparisonBase: match.comparisonBase });
    });

    // «Сброс матча»: снять итоги, удалить снимки. Команды и счёт серии не трогаем.
    app.post('/api/match/reset', (req, res) => {
      resetMatch();
      res.json({ ok: true });
    });
  }

  function resetMatch() {
    opendota.stop();
    match.reset();
    probability = null;
    ctx.patch('dota', { mapResults: { show: false } });
    hub.broadcast('gsi', match.live, 'dota');
    pushMatch();
  }

  return {
    id: 'dota',
    label: 'Dota 2',
    /** Подходит ли пакет на /gsi этому модулю. */
    accepts(body) {
      const p = body && body.provider;
      if (!p) return !!(body && (body.map && 'game_state' in body.map));
      return !!p.custom || Number(p.appid) === 570 || /dota/i.test(p.name || '');
    },
    ingest,
    routes,
    alive,
    paused: () => !!(match.live && match.live.map && match.live.map.paused),
    status: () => ({ gsiConnected: alive(), warning: sourceWarning() }),
    health: () => ({
      gsiConnected: alive(),
      gsiAgeMs: gsiUpdatedAt ? Date.now() - gsiUpdatedAt : null,
      matchId: match.matchId,
      gameState: match.live?.map?.game_state ?? null,
      resultsFrozen: !!match.final,
      warning: sourceWarning(),
      gsiLog: gsiLog.file ? { file: path.relative(root, gsiLog.file), packets: gsiLog.count } : null
    }),
    summary: () => {
      const v = matchView();
      return v.gameState ? { clock: v.clock, paused: v.paused, state: v.gameState } : null;
    },
    onConnect(ws) {
      if (match.live) hub.send(ws, 'gsi', match.live);
      hub.send(ws, 'match', matchView());
    },
    /** Пульт поменял состояние: ловим включение плашки вероятности. */
    afterChange(prev, next) {
      if (!prev.probability.show && next.probability.show) {
        probability = computeProbability(match.live, model);
        match.onProbabilityEnabled(probability, config.comparison.minAgeSec);
      }
      pushMatch();
    },
    /** Сервер перезапустили, пока ждали OpenDota — продолжаем ждать. */
    start() {
      if (match.final && match.enrichment.state === 'waiting') startEnrichment();
    },
    resetMatch,
    state: () => ({ gsi: match.live, match: matchView(), gsiAge: gsiUpdatedAt ? Date.now() - gsiUpdatedAt : null })
  };
}

module.exports = { createDota };
