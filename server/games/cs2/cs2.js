/**
 * Всё, что касается данных CS2.
 *
 * Сырые пакеты GSI неудобны для эфира: в них нет «команды слева» и
 * «команды справа», только стороны CT/T, которые меняются в перерыве и
 * в овертайме. Нет ADR, нет процента хедшотов, нет ленты убийств.
 * Этот модуль превращает сырой пакет в готовую картину матча:
 *
 *   a / b      — левая и правая команды пульта, с текущей стороной
 *   players    — десять игроков с HP, бронёй, деньгами, оружием, гранатами
 *   bomb       — заложена ли, сколько до взрыва, кто разминирует
 *   rounds     — история раундов с победителем и способом победы
 *   killfeed   — лента убийств, восстановленная по разнице пакетов
 *
 * Как определяется, кто за какую сторону.
 * Команда — это не сторона, а пять конкретных людей. При первом пакете
 * каждый steamid привязывается к команде A (слева) или B (справа), исходя
 * из настройки пульта «Команда слева начинает за CT/T». Дальше сторона
 * команды — это сторона, на которой сейчас стоит большинство её игроков.
 * Поэтому смена сторон в перерыве, в овертайме и между картами серии
 * отрабатывается сама, без кнопок. Если всё же ошиблись — кнопка
 * «Поменять стороны» на пульте переворачивает привязку.
 */

const WEAPONS = {
  weapon_knife: 'Нож', weapon_knife_t: 'Нож', weapon_bayonet: 'Нож',
  weapon_c4: 'C4', weapon_taser: 'Zeus',
  // пистолеты
  weapon_glock: 'Glock-18', weapon_hkp2000: 'P2000', weapon_usp_silencer: 'USP-S',
  weapon_p250: 'P250', weapon_elite: 'Dual Berettas', weapon_fiveseven: 'Five-SeveN',
  weapon_tec9: 'Tec-9', weapon_cz75a: 'CZ75', weapon_deagle: 'Desert Eagle',
  weapon_revolver: 'R8',
  // пп
  weapon_mac10: 'MAC-10', weapon_mp9: 'MP9', weapon_mp7: 'MP7', weapon_mp5sd: 'MP5-SD',
  weapon_ump45: 'UMP-45', weapon_p90: 'P90', weapon_bizon: 'PP-Bizon',
  // дробовики и пулемёты
  weapon_nova: 'Nova', weapon_xm1014: 'XM1014', weapon_sawedoff: 'Sawed-Off',
  weapon_mag7: 'MAG-7', weapon_m249: 'M249', weapon_negev: 'Negev',
  // винтовки
  weapon_galilar: 'Galil AR', weapon_famas: 'FAMAS', weapon_ak47: 'AK-47',
  weapon_m4a1: 'M4A4', weapon_m4a1_silencer: 'M4A1-S', weapon_sg556: 'SG 553',
  weapon_aug: 'AUG',
  // снайперки
  weapon_ssg08: 'SSG 08', weapon_awp: 'AWP', weapon_scar20: 'SCAR-20', weapon_g3sg1: 'G3SG1',
  // гранаты
  weapon_hegrenade: 'HE', weapon_flashbang: 'Флешка', weapon_smokegrenade: 'Дым',
  weapon_molotov: 'Молотов', weapon_incgrenade: 'Зажигалка', weapon_decoy: 'Ложная'
};

const PRIMARY_TYPES = ['Rifle', 'SniperRifle', 'Submachine Gun', 'SubmachineGun', 'Shotgun', 'Machine Gun', 'MachineGun'];

const GRENADES = {
  weapon_smokegrenade: 'smoke',
  weapon_flashbang: 'flash',
  weapon_hegrenade: 'he',
  weapon_molotov: 'fire',
  weapon_incgrenade: 'fire',
  weapon_decoy: 'decoy'
};
const GRENADE_ORDER = ['smoke', 'flash', 'he', 'fire', 'decoy'];

const MAPS = {
  de_mirage: 'Mirage', de_inferno: 'Inferno', de_nuke: 'Nuke', de_ancient: 'Ancient',
  de_anubis: 'Anubis', de_dust2: 'Dust II', de_train: 'Train', de_overpass: 'Overpass',
  de_vertigo: 'Vertigo', de_office: 'Office', cs_office: 'Office', cs_italy: 'Italy',
  de_italy: 'Italy'
};

const REASONS = {
  ct_win_elimination: 'уничтожение',
  t_win_elimination: 'уничтожение',
  ct_win_defuse: 'разминирование',
  t_win_bomb: 'взрыв',
  ct_win_time: 'время вышло',
  ct_win_rescue: 'заложники',
  t_win_time: 'время вышло'
};

function weaponLabel(name) {
  if (!name) return '';
  if (WEAPONS[name]) return WEAPONS[name];
  if (name.startsWith('weapon_knife') || name.includes('bayonet')) return 'Нож';
  return name.replace(/^weapon_/, '').toUpperCase();
}

function mapLabel(name) {
  if (!name) return '';
  const short = String(name).split('/').pop();
  return MAPS[short] || short.replace(/^(de|cs|ar)_/, '').replace(/^\w/, c => c.toUpperCase());
}

function flip(side) { return side === 'CT' ? 'T' : 'CT'; }

// Номер «половины» для раунда (нумерация раундов с 1).
// MR12: 1–12, 13–24, затем овертаймы по 6 раундов, половины по 3.
function halfIndex(round) {
  if (round <= 12) return 0;
  if (round <= 24) return 1;
  return 2 + Math.floor((round - 25) / 3);
}

function halfLabel(round) {
  if (round <= 12) return '1-я половина';
  if (round <= 24) return '2-я половина';
  const ot = Math.floor((round - 25) / 6) + 1;
  return `Овертайм ${ot}`;
}

class Cs2Match {
  /**
   * @param store — объект, который сервер сохраняет в data/match.json:
   *   { assign: {steamid: 'A'|'B'}, rounds: {"1": {...}}, dmg: {}, hs: {}, mapName }
   */
  constructor(store) {
    this.store = Object.assign({ assign: {}, rounds: {}, dmg: {}, hs: {}, kills: {}, seen: {}, mapName: '' }, store || {});
    this.dirty = false;
    this.prev = null;           // снимок игроков прошлого пакета — для ленты убийств
    this.prevKey = null;
    this.killfeed = [];
    this.plantedAt = 0;         // когда (по часам сервера) была заложена бомба
    this.plantedLeft = 40;
    this.lastResult = null;
  }

  /* ----------------------------------------------------- управление с пульта */

  swapSides() {
    for (const id of Object.keys(this.store.assign)) {
      this.store.assign[id] = this.store.assign[id] === 'A' ? 'B' : 'A';
    }
    for (const r of Object.values(this.store.rounds)) {
      if (r.winner) r.winner = r.winner === 'A' ? 'B' : 'A';
    }
    this.dirty = true;
  }

  resetPlayers() {
    this.store.assign = {};
    this.dirty = true;
  }

  resetMapStats() {
    this.store.rounds = {};
    this.store.dmg = {};
    this.store.hs = {};
    this.store.kills = {};
    this.store.seen = {};
    this.killfeed = [];
    this.prev = null;
    this.dirty = true;
  }

  /* ----------------------------------------------------- главный вход */

  ingest(gsi, control) {
    const now = Date.now();
    const map = gsi.map || {};
    const all = gsi.allplayers || {};
    const ids = Object.keys(all);

    // Новая карта или рестарт — статистика карты обнуляется,
    // привязка игроков к командам остаётся (это те же люди).
    const mapName = map.name || '';
    if (mapName && mapName !== this.store.mapName) {
      this.store.mapName = mapName;
      this.resetMapStats();
    }
    const completed = (Number(map.team_ct?.score) || 0) + (Number(map.team_t?.score) || 0);
    if (map.phase === 'warmup' && completed === 0 && Object.keys(this.store.rounds).length) {
      this.resetMapStats();
    }

    // Сторона команды слева «по расписанию»: на старте карты — из пульта,
    // дальше меняется каждую половину. Нужна, только пока игроки ещё не привязаны.
    const roundNow = (gsi.round?.phase === 'over') ? Math.max(1, completed) : completed + 1;
    const startSide = control.sides?.aStart === 'T' ? 'T' : 'CT';
    const scheduled = halfIndex(roundNow) % 2 === 0 ? startSide : flip(startSide);

    this.assignPlayers(all, scheduled);

    // Текущая сторона команды A: по большинству её игроков,
    // а если серверу заданы названия команд (mp_teamname_1/2) и они совпали — по ним.
    let aSide = this.sideByPlayers(all, 'A');
    const aName = (control.teamA?.name || '').trim().toLowerCase();
    const bName = (control.teamB?.name || '').trim().toLowerCase();
    const ctName = (map.team_ct?.name || '').trim().toLowerCase();
    const tName = (map.team_t?.name || '').trim().toLowerCase();
    if (aName && ctName && aName === ctName) aSide = 'CT';
    else if (aName && tName && aName === tName) aSide = 'T';
    else if (bName && ctName && bName === ctName) aSide = 'T';
    else if (bName && tName && bName === tName) aSide = 'CT';
    if (!aSide) aSide = scheduled;
    const bSide = flip(aSide);

    const roundPhase = gsi.round?.phase || '';
    const countdown = gsi.phase_countdowns || {};
    const phase = map.phase === 'warmup' ? 'warmup'
      : map.phase === 'gameover' ? 'gameover'
      : map.phase === 'intermission' ? 'intermission'
      : (countdown.phase || roundPhase || 'live');

    const currentRound = roundPhase === 'over' ? Math.max(1, completed) : completed + 1;
    // Ключ раунда — сколько раундов было сыграно к его началу. Счёт растёт в момент
    // окончания раунда, поэтому в фазе итога раунд всё ещё «тот же».
    const roundKey = String(roundPhase === 'over' ? Math.max(0, completed - 1) : completed);

    // ------------------------------------------------ статистика по раундам
    // ADR и процент хедшотов считаем только по раундам, которые сервер видел
    // своими глазами: если его запустили посреди карты, ранние раунды не искажают цифры.
    if (roundPhase && roundPhase !== 'freezetime' && map.phase !== 'warmup' && ids.length) {
      if (!this.store.seen[roundKey]) { this.store.seen[roundKey] = true; this.dirty = true; }
      for (const id of ids) {
        const st = all[id].state || {};
        const bump = (bucket, value) => {
          const rec = (this.store[bucket][id] ||= {});
          if (value > (rec[roundKey] || 0)) { rec[roundKey] = value; this.dirty = true; }
        };
        bump('dmg', Number(st.round_totaldmg) || 0);
        bump('hs', Number(st.round_killhs) || 0);
        bump('kills', Number(st.round_kills) || 0);
      }
    }

    // ------------------------------------------------ история раундов
    this.recordRounds(map, gsi.round, aSide, currentRound);

    // ------------------------------------------------ игроки
    const observedId = this.observedId(gsi);
    const players = ids.map(id => this.player(id, all[id], observedId, completed, aSide));
    const teamA = players.filter(p => p.team === 'A').sort(bySlot);
    const teamB = players.filter(p => p.team === 'B').sort(bySlot);

    // ------------------------------------------------ лента убийств
    this.updateKillfeed(players, roundKey, roundPhase, now);

    // ------------------------------------------------ бомба
    const bomb = this.bombState(gsi, countdown, players, now);

    // ------------------------------------------------ итог раунда
    let result = null;
    if (roundPhase === 'over' && gsi.round?.win_team) {
      const side = String(gsi.round.win_team).toUpperCase() === 'CT' ? 'CT' : 'T';
      const rec = this.store.rounds[String(currentRound)];
      result = {
        round: currentRound,
        side,
        team: side === aSide ? 'A' : 'B',
        reason: rec ? REASONS[rec.raw] || '' : ''
      };
    }

    const team = (key, side) => {
      const t = side === 'CT' ? map.team_ct || {} : map.team_t || {};
      const list = key === 'A' ? teamA : teamB;
      const money = list.reduce((s, p) => s + p.money, 0);
      const equip = list.reduce((s, p) => s + p.equip, 0);
      const losses = Number(t.consecutive_round_losses) || 0;
      return {
        side,
        score: Number(t.score) || 0,
        timeouts: t.timeouts_remaining ?? null,
        losses,
        lossBonus: 1400 + 500 * Math.min(losses, 4),
        money,
        equip,
        buy: buyType(list, currentRound),
        alive: list.filter(p => p.alive).length,
        players: list
      };
    };

    const timeLeft = Number(countdown.phase_ends_in);

    return {
      at: now,
      live: ids.length > 0,
      map: { name: mapName, label: mapLabel(mapName), phase: map.phase || '' },
      phase,                        // warmup | freezetime | live | bomb | defuse | over | timeout_ct | timeout_t | paused | gameover
      roundPhase,
      round: currentRound,
      half: halfLabel(currentRound),
      timeLeft: Number.isFinite(timeLeft) ? timeLeft : null,
      timeoutTeam: phase === 'timeout_ct' ? (aSide === 'CT' ? 'A' : 'B')
                 : phase === 'timeout_t' ? (aSide === 'T' ? 'A' : 'B') : null,
      a: team('A', aSide),
      b: team('B', bSide),
      observed: observedId,
      bomb,
      result,
      rounds: this.roundList(completed),
      killfeed: this.killfeed.slice(-6)
    };
  }

  /* ----------------------------------------------------- привязка игроков */

  assignPlayers(all, scheduled) {
    const ids = Object.keys(all);
    if (!ids.length) return;
    const assign = this.store.assign;

    // Пришли почти сплошь незнакомые люди — это новый матч, начинаем привязку заново.
    const unknown = ids.filter(id => !assign[id]);
    if (unknown.length >= 6) {
      for (const id of Object.keys(assign)) delete assign[id];
    }
    if (!ids.some(id => !assign[id])) return;

    const aSide = this.sideByPlayers(all, 'A') || scheduled;

    for (const id of ids) {
      if (assign[id]) continue;
      const side = String(all[id].team || '').toUpperCase();
      if (side !== 'CT' && side !== 'T') continue;
      assign[id] = side === aSide ? 'A' : 'B';
      this.dirty = true;
    }
  }

  sideByPlayers(all, teamKey) {
    let ct = 0, t = 0;
    for (const [id, p] of Object.entries(all)) {
      if (this.store.assign[id] !== teamKey) continue;
      const side = String(p.team || '').toUpperCase();
      if (side === 'CT') ct++;
      if (side === 'T') t++;
    }
    if (!ct && !t) return null;
    return ct >= t ? 'CT' : 'T';
  }

  observedId(gsi) {
    const p = gsi.player;
    if (!p || !p.steamid) return null;
    // Наблюдатель во free-cam: в поле player приходит он сам
    if (gsi.provider && p.steamid === gsi.provider.steamid) return null;
    if (!gsi.allplayers || !gsi.allplayers[p.steamid]) return null;
    return p.steamid;
  }

  /* ----------------------------------------------------- один игрок */

  player(id, raw, observedId, completed, aSide) {
    const st = raw.state || {};
    const ms = raw.match_stats || {};
    const weapons = Object.values(raw.weapons || {});

    let primary = null, secondary = null, active = null, hasBomb = false, taser = false;
    const nades = {};
    for (const w of weapons) {
      const type = w.type || '';
      if (w.name === 'weapon_c4' || type === 'C4') hasBomb = true;
      if (w.name === 'weapon_taser') taser = true;
      if (GRENADES[w.name]) {
        const kind = GRENADES[w.name];
        nades[kind] = (nades[kind] || 0) + Math.max(1, Number(w.ammo_reserve) || 1);
      }
      if (PRIMARY_TYPES.includes(type)) primary = w;
      if (type === 'Pistol') secondary = w;
      if (w.state === 'active') active = w;
    }
    const grenades = [];
    for (const kind of GRENADE_ORDER) {
      for (let i = 0; i < (nades[kind] || 0); i++) grenades.push(kind);
    }

    const kills = Number(ms.kills) || 0;
    // Сыгранные раунды, которые видел сервер. Ключ раунда — map.round,
    // то есть число завершённых раундов на момент его начала.
    const seenDone = Object.keys(this.store.seen).filter(k => Number(k) < completed);
    const sum = bucket => seenDone.reduce((s, k) => s + ((this.store[bucket][id] || {})[k] || 0), 0);
    // null — сервер ещё не видел ни одного сыгранного раунда, показывать нечего
    const adr = seenDone.length ? Math.round(sum('dmg') / seenDone.length) : null;
    const trackedKills = Object.values(this.store.kills[id] || {}).reduce((s, v) => s + v, 0);
    const trackedHs = Object.values(this.store.hs[id] || {}).reduce((s, v) => s + v, 0);

    const side = String(raw.team || '').toUpperCase() === 'T' ? 'T' : 'CT';
    const team = this.store.assign[id] || (side === aSide ? 'A' : 'B');
    const hp = Number(st.health) || 0;

    const gun = primary || secondary;
    return {
      steamid: id,
      name: raw.name || 'игрок',
      slot: raw.observer_slot ?? null,
      side,
      team,
      hp,
      alive: hp > 0,
      armor: Number(st.armor) || 0,
      helmet: !!st.helmet,
      defusekit: !!st.defusekit,
      flashed: Number(st.flashed) || 0,
      burning: Number(st.burning) || 0,
      money: Number(st.money) || 0,
      equip: Number(st.equip_value) || 0,
      roundKills: Number(st.round_kills) || 0,
      roundHs: Number(st.round_killhs) || 0,
      roundDmg: Number(st.round_totaldmg) || 0,
      kills,
      deaths: Number(ms.deaths) || 0,
      assists: Number(ms.assists) || 0,
      mvps: Number(ms.mvps) || 0,
      score: Number(ms.score) || 0,
      adr,
      hsPct: trackedKills ? Math.round(Math.min(trackedHs, trackedKills) / trackedKills * 100) : null,
      weapon: gun ? weaponLabel(gun.name) : '',
      weaponKind: primary ? 'primary' : secondary ? 'pistol' : 'knife',
      active: active ? {
        label: weaponLabel(active.name),
        clip: active.ammo_clip ?? null,
        clipMax: active.ammo_clip_max ?? null,
        reserve: active.ammo_reserve ?? null,
        grenade: !!GRENADES[active.name]
      } : null,
      grenades,
      hasBomb,
      taser,
      observed: id === observedId
    };
  }

  /* ----------------------------------------------------- история раундов */

  recordRounds(map, round, aSide, currentRound) {
    const wins = map.round_wins || {};
    const hNow = halfIndex(currentRound);
    for (const [key, raw] of Object.entries(wins)) {
      const existing = this.store.rounds[key];
      if (existing && existing.raw === raw) continue;
      const side = String(raw).startsWith('ct_') ? 'CT' : 'T';
      // Раунд случился до запуска сервера — считаем стороны по половинам MR12.
      const h = halfIndex(Number(key));
      const aSideThen = (hNow - h) % 2 === 0 ? aSide : flip(aSide);
      this.store.rounds[key] = { raw, side, winner: side === aSideThen ? 'A' : 'B' };
      this.dirty = true;
    }
    // Раунд закончился прямо сейчас — знаем стороны точно, перезаписываем.
    if (round?.phase === 'over' && round.win_team) {
      const key = String(currentRound);
      const side = String(round.win_team).toUpperCase() === 'CT' ? 'CT' : 'T';
      const rec = this.store.rounds[key] || {};
      const winner = side === aSide ? 'A' : 'B';
      if (rec.winner !== winner || rec.side !== side) {
        this.store.rounds[key] = { raw: rec.raw || (side === 'CT' ? 'ct_win_elimination' : 't_win_elimination'), side, winner, exact: true };
        this.dirty = true;
      }
    }
  }

  roundList(completed) {
    const list = [];
    const total = Math.max(24, completed);
    for (let r = 1; r <= total; r++) {
      const rec = this.store.rounds[String(r)];
      list.push(rec ? {
        round: r,
        winner: rec.winner,
        side: rec.side,
        kind: rec.raw?.includes('bomb') ? 'bomb' : rec.raw?.includes('defuse') ? 'defuse'
            : rec.raw?.includes('time') ? 'time' : 'kill'
      } : { round: r });
    }
    return list;
  }

  /* ----------------------------------------------------- лента убийств */

  updateKillfeed(players, roundKey, roundPhase, now) {
    // Новый раунд — лента очищается, как в самой игре.
    if (roundKey !== this.prevKey) {
      this.killfeed = [];
      this.prev = null;
      this.prevKey = roundKey;
    }
    const snap = {};
    for (const p of players) snap[p.steamid] = p;

    if (this.prev && roundPhase !== 'freezetime') {
      const victims = players.filter(p => this.prev[p.steamid]?.alive && !p.alive);
      const killers = [];
      const assisters = [];
      for (const p of players) {
        const was = this.prev[p.steamid];
        if (!was) continue;
        const dk = p.kills - was.kills;
        for (let i = 0; i < dk; i++) killers.push({ p, hs: p.roundHs > was.roundHs });
        if (p.assists > was.assists) assisters.push(p);
      }
      for (const v of victims) {
        const idx = killers.findIndex(k => k.p.team !== v.team);
        const k = idx >= 0 ? killers.splice(idx, 1)[0] : null;
        const aIdx = k ? assisters.findIndex(a => a.team === k.p.team && a.steamid !== k.p.steamid) : -1;
        const assist = aIdx >= 0 ? assisters.splice(aIdx, 1)[0] : null;
        this.killfeed.push({
          id: `${now}-${v.steamid}`,
          at: now,
          killer: k ? { name: k.p.name, team: k.p.team, side: k.p.side } : null,
          assist: assist ? { name: assist.name, team: assist.team, side: assist.side } : null,
          victim: { name: v.name, team: v.team, side: v.side },
          weapon: k ? (k.p.active?.label || k.p.weapon || '') : '',
          headshot: !!(k && k.hs)
        });
      }
      if (this.killfeed.length > 12) this.killfeed = this.killfeed.slice(-12);
    }
    this.prev = snap;
  }

  /* ----------------------------------------------------- бомба */

  bombState(gsi, countdown, players, now) {
    const b = gsi.bomb || {};
    const state = b.state || (gsi.round?.bomb === 'planted' ? 'planted' : gsi.round?.bomb || '');
    const left = Number(countdown.phase_ends_in);

    if (state === 'planted' || countdown.phase === 'bomb') {
      const c = Number(b.countdown);
      const secs = Number.isFinite(c) ? c : (countdown.phase === 'bomb' && Number.isFinite(left) ? left : null);
      if (secs !== null) { this.plantedAt = now; this.plantedLeft = secs; }
    }
    if (!['planted', 'defusing'].includes(state) && countdown.phase !== 'bomb' && countdown.phase !== 'defuse') {
      this.plantedAt = 0;
    }

    const explode = this.plantedAt ? Math.max(0, this.plantedLeft - (now - this.plantedAt) / 1000) : null;
    const out = { state, explodeLeft: explode, explodeTotal: 40, carrier: null, defuser: null, defuseLeft: null, defuseTotal: null, planter: null, plantLeft: null };

    const byId = id => players.find(p => p.steamid === id);
    if (state === 'carried' && b.player) out.carrier = byId(b.player)?.name || null;
    if (state === 'planting' && b.player) {
      out.planter = byId(b.player)?.name || null;
      const c = Number(b.countdown);
      out.plantLeft = Number.isFinite(c) ? c : null;
    }
    if (state === 'defusing' || countdown.phase === 'defuse') {
      const d = byId(b.player);
      const c = Number(b.countdown);
      out.defuser = d ? d.name : null;
      out.defuseTotal = d?.defusekit ? 5 : 10;
      out.defuseLeft = Number.isFinite(c) ? c : (countdown.phase === 'defuse' && Number.isFinite(left) ? left : null);
    }
    return out;
  }
}

function bySlot(a, b) {
  // Слот 0 — это клавиша «0», десятый по счёту, поэтому ставим его в конец.
  const norm = s => (s === null || s === undefined ? 99 : Number(s) === 0 ? 10 : Number(s));
  const sa = norm(a.slot), sb = norm(b.slot);
  return sa - sb || a.name.localeCompare(b.name);
}

function buyType(list, round) {
  if (!list.length) return '';
  if (round === 1 || round === 13) return 'Пистолетный';
  const avg = list.reduce((s, p) => s + p.equip, 0) / list.length;
  if (avg >= 4000) return 'Фулл-бай';
  if (avg >= 2000) return 'Форс';
  return 'Эко';
}

module.exports = { Cs2Match, weaponLabel, mapLabel, MAPS };
