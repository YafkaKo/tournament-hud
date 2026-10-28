/**
 * Работа со снимком матча: склейка пакетов GSI и сборка итогов карты.
 *
 * Главное правило: неполный пакет никогда не затирает полный.
 * Dota 2 присылает урезанные пакеты в нескольких ситуациях:
 *   — после выхода наблюдателя из матча (в главное меню) идут только provider и auth;
 *   — на границах стадий (драфт → игра → итоги) отдельные блоки на время пропадают;
 *   — heartbeat раз в N секунд, если ничего не менялось.
 * Поэтому каждый блок (map, player, hero, items...) обновляется, только если
 * в новом пакете он есть и не пустой.
 */

const BLOCKS = ['provider', 'map', 'player', 'hero', 'abilities', 'items', 'draft', 'buildings', 'league', 'couriers', 'neutralitems', 'roshan', 'minimap'];
const TEAM_BLOCKS = ['player', 'hero', 'abilities', 'items'];

const EARLY_STATES = new Set([
  'DOTA_GAMERULES_STATE_INIT',
  'DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD',
  'DOTA_GAMERULES_STATE_CUSTOM_GAME_SETUP',
  'DOTA_GAMERULES_STATE_PLAYER_DRAFT',
  'DOTA_GAMERULES_STATE_HERO_SELECTION',
  'DOTA_GAMERULES_STATE_STRATEGY_TIME',
  'DOTA_GAMERULES_STATE_TEAM_SHOWCASE',
  'DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD',
  'DOTA_GAMERULES_STATE_PRE_GAME'
]);

/** Есть ли в пакете хоть что-то про сам матч. Пакет без map — это heartbeat из меню. */
function hasMatchData(body) {
  return isFilled(body && body.map) && typeof body.map.game_state === 'string';
}

/** matchid из пакета; '0' и пустая строка — «ещё не назначен». */
function matchIdOf(body) {
  const id = body && body.map && body.map.matchid;
  if (id === undefined || id === null) return null;
  const s = String(id);
  return s === '' || s === '0' ? null : s;
}

function isEarlyState(state) {
  return EARLY_STATES.has(state);
}

/** Карта закончена: стадия итогов или игра уже объявила победителя. */
function isFinished(map) {
  if (!map) return false;
  return map.game_state === 'DOTA_GAMERULES_STATE_POST_GAME' ||
         map.win_team === 'radiant' || map.win_team === 'dire';
}

/** Склеивает новый пакет с предыдущим снимком. prev не мутируется. */
function mergeSnapshot(prev, body) {
  const out = { ...(prev || {}) };

  for (const key of BLOCKS) {
    const incoming = body[key];
    if (!isFilled(incoming)) continue;

    if (TEAM_BLOCKS.includes(key)) {
      // Сторона обновляется целиком, но только если по ней пришёл хоть один игрок.
      const merged = { ...(out[key] || {}) };
      for (const team of ['team2', 'team3']) {
        if (isFilled(incoming[team])) merged[team] = incoming[team];
      }
      // Игрок (не наблюдатель) получает данные без деления на команды.
      if (!incoming.team2 && !incoming.team3) Object.assign(merged, incoming);
      out[key] = merged;
    } else if (key === 'map') {
      // map склеиваем по полям: если какое-то поле пропало — держим старое значение.
      out.map = { ...(out.map || {}), ...incoming };
    } else {
      out[key] = incoming;
    }
  }
  return out;
}

/** Игроки стороны в порядке слотов. team: 'team2' | 'team3' */
function teamPlayers(snapshot, team) {
  const players = (snapshot.player && snapshot.player[team]) || {};
  const heroes = (snapshot.hero && snapshot.hero[team]) || {};
  const items = (snapshot.items && snapshot.items[team]) || {};

  return Object.keys(players)
    .sort((a, b) => slotNumber(a) - slotNumber(b))
    .map((slot) => ({ slot, player: players[slot] || {}, hero: heroes[slot] || {}, items: items[slot] || {} }));
}

function slotNumber(key) {
  return Number(String(key).replace(/\D/g, '')) || 0;
}

/**
 * Итоги карты из снимка. provisional = true — карта ещё идёт
 * (оператор вручную показал плашку до конца игры).
 */
function buildResults(snapshot, { matchId, provisional }) {
  const map = (snapshot && snapshot.map) || {};
  const winTeam = map.win_team === 'radiant' || map.win_team === 'dire' ? map.win_team : null;

  const side = (team) => teamPlayers(snapshot || {}, team).map(({ slot, player, hero, items }) => ({
    slot,
    name: player.name || null,
    steamid: player.steamid || null,
    heroId: num(hero.id),
    hero: hero.name || null,
    level: num(hero.level),
    kills: num(player.kills),
    deaths: num(player.deaths),
    assists: num(player.assists),
    netWorth: num(player.net_worth),
    gpm: num(player.gpm),
    xpm: num(player.xpm),
    lastHits: num(player.last_hits),
    denies: num(player.denies),
    // Эти три поля в GSI наблюдателя есть не всегда — при отсутствии
    // их догружает OpenDota (см. opendota.js).
    heroDamage: num(player.hero_damage),
    towerDamage: num(player.tower_damage),
    heroHealing: num(player.hero_healing),
    items: itemList(items)
  }));

  return {
    matchId: matchId || null,
    provisional: !!provisional,
    winner: winTeam,
    radiantScore: num(map.radiant_score) ?? 0,
    direScore: num(map.dire_score) ?? 0,
    duration: Math.max(0, num(map.clock_time) ?? 0),
    frozenAt: provisional ? null : new Date().toISOString(),
    sources: { gsi: true, opendota: false },
    players: { radiant: side('team2'), dire: side('team3') }
  };
}

function itemList(items) {
  const out = [];
  for (let i = 0; i < 6; i++) out.push(itemName(items[`slot${i}`]));
  out.push(itemName(items.neutral0));
  return out;
}

function itemName(item) {
  const name = item && item.name;
  return name && name !== 'empty' ? name : null;
}

function num(v) {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
}

function isFilled(obj) {
  return !!obj && typeof obj === 'object' && Object.keys(obj).length > 0;
}

module.exports = {
  hasMatchData, matchIdOf, isEarlyState, isFinished,
  mergeSnapshot, buildResults, teamPlayers, isFilled
};
