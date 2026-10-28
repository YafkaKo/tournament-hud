/**
 * Догрузка итогов карты из OpenDota.
 *
 * Зачем: часть статистики (урон по героям и строениям, лечение) в GSI наблюдателя
 * приходит не всегда, а если сервер перезапускали посреди карты — может не быть
 * и самих игроков. OpenDota отдаёт полную статистику по matchid.
 *
 * Ограничения, о которых надо знать:
 *   — матч появляется в OpenDota с задержкой (от минуты до десятков минут),
 *     поэтому опрашиваем с нарастающими паузами;
 *   — матчи из закрытых лобби могут не появиться там вообще. Это нормально:
 *     плашка итогов показывает то, что дал GSI, и не ждёт OpenDota;
 *   — нужен интернет на ПК с сервером. Без него просто будет статус «нет связи».
 */

class OpenDotaEnricher {
  constructor(config, log = console) {
    this.cfg = {
      enabled: true,
      baseUrl: 'https://api.opendota.com/api',
      apiKey: '',
      requestParse: true,
      timeoutMs: 10000,
      retryDelaysSec: [20, 40, 60, 120, 180, 300, 300, 600, 600],
      ...(config || {})
    };
    this.log = log;
    this.timer = null;
    this.job = null;
    this.constants = { heroes: null, items: null };
  }

  /**
   * Запускает опрос. onUpdate(status, data) вызывается при каждой смене статуса:
   * status = { state: 'waiting' | 'done' | 'failed' | 'off', attempt, maxAttempts, message, nextAt }
   */
  start(matchId, onUpdate) {
    this.stop();
    if (!this.cfg.enabled) {
      onUpdate({ state: 'off', message: 'OpenDota отключена в config/server.json' });
      return;
    }
    if (!matchId) {
      onUpdate({ state: 'failed', message: 'В данных игры нет matchid — догружать нечего' });
      return;
    }
    this.job = { matchId, attempt: 0, onUpdate, parseRequested: false };
    this.schedule(0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.job = null;
  }

  schedule(delaySec, lastError) {
    const job = this.job;
    const max = this.cfg.retryDelaysSec.length + 1;
    let message = 'Запрашиваю OpenDota';
    if (lastError) {
      const reason = lastError.status ? lastError.message : `нет связи с OpenDota (${lastError.message})`;
      message = `Попытка ${job.attempt} из ${max}: ${reason}. Следующая через ${delaySec} с`;
    }
    job.onUpdate({
      state: 'waiting',
      attempt: job.attempt,
      maxAttempts: max,
      nextAt: new Date(Date.now() + delaySec * 1000).toISOString(),
      message
    });
    this.timer = setTimeout(() => this.attempt(job), delaySec * 1000);
  }

  async attempt(job) {
    if (job !== this.job) return;           // матч сменился, пока ждали
    job.attempt += 1;
    const max = this.cfg.retryDelaysSec.length + 1;

    try {
      const data = await this.get(`/matches/${encodeURIComponent(job.matchId)}`);
      if (job !== this.job) return;

      if (data && Array.isArray(data.players) && data.players.length >= 10) {
        await this.loadConstants();
        this.log.log(`[opendota] матч ${job.matchId} получен с попытки ${job.attempt}`);
        job.onUpdate({ state: 'done', attempt: job.attempt, maxAttempts: max, message: 'Данные OpenDota получены' }, data);
        this.job = null;
        return;
      }
      throw new Error('матч ещё не обработан');
    } catch (err) {
      if (job !== this.job) return;

      // Один раз просим OpenDota забрать матч — иначе он может появиться очень нескоро.
      if (this.cfg.requestParse && !job.parseRequested && err.status === 404) {
        job.parseRequested = true;
        this.post(`/request/${encodeURIComponent(job.matchId)}`).catch(() => {});
      }

      const delays = this.cfg.retryDelaysSec;
      if (job.attempt > delays.length) {
        this.log.warn(`[opendota] сдаюсь после ${job.attempt} попыток: ${err.message}`);
        job.onUpdate({
          state: 'failed', attempt: job.attempt, maxAttempts: max,
          message: `OpenDota так и не отдала матч (${err.message}). Показываем данные из игры.`
        });
        this.job = null;
        return;
      }
      this.log.log(`[opendota] попытка ${job.attempt}: ${err.message}`);
      this.schedule(delays[job.attempt - 1], err);
    }
  }

  async loadConstants() {
    try {
      if (!this.constants.heroes) this.constants.heroes = await this.get('/constants/heroes');
      if (!this.constants.items) this.constants.items = await this.get('/constants/item_ids');
    } catch {
      // Без справочников обойдёмся: они нужны только если в GSI вообще не было игроков.
    }
  }

  url(pathname) {
    const u = new URL(this.cfg.baseUrl.replace(/\/$/, '') + pathname);
    if (this.cfg.apiKey) u.searchParams.set('api_key', this.cfg.apiKey);
    return u;
  }

  async get(pathname) {
    const res = await fetch(this.url(pathname), { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    if (!res.ok) {
      const err = new Error(res.status === 404 ? 'матча пока нет (404)' : `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async post(pathname) {
    const res = await fetch(this.url(pathname), { method: 'POST', signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    return res.ok;
  }
}

/**
 * Дополняет итоги данными OpenDota. Уже известные из GSI значения не трогаем —
 * заполняем только пустые поля. Если игроков из GSI не было — собираем их целиком.
 */
function applyOpenDota(results, od, constants = {}) {
  const out = JSON.parse(JSON.stringify(results));
  const odPlayers = Array.isArray(od.players) ? od.players : [];

  for (const team of ['radiant', 'dire']) {
    const isRad = team === 'radiant';
    const odSide = odPlayers.filter((p) => (Number(p.player_slot) < 128) === isRad);

    if (!out.players[team] || out.players[team].length === 0) {
      out.players[team] = odSide.map((p, i) => fromOpenDota(p, i, constants));
      continue;
    }

    out.players[team].forEach((pl, i) => {
      // Сопоставляем по герою, а если его нет — по порядку слота.
      const match = (pl.heroId != null && odSide.find((p) => p.hero_id === pl.heroId)) || odSide[i];
      if (!match) return;
      fill(pl, 'heroDamage', match.hero_damage);
      fill(pl, 'towerDamage', match.tower_damage);
      fill(pl, 'heroHealing', match.hero_healing);
      fill(pl, 'gpm', match.gold_per_min);
      fill(pl, 'xpm', match.xp_per_min);
      fill(pl, 'lastHits', match.last_hits);
      fill(pl, 'denies', match.denies);
      fill(pl, 'netWorth', match.net_worth);
      fill(pl, 'level', match.level);
      fill(pl, 'kills', match.kills);
      fill(pl, 'deaths', match.deaths);
      fill(pl, 'assists', match.assists);
      if (!pl.name && match.personaname) pl.name = match.personaname;
      if (!pl.hero && constants.heroes) pl.hero = heroName(match.hero_id, constants);
    });
  }

  if (!out.winner && typeof od.radiant_win === 'boolean') out.winner = od.radiant_win ? 'radiant' : 'dire';
  if (Number.isFinite(od.duration) && od.duration > 0) out.duration = od.duration;
  if (Number.isFinite(od.radiant_score)) out.radiantScore = od.radiant_score;
  if (Number.isFinite(od.dire_score)) out.direScore = od.dire_score;
  out.sources = { ...out.sources, opendota: true };
  return out;
}

function fromOpenDota(p, i, constants) {
  const items = [0, 1, 2, 3, 4, 5].map((k) => itemName(p[`item_${k}`], constants));
  items.push(itemName(p.item_neutral, constants));
  return {
    slot: `player${i}`,
    name: p.personaname || null,
    steamid: null,
    heroId: p.hero_id ?? null,
    hero: heroName(p.hero_id, constants),
    level: p.level ?? null,
    kills: p.kills ?? null,
    deaths: p.deaths ?? null,
    assists: p.assists ?? null,
    netWorth: p.net_worth ?? null,
    gpm: p.gold_per_min ?? null,
    xpm: p.xp_per_min ?? null,
    lastHits: p.last_hits ?? null,
    denies: p.denies ?? null,
    heroDamage: p.hero_damage ?? null,
    towerDamage: p.tower_damage ?? null,
    heroHealing: p.hero_healing ?? null,
    items
  };
}

function heroName(id, constants) {
  const h = constants.heroes && constants.heroes[String(id)];
  return h ? h.name : null;
}

function itemName(id, constants) {
  if (!id || !constants.items) return null;
  const key = constants.items[String(id)];
  return key ? `item_${key}` : null;
}

function fill(obj, key, value) {
  if ((obj[key] === null || obj[key] === undefined) && value !== null && value !== undefined) obj[key] = value;
}

module.exports = { OpenDotaEnricher, applyOpenDota };
