/**
 * Имитатор CS2: шлёт на сервер правдоподобные GSI-пакеты наблюдателя.
 * Нужен, чтобы проверять графику и репетировать работу пульта без лобби
 * из десяти человек.
 *
 *   node tools/mock-cs2.js                 — матч с первого раунда
 *   node tools/mock-cs2.js --round=12      — сразу с 12-го раунда (увидеть смену сторон)
 *   node tools/mock-cs2.js --speed=3       — в три раза быстрее
 *   node tools/mock-cs2.js --warmup        — начать с разминки
 *
 * Что происходит: закупка → раунд → убийства → закладка бомбы
 * → разминирование или взрыв → итог раунда → деньги → следующий раунд.
 * После 12-го раунда команды меняются сторонами, как в настоящем MR12.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'server.json'), 'utf8'));
const arg = (name, def) => {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = hit.split('=')[1];
  return v === undefined ? true : v;
};

const SPEED = Math.max(0.25, Number(arg('speed', 1)) || 1);
const START_ROUND = Math.max(1, Number(arg('round', 1)) || 1);
const WARMUP = !!arg('warmup', false);
const MAP = String(arg('map', 'de_mirage'));
const TICK = 100;

// Псевдослучайность с зерном — прогоны повторяемы
let seed = Number(arg('seed', 7)) || 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = arr => arr[Math.floor(rnd() * arr.length)];

const NICKS_A = ['Sever', 'kotyara', 'Almaz', 'nikitka', 'Zubov'];
const NICKS_B = ['Dyadya', 'w1nter', 'Malysh', 'Grek', 'Stepa'];

const RIFLE = { CT: ['weapon_m4a1_silencer', 'weapon_m4a1', 'weapon_famas', 'weapon_aug'], T: ['weapon_ak47', 'weapon_ak47', 'weapon_galilar', 'weapon_sg556'] };
const SMG = { CT: ['weapon_mp9', 'weapon_ump45', 'weapon_mp5sd'], T: ['weapon_mac10', 'weapon_ump45', 'weapon_mp7'] };
const PISTOL = { CT: 'weapon_usp_silencer', T: 'weapon_glock' };
const TYPES = {
  weapon_m4a1_silencer: 'Rifle', weapon_m4a1: 'Rifle', weapon_famas: 'Rifle', weapon_aug: 'Rifle',
  weapon_ak47: 'Rifle', weapon_galilar: 'Rifle', weapon_sg556: 'Rifle', weapon_awp: 'SniperRifle',
  weapon_mp9: 'Submachine Gun', weapon_ump45: 'Submachine Gun', weapon_mp5sd: 'Submachine Gun',
  weapon_mac10: 'Submachine Gun', weapon_mp7: 'Submachine Gun',
  weapon_usp_silencer: 'Pistol', weapon_glock: 'Pistol', weapon_deagle: 'Pistol', weapon_p250: 'Pistol'
};
const CLIP = { Rifle: 30, SniperRifle: 5, 'Submachine Gun': 25, Pistol: 12 };

// ------------------------------------------------------------- игроки

const players = [...NICKS_A, ...NICKS_B].map((name, i) => ({
  steamid: '765611980000000' + String(10 + i),
  name,
  slot: i < 5 ? i + 1 : (i === 9 ? 0 : i + 1),
  team: i < 5 ? 'CT' : 'T',
  hp: 100, armor: 0, helmet: false, kit: false,
  money: 800, equip: 200,
  primary: null, secondary: null, nades: [],
  kills: 0, deaths: 0, assists: 0, mvps: 0, score: 0,
  roundKills: 0, roundHs: 0, roundDmg: 0,
  bomb: false
}));

let ctScore = 0, tScore = 0;
let ctLosses = 0, tLosses = 0;
const roundWins = {};
let phase = WARMUP ? 'warmup' : 'freezetime';
let phaseLeft = WARMUP ? 20 : 12;
let bomb = { state: 'carried', player: null, countdown: null };
let roundBomb = null;
let winTeam = null;
let observed = players[0].steamid;
let observeTimer = 0;
let eventTimer = 4;
let planting = 0;
let defusing = null;

// Перемотка к нужному раунду: правдоподобный счёт и статистика
if (START_ROUND > 1) {
  for (let r = 1; r < START_ROUND; r++) {
    const ctWin = rnd() < 0.5;
    const side = ctWin ? 'CT' : 'T';
    roundWins[r] = ctWin ? pick(['ct_win_elimination', 'ct_win_defuse', 'ct_win_elimination', 'ct_win_time']) : pick(['t_win_elimination', 't_win_bomb', 't_win_bomb']);
    // на момент раунда r команды стояли по-своему: до 12 включительно — как в начале
    const aWasCT = r <= 12;
    if (ctWin === aWasCT) ctScore++; else tScore++;   // ctScore тут временно = очки команды A
    for (const p of players) {
      const k = Math.floor(rnd() * 2.2);
      p.kills += k; p.deaths += Math.floor(rnd() * 1.6); p.assists += rnd() < 0.3 ? 1 : 0;
      p.score += k * 2;
    }
  }
  // очки команды A/B → очки сторон с учётом смены в перерыве
  const aScore = ctScore, bScore = tScore;
  if (START_ROUND > 12) {
    for (const p of players) p.team = p.team === 'CT' ? 'T' : 'CT';
    ctScore = bScore; tScore = aScore;
  } else {
    ctScore = aScore; tScore = bScore;
  }
  for (const p of players) p.money = 3000 + Math.floor(rnd() * 5000);
}

function completed() { return ctScore + tScore; }
function alive(team) { return players.filter(p => p.team === team && p.hp > 0); }

// ------------------------------------------------------------- фазы раунда

function startFreeze() {
  phase = 'freezetime';
  phaseLeft = 12;
  winTeam = null;
  roundBomb = null;
  planting = 0;
  defusing = null;
  const round = completed() + 1;
  const pistol = round === 1 || round === 13;
  if (pistol) for (const p of players) { p.money = 800; p.primary = null; p.armor = 0; p.helmet = false; p.kit = false; }
  for (const p of players) {
    p.hp = 100;
    p.roundKills = 0; p.roundHs = 0; p.roundDmg = 0;
    p.secondary = PISTOL[p.team];
    p.nades = [];
    p.bomb = false;
  }
  const ts = players.filter(p => p.team === 'T');
  const carrier = pick(ts);
  carrier.bomb = true;
  bomb = { state: 'carried', player: carrier.steamid };
  eventTimer = 3 + rnd() * 3;
}

function buy() {
  // Закупка растянута на всю заморозку — видно, как растёт экипировка.
  // Решение команды как у людей: денег хватает на всех — полная закупка, иначе эко.
  const round = completed() + 1;
  for (const team of ['CT', 'T']) {
    const squad = players.filter(p => p.team === team);
    const avg = squad.reduce((s, p) => s + p.money, 0) / squad.length;
    const full = avg >= 3700 || round === 1 || round === 13;
    for (const p of squad) {
      if (rnd() > 0.1) continue;
      if (!full) {
        if (p.money >= 2400 && p.armor < 100) { p.armor = 100; p.helmet = false; p.money -= 650; }
        continue;
      }
      if (round === 1 || round === 13) {
        if (p.armor < 100 && p.money >= 650) { p.armor = 100; p.money -= 650; }
        else if (p.nades.length < 1 && p.money >= 200) { p.nades.push('weapon_flashbang'); p.money -= 200; }
        continue;
      }
      if (!p.primary && p.money >= 2900) {
        p.primary = rnd() < 0.15 && p.money >= 4750 ? 'weapon_awp' : pick(RIFLE[p.team]);
        p.money -= p.primary === 'weapon_awp' ? 4750 : 2900;
      } else if (p.armor < 100 && p.money >= 1000) {
        p.armor = 100; p.helmet = true; p.money -= 1000;
      } else if (p.team === 'CT' && !p.kit && p.money >= 400) {
        p.kit = true; p.money -= 400;
      } else if (p.nades.length < 4 && p.money >= 300) {
        p.nades.push(pick(['weapon_smokegrenade', 'weapon_flashbang', 'weapon_hegrenade', p.team === 'T' ? 'weapon_molotov' : 'weapon_incgrenade']));
        p.money -= 300;
      }
    }
  }
}

function endRound(team, reason) {
  phase = 'over';
  phaseLeft = 6;
  winTeam = team;
  roundWins[completed() + 1] = reason;
  if (team === 'CT') { ctScore++; ctLosses = Math.max(0, ctLosses - 1); tLosses++; }
  else { tScore++; tLosses = Math.max(0, tLosses - 1); ctLosses++; }
  for (const p of players) {
    if (p.team === team) p.money += 3250;
    else p.money += 1400 + 500 * Math.min(4, (team === 'CT' ? tLosses : ctLosses) - 1);
    p.money = Math.min(16000, p.money);
    if (p.hp <= 0) { p.primary = null; p.armor = 0; p.helmet = false; p.kit = false; }
  }
  const best = players.filter(p => p.team === team).sort((a, b) => b.roundKills - a.roundKills)[0];
  if (best) best.mvps++;
  if (team === 'CT' && reason === 'ct_win_defuse') roundBomb = 'defused';
  if (team === 'T' && reason === 't_win_bomb') roundBomb = 'exploded';
}

function nextRound() {
  if (completed() === 12) {
    // перерыв: меняем стороны, деньги сгорают
    for (const p of players) p.team = p.team === 'CT' ? 'T' : 'CT';
    [ctScore, tScore] = [tScore, ctScore];
    [ctLosses, tLosses] = [0, 0];
  }
  if (ctScore >= 13 || tScore >= 13) {
    phase = 'gameover';
    phaseLeft = 9999;
    return;
  }
  startFreeze();
}

function kill() {
  const ct = alive('CT'), t = alive('T');
  if (!ct.length || !t.length) return;
  // у Т чуть выше шанс на открытие, у CT — на ретейк после закладки
  const ctFavored = bomb.state === 'planted' ? 0.55 : 0.47;
  const [killers, victims] = rnd() < ctFavored ? [ct, t] : [t, ct];
  const killer = pick(killers);
  const victim = pick(victims);
  const hs = rnd() < 0.45;
  killer.kills++; killer.roundKills++; killer.score += 2;
  if (hs) killer.roundHs++;
  killer.roundDmg += victim.hp;
  victim.hp = 0;
  victim.deaths++;
  if (victim.bomb) { victim.bomb = false; bomb = { state: 'dropped', player: null }; }
  if (defusing === victim.steamid) { defusing = null; bomb.state = 'planted'; }
  // помощь
  if (rnd() < 0.35) {
    const mates = killers.filter(p => p !== killer);
    if (mates.length) { const a = pick(mates); a.assists++; a.score++; a.roundDmg += 40 + Math.floor(rnd() * 50); }
  }
  // сопутствующий урон по выжившим
  const hurt = pick([...alive('CT'), ...alive('T')]);
  if (hurt && rnd() < 0.6) {
    const d = Math.min(hurt.hp - 1, 10 + Math.floor(rnd() * 60));
    const foes = players.filter(p => p.team !== hurt.team && p.hp > 0);
    if (d > 0 && foes.length) { hurt.hp -= d; hurt.armor = Math.max(0, hurt.armor - Math.floor(d / 3)); pick(foes).roundDmg += d; }
  }
  if (rnd() < 0.5) killer.hp = Math.max(1, killer.hp - Math.floor(rnd() * 40));
}

function step(dt) {
  phaseLeft -= dt;
  observeTimer -= dt;

  if (phase === 'warmup') {
    if (phaseLeft <= 0) startFreeze();
    return;
  }
  if (phase === 'gameover') return;

  if (phase === 'freezetime') {
    buy();
    if (phaseLeft <= 0) { phase = 'live'; phaseLeft = 115; }
  } else if (phase === 'live' || phase === 'bomb' || phase === 'defuse') {
    eventTimer -= dt;

    // упавшую бомбу подбирает кто-то из живых Т
    if (bomb.state === 'dropped' && rnd() < 0.03 && alive('T').length) {
      const c = pick(alive('T'));
      c.bomb = true;
      bomb = { state: 'carried', player: c.steamid };
    }
    // закладка
    if (bomb.state === 'carried' && phase === 'live' && phaseLeft < 85 && rnd() < 0.01) {
      planting = 3.2;
      bomb.state = 'planting';
    }
    if (bomb.state === 'planting') {
      planting -= dt;
      bomb.countdown = Math.max(0, planting);
      const carrier = players.find(p => p.steamid === bomb.player);
      if (!carrier || carrier.hp <= 0) { bomb = { state: 'dropped', player: null }; }
      else if (planting <= 0) {
        carrier.bomb = false;
        carrier.score += 2;
        bomb = { state: 'planted', player: null, countdown: 40 };
        phase = 'bomb';
        phaseLeft = 40;
      }
    }
    if (bomb.state === 'planted' || bomb.state === 'defusing') {
      bomb.countdown = Math.max(0, phaseLeft);
      if (bomb.state === 'planted' && alive('T').length === 0 && alive('CT').length && !defusing) {
        const d = pick(alive('CT'));
        defusing = d.steamid;
        bomb.state = 'defusing';
        bomb.player = d.steamid;
        bomb.defuseLeft = d.kit ? 5 : 10;
      }
      if (bomb.state === 'planted' && rnd() < 0.004 && alive('CT').length) {
        const d = pick(alive('CT'));
        defusing = d.steamid;
        bomb.state = 'defusing';
        bomb.player = d.steamid;
        bomb.defuseLeft = d.kit ? 5 : 10;
      }
      if (bomb.state === 'defusing') {
        bomb.defuseLeft -= dt;
        if (bomb.defuseLeft <= 0) { bomb.state = 'defused'; endRound('CT', 'ct_win_defuse'); return; }
      }
      if (phaseLeft <= 0) {
        bomb.state = 'exploded';
        for (const p of players) if (p.hp > 0 && p.team === 'CT' && rnd() < 0.3) { p.hp = 0; p.deaths++; }
        endRound('T', 't_win_bomb');
        return;
      }
    }

    if (eventTimer <= 0) {
      kill();
      eventTimer = (bomb.state === 'planted' || bomb.state === 'defusing' ? 3 : 5) + rnd() * 6;
    }

    const plantedNow = bomb.state === 'planted' || bomb.state === 'defusing';
    if (!alive('T').length && !plantedNow) return endRound('CT', 'ct_win_elimination');
    if (!alive('CT').length) return endRound('T', plantedNow ? 't_win_bomb' : 't_win_elimination');
    if (phase === 'live' && phaseLeft <= 0) return endRound('CT', 'ct_win_time');
  } else if (phase === 'over') {
    if (phaseLeft <= 0) nextRound();
  }

  // камера переключается между живыми игроками
  const obs = players.find(p => p.steamid === observed);
  if (observeTimer <= 0 || !obs || obs.hp <= 0) {
    const pool = players.filter(p => p.hp > 0);
    if (pool.length) observed = pick(pool).steamid;
    observeTimer = 4 + rnd() * 3;
  }
}

// ------------------------------------------------------------- пакет

function weapons(p) {
  const list = [{ name: p.team === 'CT' ? 'weapon_knife' : 'weapon_knife_t', type: 'Knife' }];
  if (p.secondary) list.push({ name: p.secondary, type: 'Pistol' });
  if (p.primary) list.push({ name: p.primary, type: TYPES[p.primary] || 'Rifle' });
  const counts = {};
  for (const n of p.nades) counts[n] = (counts[n] || 0) + 1;
  for (const [n, c] of Object.entries(counts)) list.push({ name: n, type: 'Grenade', ammo_reserve: c });
  if (p.bomb) list.push({ name: 'weapon_c4', type: 'C4' });
  if (p.team === 'CT' && p.money > 9000) list.push({ name: 'weapon_taser', type: 'StackableItem' });

  const activeIdx = p.primary ? list.findIndex(w => w.name === p.primary) : list.findIndex(w => w.type === 'Pistol');
  const out = {};
  list.forEach((w, i) => {
    const clipMax = CLIP[w.type];
    out[`weapon_${i}`] = {
      name: w.name,
      paintkit: 'default',
      type: w.type,
      state: i === activeIdx ? 'active' : 'holstered',
      ...(clipMax ? { ammo_clip: Math.max(1, clipMax - Math.floor(rnd() * clipMax * 0.6)), ammo_clip_max: clipMax, ammo_reserve: clipMax * 3 } : {}),
      ...(w.ammo_reserve ? { ammo_reserve: w.ammo_reserve } : {})
    };
  });
  return out;
}

function equipValue(p) {
  const price = { Rifle: 2900, SniperRifle: 4750, 'Submachine Gun': 1250 };
  return 200 + (p.primary ? price[TYPES[p.primary]] || 2700 : 0) + (p.armor ? (p.helmet ? 1000 : 650) : 0) + p.nades.length * 300 + (p.kit ? 400 : 0);
}

function playerJson(p) {
  return {
    name: p.name,
    observer_slot: p.slot,
    team: p.team,
    state: {
      health: p.hp,
      armor: p.hp > 0 ? p.armor : 0,
      helmet: p.hp > 0 && p.helmet,
      flashed: 0, smoked: 0, burning: 0,
      money: p.money,
      round_kills: p.roundKills,
      round_killhs: p.roundHs,
      round_totaldmg: p.roundDmg,
      equip_value: p.hp > 0 ? equipValue(p) : 0,
      ...(p.team === 'CT' && p.kit && p.hp > 0 ? { defusekit: true } : {})
    },
    match_stats: { kills: p.kills, assists: p.assists, deaths: p.deaths, mvps: p.mvps, score: p.score },
    weapons: p.hp > 0 ? weapons(p) : {},
    position: `${Math.floor(rnd() * 2000 - 1000)}, ${Math.floor(rnd() * 2000 - 1000)}, 0`,
    forward: '1, 0, 0'
  };
}

function packet() {
  const all = {};
  for (const p of players) all[p.steamid] = playerJson(p);
  const obs = players.find(p => p.steamid === observed);
  const mapPhase = phase === 'warmup' ? 'warmup' : phase === 'gameover' ? 'gameover' : 'live';
  const roundPhase = phase === 'warmup' ? undefined : phase === 'freezetime' ? 'freezetime' : phase === 'over' || phase === 'gameover' ? 'over' : 'live';
  const countdownPhase = phase === 'gameover' ? 'over' : bomb.state === 'defusing' ? 'defuse' : phase;
  return {
    provider: { name: 'Counter-Strike 2', appid: 730, version: 14000, steamid: '76561198000000099', timestamp: Math.floor(Date.now() / 1000) },
    map: {
      mode: 'competitive', name: MAP, phase: mapPhase,
      round: completed(),
      team_ct: { score: ctScore, consecutive_round_losses: ctLosses, timeouts_remaining: 3, matches_won_this_series: 0 },
      team_t: { score: tScore, consecutive_round_losses: tLosses, timeouts_remaining: 3, matches_won_this_series: 0 },
      num_matches_to_win_series: 0,
      round_wins: { ...roundWins }
    },
    round: roundPhase ? {
      phase: roundPhase,
      ...(roundBomb ? { bomb: roundBomb } : bomb.state === 'planted' || bomb.state === 'defusing' ? { bomb: 'planted' } : {}),
      ...(winTeam ? { win_team: winTeam } : {})
    } : undefined,
    player: obs ? { steamid: obs.steamid, ...playerJson(obs), activity: 'playing' } : { steamid: '76561198000000099', name: 'Observer', activity: 'playing' },
    allplayers: all,
    phase_countdowns: {
      phase: countdownPhase,
      phase_ends_in: (bomb.state === 'defusing' ? Math.max(0, bomb.defuseLeft) : Math.max(0, phaseLeft)).toFixed(1)
    },
    bomb: {
      state: bomb.state,
      position: '0, 0, 0',
      ...(bomb.player ? { player: bomb.player } : {}),
      ...(bomb.state === 'planted' || bomb.state === 'defusing' ? { countdown: Math.max(0, bomb.countdown || 0).toFixed(1) } : {}),
      ...(bomb.state === 'planting' ? { countdown: Math.max(0, planting).toFixed(1) } : {}),
      ...(bomb.state === 'defusing' ? { countdown: Math.max(0, bomb.defuseLeft).toFixed(1) } : {})
    },
    auth: { token: cfg.token }
  };
}

function send() {
  const body = JSON.stringify(packet());
  const req = http.request({
    host: '127.0.0.1', port: cfg.port, path: '/gsi/cs2', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, res => res.resume());
  req.on('error', err => {
    if (!send.warned) console.error(`Нет связи с сервером на порту ${cfg.port}. Сначала запустите start.bat.`);
    send.warned = true;
  });
  req.end(body);
}

if (!WARMUP) startFreeze();
console.log(`Имитатор CS2 → http://127.0.0.1:${cfg.port}/gsi/cs2  (карта ${MAP}, раунд ${START_ROUND}, скорость ×${SPEED})`);
console.log('Остановить: Ctrl+C');

let lastLog = '';
setInterval(() => {
  step((TICK / 1000) * SPEED);
  send();
  const line = `Раунд ${completed() + (phase === 'over' ? 0 : 1)} · ${phase} · CT ${ctScore} : ${tScore} T`;
  if (line !== lastLog) { console.log(line); lastLog = line; }
}, TICK);
