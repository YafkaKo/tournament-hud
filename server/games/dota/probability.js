/**
 * Оценка вероятности победы по данным GSI.
 *
 * ЧЕСТНО: это эвристика, а не официальное предсказание Dota Plus и не модель,
 * обученная на матчах. Коэффициенты подобраны вручную из здравого смысла
 * и лежат в config/probability.json — их можно подкручивать прямо во время
 * репетиции, сервер перечитывает файл сам. В эфире плашка подписана как «оценка».
 *
 * Модель логистическая:
 *     z = bias + Σ (вес · признак / затухание по времени) + вес_строений · разница_строений
 *     P(Radiant) = 1 / (1 + e^(−z)),  результат зажимается в [clamp.min, clamp.max]
 *
 * Затухание по времени: преимущество в 5k золота на 10-й минуте значит больше,
 * чем те же 5k на 45-й, поэтому разницу делим на (1 + минуты / timeScaleMin).
 */

const STATE_PRE = 'DOTA_GAMERULES_STATE_PRE_GAME';
const STATE_GAME = 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS';
const STATE_POST = 'DOTA_GAMERULES_STATE_POST_GAME';

const DEFAULT_MODEL = {
  bias: 0,
  minMinutes: 1,
  netWorth:   { weight: 0.18, per: 1000, timeScaleMin: 20 },
  experience: { weight: 0.10, per: 1000, timeScaleMin: 20 },
  buildings:  { weight: 0.12, towerValue: 1, barracksValue: 2 },
  kills:      { weight: 0.03, timeScaleMin: 20 },
  clamp:      { min: 3, max: 97 }
};

function computeProbability(snapshot, modelInput) {
  const model = mergeModel(modelInput);
  const map = snapshot && snapshot.map;
  if (!map) return null;

  const state = map.game_state;
  const clock = Number(map.clock_time) || 0;

  // До горна у команд нет разницы — честные 50 на 50.
  if (state === STATE_PRE || (state === STATE_GAME && clock < 0)) {
    return result(50, clock, 0, {}, { xp: null, buildings: false }, model);
  }
  if (state !== STATE_GAME && state !== STATE_POST) return null;

  const rad = teamStats(snapshot, 'team2', clock);
  const dire = teamStats(snapshot, 'team3', clock);
  if (!rad.count || !dire.count) return null;

  const minutes = Math.max(clock / 60, model.minMinutes);
  const terms = {};
  let z = model.bias;

  // 1. Золото
  {
    const m = model.netWorth;
    const diff = rad.netWorth - dire.netWorth;
    const value = m.weight * (diff / m.per) / (1 + minutes / m.timeScaleMin);
    terms.netWorth = { diff, z: round(value, 3) };
    z += value;
  }

  // 2. Опыт. Суммарного опыта героя в GSI может не быть — тогда считаем по XPM.
  if (rad.xp !== null && dire.xp !== null) {
    const m = model.experience;
    const diff = rad.xp - dire.xp;
    const value = m.weight * (diff / m.per) / (1 + minutes / m.timeScaleMin);
    terms.experience = { diff: Math.round(diff), z: round(value, 3), source: rad.xpSource };
    z += value;
  }

  // 3. Строения. Учитываем, только если пришли данные по обеим сторонам.
  const bld = buildingsBalance(snapshot.buildings, model.buildings);
  if (bld) {
    const value = model.buildings.weight * bld.diff;
    terms.buildings = { radiant: bld.radiant, dire: bld.dire, diff: bld.diff, z: round(value, 3) };
    z += value;
  }

  // 4. Киллы — слабый признак, золото и так их учитывает.
  {
    const m = model.kills;
    const diff = (Number(map.radiant_score) || 0) - (Number(map.dire_score) || 0);
    const value = m.weight * diff / (1 + minutes / m.timeScaleMin);
    terms.kills = { diff, z: round(value, 3) };
    z += value;
  }

  const pct = 100 / (1 + Math.exp(-z));
  return result(pct, clock, z, terms, { xp: terms.experience ? rad.xpSource : null, buildings: !!bld }, model);
}

function result(pct, clock, z, terms, sources, model) {
  const clamped = Math.min(model.clamp.max, Math.max(model.clamp.min, pct));
  return {
    radiant: round(clamped, 1),
    dire: round(100 - clamped, 1),
    clock,
    z: round(z, 3),
    terms,
    sources
  };
}

/** Золото и опыт команды. clock — игровые секунды, нужен для оценки опыта по XPM. */
function teamStats(snapshot, team, clock) {
  const players = (snapshot.player && snapshot.player[team]) || {};
  const heroes = (snapshot.hero && snapshot.hero[team]) || {};
  const slots = Object.keys(players);

  let netWorth = 0;
  let xpFromHero = 0;
  let xpFromXpm = 0;
  let heroXpOk = slots.length > 0;
  let xpmOk = slots.length > 0;

  for (const slot of slots) {
    const p = players[slot] || {};
    const h = heroes[slot] || {};
    netWorth += Number(p.net_worth) || 0;

    if (typeof h.xp === 'number') xpFromHero += h.xp; else heroXpOk = false;
    if (typeof p.xpm === 'number') xpFromXpm += p.xpm * Math.max(clock, 0) / 60; else xpmOk = false;
  }

  let xp = null;
  let xpSource = null;
  if (heroXpOk) { xp = xpFromHero; xpSource = 'hero.xp'; }
  else if (xpmOk) { xp = xpFromXpm; xpSource = 'xpm'; }

  return { count: slots.length, netWorth, xp, xpSource };
}

/**
 * Баланс живых строений. У наблюдателя блок buildings приходит по обеим
 * сторонам: { radiant: { dota_goodguys_tower1_top: { health, max_health } }, dire: {...} }.
 * Разрушенное строение либо пропадает из списка, либо приходит с health = 0.
 * Стартовые наборы у сторон одинаковые, поэтому разница живых = разница потерь.
 */
function buildingsBalance(buildings, cfg) {
  if (!buildings) return null;
  const rad = buildings.radiant;
  const dire = buildings.dire;
  if (!isFilled(rad) || !isFilled(dire)) return null;

  const score = (side) => {
    let total = 0;
    for (const [name, b] of Object.entries(side)) {
      if (!b || !(Number(b.health) > 0)) continue;
      if (name.includes('tower')) total += cfg.towerValue;
      else if (name.includes('rax')) total += cfg.barracksValue;
    }
    return total;
  };

  const r = score(rad);
  const d = score(dire);
  return { radiant: r, dire: d, diff: r - d };
}

function mergeModel(input) {
  const out = JSON.parse(JSON.stringify(DEFAULT_MODEL));
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith('_')) continue;
    if (value && typeof value === 'object' && out[key] && typeof out[key] === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (!k.startsWith('_') && typeof v === 'number') out[key][k] = v;
      }
    } else if (typeof value === 'number') {
      out[key] = value;
    }
  }
  return out;
}

function isFilled(obj) {
  return obj && typeof obj === 'object' && Object.keys(obj).length > 0;
}

function round(n, digits) {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

module.exports = { computeProbability, DEFAULT_MODEL };
