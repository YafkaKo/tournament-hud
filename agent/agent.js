/**
 * Агент хоткеев для ПК, на котором запущена Dota 2.
 *
 * Ловит глобальные сочетания клавиш (даже когда игра в фокусе) и:
 *   — переключает сцены OBS через obs-websocket v5 (OBS может стоять на другом ПК);
 *   — включает и выключает плашки HUD через сервер трансляции.
 *
 * Агент только слушает клавиатуру: нажатия не перехватываются и доходят до игры
 * как обычно, поэтому сочетания выбраны такие, которые Dota не использует.
 *
 *   node agent.js                      — обычный запуск
 *   node agent.js --list-scenes        — показать сцены OBS и выйти
 *   node agent.js --simulate "Ctrl+Alt+F1"  — выполнить хоткей без клавиатуры (проверка конфига)
 *   node agent.js --config other.json  — другой файл настроек
 *   node agent.js --no-hook            — только держать связь с OBS, без клавиатуры (диагностика)
 */

const fs = require('fs');
const path = require('path');
const { OBSWebSocket } = require('obs-websocket-js/json');

/* ----------------------------------------------------------- аргументы */

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const simulateList = argv.flatMap((a, i) => (a === '--simulate' ? [argv[i + 1]] : [])).filter(Boolean);
const LIST_SCENES = argv.includes('--list-scenes');
const NO_HOOK = argv.includes('--no-hook');
const CONFIG_PATH = path.resolve(argValue('--config') || path.join(__dirname, 'config.json'));

/* ----------------------------------------------------------- логи */

function stamp() {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}
const log = {
  info: (msg) => console.log(`${stamp()}  ${msg}`),
  ok: (msg) => console.log(`${stamp()}  ✓ ${msg}`),
  warn: (msg) => console.warn(`${stamp()}  ! ${msg}`),
  error: (msg) => console.error(`${stamp()}  ✗ ${msg}`)
};

/* ----------------------------------------------------------- конфиг */

// Имена клавиш совпадают с UiohookKey из uiohook-napi. Список продублирован здесь,
// чтобы проверять конфиг без загрузки нативного модуля.
const KEY_NAMES = [
  ...'0123456789'.split(''), ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  'Backspace', 'Tab', 'Enter', 'CapsLock', 'Escape', 'Space', 'PageUp', 'PageDown', 'End', 'Home',
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Insert', 'Delete',
  'NumpadMultiply', 'NumpadAdd', 'NumpadSubtract', 'NumpadDecimal', 'NumpadDivide', 'NumpadEnter',
  'Semicolon', 'Equal', 'Comma', 'Minus', 'Period', 'Slash', 'Backquote',
  'BracketLeft', 'Backslash', 'BracketRight', 'Quote', 'PrintScreen', 'ScrollLock'
];

const MODIFIERS = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'meta', meta: 'meta', cmd: 'meta' };
const HUD_TARGETS = ['probability', 'mapResults', 'trivia', 'casters'];

function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    log.error(`Не прочитал ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }
  return {
    obs: { url: 'ws://127.0.0.1:4455', password: '', ...(raw.obs || {}) },
    hud: { url: 'http://127.0.0.1:3000', ...(raw.hud || {}) },
    reconnect: { minSec: 1, maxSec: 15, ...(raw.reconnect || {}) },
    hotkeys: Array.isArray(raw.hotkeys) ? raw.hotkeys : []
  };
}

/** "Ctrl+Alt+F1" -> { ctrl, alt, shift, meta, key: 'F1', label } */
function parseCombo(text, keyNames) {
  const parts = String(text).split('+').map((s) => s.trim()).filter(Boolean);
  const combo = { ctrl: false, alt: false, shift: false, meta: false, key: null, label: text };
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod) { combo[mod] = true; continue; }
    if (combo.key) throw new Error(`в «${text}» две основные клавиши`);
    const name = keyNames.find((k) => k.toLowerCase() === part.toLowerCase());
    if (!name) throw new Error(`клавиша «${part}» не знакома. Примеры: F1, A, 5, Numpad1, Space`);
    combo.key = name;
  }
  if (!combo.key) throw new Error(`в «${text}» нет основной клавиши`);
  if (!combo.ctrl && !combo.alt && !combo.meta) {
    log.warn(`«${text}» без Ctrl/Alt — может сработать случайно посреди игры`);
  }
  return combo;
}

function comboId(c) {
  return `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}${c.meta ? 'M' : ''}+${c.key}`;
}

function buildBindings(cfg, keyNames) {
  const bindings = new Map();
  let problems = 0;
  for (const hk of cfg.hotkeys) {
    try {
      const combo = parseCombo(hk.keys, keyNames);
      if (!hk.scene && !hk.hud && !hk.action) throw new Error('нужно указать "scene", "hud" или "action"');
      if (hk.action && !/^[a-zA-Z0-9+_-]+$/.test(hk.action)) throw new Error(`action: «${hk.action}» — имя действия, например scene-starting (список: /api/actions?all=1)`);
      if (hk.hud && !HUD_TARGETS.includes(hk.hud)) throw new Error(`hud: «${hk.hud}» — можно ${HUD_TARGETS.join(', ')}`);
      const id = comboId(combo);
      if (bindings.has(id)) throw new Error('это сочетание уже занято другой строкой');
      bindings.set(id, { combo, scene: hk.scene || null, hud: hk.hud || null, action: hk.action || null });
    } catch (err) {
      problems += 1;
      log.error(`Хоткей ${JSON.stringify(hk.keys)}: ${err.message}`);
    }
  }
  if (problems) log.warn(`Строк с ошибками: ${problems}. Остальные хоткеи работают.`);
  return bindings;
}

/* ----------------------------------------------------------- OBS */

class ObsLink {
  constructor(cfg) {
    this.cfg = cfg;
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.attempt = 0;
    this.timer = null;
    this.stopped = false;
    this.scenes = [];

    this.obs.on('ConnectionClosed', (err) => {
      if (this.stopped || !this.connected) return;   // своё закрытие или неудачный connect — не обрыв
      this.connected = false;
      log.warn(`Связь с OBS потеряна${err && err.message ? ': ' + err.message : ''}. Переподключаюсь…`);
      this.scheduleReconnect();
    });
    this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => log.info(`OBS: в эфире «${sceneName}»`));
    this.obs.on('SceneListChanged', ({ scenes }) => { this.scenes = scenes.map((s) => s.sceneName); });
  }

  async connect() {
    clearTimeout(this.timer);
    if (this.stopped) return false;
    this.attempt += 1;
    try {
      await this.obs.connect(this.cfg.obs.url, this.cfg.obs.password || undefined, { rpcVersion: 1 });
      this.connected = true;
      this.attempt = 0;
      const list = await this.obs.call('GetSceneList');
      this.scenes = list.scenes.map((s) => s.sceneName).reverse();
      log.ok(`OBS подключён (${this.cfg.obs.url}). Сейчас в эфире «${list.currentProgramSceneName}».`);
      return true;
    } catch (err) {
      this.connected = false;
      log.warn(`OBS недоступен (${this.cfg.obs.url}): ${explainObsError(err)}`);
      this.scheduleReconnect();
      return false;
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const { minSec, maxSec } = this.cfg.reconnect;
    const delay = Math.min(maxSec, minSec * 2 ** Math.min(this.attempt, 6));
    log.info(`Следующая попытка подключиться к OBS через ${delay} с`);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay * 1000);
  }

  async setScene(name) {
    if (!this.connected) {
      log.warn(`OBS не подключён — сцена «${name}» не переключена`);
      return false;
    }
    try {
      await this.obs.call('SetCurrentProgramScene', { sceneName: name });
      log.ok(`Сцена → «${name}»`);
      return true;
    } catch (err) {
      if (err.code === 600) {
        log.error(`Сцены «${name}» нет в OBS. Есть: ${this.scenes.map((s) => `«${s}»`).join(', ')}`);
      } else {
        log.error(`OBS не переключил сцену «${name}»: ${err.message}`);
      }
      return false;
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    try { await this.obs.disconnect(); } catch { /* уже закрыто */ }
  }
}

function explainObsError(err) {
  const msg = (err && err.message) || String(err);
  if (err && err.code === 4009) return 'неверный пароль obs-websocket';
  if (/ECONNREFUSED/.test(msg)) return 'соединение отклонено — OBS не запущен или WebSocket-сервер выключен';
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(msg)) return 'ПК с OBS не отвечает — проверьте IP и брандмауэр';
  if (/ENOTFOUND/.test(msg)) return 'адрес не найден — проверьте "obs.url" в config.json';
  return msg;
}

/* ----------------------------------------------------------- HUD */

async function toggleHud(cfg, target) {
  const url = `${cfg.hud.url.replace(/\/$/, '')}/api/toggle/${target}`;
  try {
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
    const data = await res.json();
    const names = { probability: 'Вероятность победы', mapResults: 'Итоги карты', trivia: 'Trivia', casters: 'Комментаторы' };
    log.ok(`HUD: «${names[target] || target}» ${data.show ? 'показана' : 'скрыта'}`);
    return true;
  } catch (err) {
    log.error(`Сервер HUD недоступен (${cfg.hud.url}): ${err.cause?.code || err.message}`);
    return false;
  }
}

/** Любое быстрое действие сервера: scene-starting, toggle-hud, ads-play и т.д. */
async function runAction(cfg, name) {
  const url = `${cfg.hud.url.replace(/\/$/, '')}/api/action/${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(3000) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) { log.error(`HUD: действия «${name}» нет. Список: ${cfg.hud.url}/api/actions?all=1`); return false; }
    if (!res.ok) { log.warn(`HUD: ${name} — ${data.error || res.status}`); return false; }
    log.ok(`HUD: ${name}${typeof data.on === 'boolean' ? (data.on ? ' — показано' : ' — скрыто') : ''}`);
    return true;
  } catch (err) {
    log.error(`Сервер HUD недоступен (${cfg.hud.url}): ${err.cause?.code || err.message}`);
    return false;
  }
}

/* ----------------------------------------------------------- запуск */

async function run(binding, obs, cfg) {
  if (binding.scene) return obs.setScene(binding.scene);
  if (binding.hud) return toggleHud(cfg, binding.hud);
  if (binding.action) return runAction(cfg, binding.action);
  return false;
}

async function main() {
  const cfg = loadConfig();

  // uiohook подгружаем только для живого режима: для проверки конфига он не нужен.
  let uiohook = null;
  if (!LIST_SCENES && !NO_HOOK && simulateList.length === 0) {
    try {
      uiohook = require('uiohook-napi');
    } catch (err) {
      log.error(`Не загрузился модуль перехвата клавиатуры (uiohook-napi): ${err.message}`);
      log.error('Выполните npm install в папке agent. Если не помогло — используйте встроенные хоткеи OBS (см. README).');
      process.exit(1);
    }
  }
  const keyNames = KEY_NAMES;
  const bindings = buildBindings(cfg, keyNames);

  const obs = new ObsLink(cfg);

  if (LIST_SCENES) {
    obs.cfg.reconnect.maxSec = 0;
    obs.scheduleReconnect = () => {};
    if (await obs.connect()) {
      console.log('\nСцены в OBS (копируйте имена в config.json точно, с регистром и пробелами):');
      for (const s of obs.scenes) console.log(`  ${s}`);
    }
    await obs.stop();
    process.exit(0);
  }

  if (simulateList.length) {
    const needsObs = simulateList.some((c) => {
      const b = bindings.get(comboId(parseCombo(c, keyNames)));
      return b && b.scene;
    });
    if (needsObs) { obs.scheduleReconnect = () => {}; await obs.connect(); }
    let ok = true;
    for (const text of simulateList) {
      const b = bindings.get(comboId(parseCombo(text, keyNames)));
      if (!b) { log.error(`«${text}» нет в config.json`); ok = false; continue; }
      log.info(`Имитация нажатия ${b.combo.label}`);
      ok = (await run(b, obs, cfg)) && ok;
    }
    await obs.stop();
    process.exit(ok ? 0 : 1);
  }

  console.log('');
  console.log('  Агент хоткеев трансляции');
  console.log('  ─────────────────────────────────────────────');
  for (const b of bindings.values()) {
    const what = b.scene ? `сцена OBS «${b.scene}»` : b.hud ? `плашка HUD: ${b.hud}` : `действие HUD: ${b.action}`;
    console.log(`  ${b.combo.label.padEnd(16)} → ${what}`);
  }
  console.log('');
  console.log('  Окно можно свернуть, но не закрывать. Ctrl+C — выход.');
  console.log('');

  obs.connect().then((ok) => {
    if (!ok) return;
    const missing = [...bindings.values()].filter((b) => b.scene && !obs.scenes.includes(b.scene));
    for (const b of missing) log.warn(`В OBS нет сцены «${b.scene}» (${b.combo.label}). Проверьте имя: npm run scenes`);
  });

  if (NO_HOOK) {
    log.warn('Режим --no-hook: клавиатура не слушается, только связь с OBS');
    process.on('SIGINT', async () => { await obs.stop(); process.exit(0); });
    return;
  }

  const { uIOhook, UiohookKey } = uiohook;
  const codeToName = new Map(Object.entries(UiohookKey).map(([name, code]) => [code, name]));
  const held = new Set();   // чтобы зажатая клавиша не срабатывала повторно по автоповтору

  uIOhook.on('keydown', (e) => {
    if (held.has(e.keycode)) return;
    held.add(e.keycode);
    const key = codeToName.get(e.keycode);
    if (!key) return;
    const id = comboId({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, key });
    const binding = bindings.get(id);
    if (binding) run(binding, obs, cfg);
  });
  uIOhook.on('keyup', (e) => held.delete(e.keycode));

  try {
    uIOhook.start();
    log.ok('Перехват клавиатуры запущен');
  } catch (err) {
    log.error(`Не удалось включить перехват клавиатуры: ${err.message}`);
    process.exit(1);
  }

  const shutdown = async () => {
    log.info('Выключаюсь');
    try { uIOhook.stop(); } catch { /* уже остановлен */ }
    await obs.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
