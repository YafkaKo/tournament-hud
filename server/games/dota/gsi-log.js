/**
 * Запись сырых пакетов GSI в файл — для разбора проблем на живой игре.
 *
 * Включается в config/server.json:
 *   "gsiLog": { "enabled": true, "onlyDraft": true, "compact": true }
 *
 *   onlyDraft — писать только пакеты стадии драфта (иначе файл растёт на мегабайты в минуту);
 *   compact   — писать только provider, map и draft, без игроков и предметов.
 *
 * Файл: data/gsi-log/gsi-ГГГГММДД-ЧЧММСС.jsonl, одна строка — один пакет.
 * Токен авторизации в файл не попадает.
 */

const fs = require('fs');
const path = require('path');

const DRAFT_STATES = new Set([
  'DOTA_GAMERULES_STATE_HERO_SELECTION',
  'DOTA_GAMERULES_STATE_STRATEGY_TIME',
  'DOTA_GAMERULES_STATE_PLAYER_DRAFT'
]);

class GsiLog {
  constructor(cfg, root) {
    this.cfg = { enabled: false, onlyDraft: true, compact: true, ...(cfg || {}) };
    this.stream = null;
    this.file = null;
    this.count = 0;
    if (!this.cfg.enabled) return;

    const dir = path.join(root, 'data', 'gsi-log');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `gsi-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jsonl`;
    this.file = path.join(dir, name);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    console.log(`[gsi-log] пишу пакеты в ${path.relative(root, this.file)}` +
      `${this.cfg.onlyDraft ? ' (только драфт)' : ''}${this.cfg.compact ? ' (provider, map, draft)' : ''}`);
  }

  /** body — пакет без токена; verdict — что сервер с ним сделал (accepted / ignored: причина). */
  write(body, verdict) {
    if (!this.stream) return;
    const state = body && body.map && body.map.game_state;
    if (this.cfg.onlyDraft && !body.draft && !DRAFT_STATES.has(state)) return;

    const data = this.cfg.compact
      ? { provider: body.provider, map: body.map, draft: body.draft }
      : body;
    this.stream.write(JSON.stringify({ t: new Date().toISOString(), verdict, data }) + '\n');
    this.count += 1;
  }
}

module.exports = { GsiLog };
