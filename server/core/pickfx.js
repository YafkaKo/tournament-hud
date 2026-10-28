/**
 * Анимация пика героя: сервер узнаёт о новом пике (games/dota), проверяет,
 * есть ли фраза героя в public/assets/heroes/voice/, и рассылает событие 'pick'.
 * Оверлей проигрывает анимацию; звук — только у основного оверлея (OBS).
 */

const fs = require('fs');
const path = require('path');

const VOICE_EXT = ['.ogg', '.mp3', '.wav', '.webm'];

function createPickFx({ state, hub, change }) {
  const VOICE_DIR = path.join(state.root, 'public', 'assets', 'heroes', 'voice');
  let last = null;
  let seq = 0;

  function heroKey(name) {
    return String(name || '').replace(/^npc_dota_hero_/, '').replace(/[^a-z0-9_]/gi, '');
  }

  function voiceUrl(key) {
    for (const ext of VOICE_EXT) {
      if (fs.existsSync(path.join(VOICE_DIR, key + ext))) return `/assets/heroes/voice/${key}${ext}`;
    }
    return '';
  }

  function send(pick) {
    const cfg = state.s.pickFx;
    seq += 1;
    hub.broadcast('pick', {
      ...pick,
      id: seq,
      volume: Math.max(0, Math.min(100, Number(cfg.volume ?? 80))),
      voice: cfg.voice !== false ? pick.voice : ''
    });
  }

  return {
    emit(p) {
      const key = heroKey(p.hero);
      if (!key) return;
      const s = state.s;
      const teamKey = p.side === 'dire' ? (s.dota.radiantIs === 'B' ? 'A' : 'B') : (s.dota.radiantIs === 'B' ? 'B' : 'A');
      const pick = {
        game: p.game,
        side: p.side,
        slot: p.slot,
        hero: key,
        team: s.shared.teams[teamKey]?.name || (p.side === 'dire' ? 'Dire' : 'Radiant'),
        voice: voiceUrl(key)
      };
      last = pick;
      if (!s.pickFx.enabled || s.game !== p.game) return;
      console.log(`[pick] ${pick.team}: ${key}${pick.voice ? ' (с голосом)' : ''}`);
      send(pick);
    },
    replay() {
      if (!last) return { error: 'Пиков ещё не было' };
      send({ ...last, voice: voiceUrl(last.hero) });
      return { hero: last.hero };
    },
    routes(app) {
      // Какие фразы героев лежат в папке — для пульта.
      app.get('/api/pickfx/voices', (req, res) => {
        let files = [];
        try { files = fs.readdirSync(VOICE_DIR).filter(f => VOICE_EXT.includes(path.extname(f).toLowerCase())); } catch { /* папки нет */ }
        res.json({ count: files.length, files });
      });
      // Настройки: { enabled, voice, volume }
      app.post('/api/pickfx/settings', (req, res) => {
        const b = req.body || {};
        change(() => {
          const p = state.s.pickFx;
          if (typeof b.enabled === 'boolean') p.enabled = b.enabled;
          if (typeof b.voice === 'boolean') p.voice = b.voice;
          if (Number.isFinite(Number(b.volume))) p.volume = Math.max(0, Math.min(100, Number(b.volume)));
        });
        res.json(state.s.pickFx);
      });
      // Проверка без игры: /api/pickfx/test?hero=juggernaut&side=dire
      app.post('/api/pickfx/test', (req, res) => {
        const hero = heroKey(req.query.hero || req.body?.hero || 'juggernaut');
        const side = (req.query.side || req.body?.side) === 'dire' ? 'dire' : 'radiant';
        const s = state.s;
        const teamKey = side === 'dire' ? (s.dota.radiantIs === 'B' ? 'A' : 'B') : (s.dota.radiantIs === 'B' ? 'B' : 'A');
        last = { game: 'dota', side, slot: 0, hero, team: s.shared.teams[teamKey].name, voice: voiceUrl(hero) };
        send(last);
        res.json({ ok: true, ...last });
      });
    }
  };
}

module.exports = { createPickFx };
