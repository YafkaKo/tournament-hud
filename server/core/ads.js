/**
 * Реклама в паузе.
 *
 * Ролики и переходы (stinger) лежат в public/assets/ads/, их список — в state.ads.
 * Запуск: сервер отправляет оверлеям команду 'ads' (play / stop / skip), а основной
 * оверлей (тот, что в OBS: overlay.html?obs=1) проигрывает
 *     переход → ролик → (переход → ролик …) → переход → возврат к эфиру
 * и сообщает серверу, что происходит: фаза, позиция, конец, ошибка.
 * Если основного оверлея нет — запуск не выполняется, пульт получает ошибку.
 *
 * Загрузка файлов — потоком прямо в файл (без base64 и без JSON): сервер
 * не держит гигабайтный ролик в памяти.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeBase } = require('./util');

const VIDEO = {
  'video/mp4': { ext: '.mp4', magic: (b) => b.slice(4, 8).toString() === 'ftyp' },
  'video/webm': { ext: '.webm', magic: (b) => b.slice(0, 4).toString('hex') === '1a45dfa3' },
  'video/quicktime': { ext: '.mov', magic: (b) => b.slice(4, 8).toString() === 'ftyp' || b.slice(4, 8).toString() === 'moov' }
};
const KINDS = { clip: 'clips', transition: 'transitions' };

function createAds({ root, config, state, hub, change, onUpdate }) {
  const DIR = path.join(root, 'public', 'assets', 'ads');
  const SUB = { clip: path.join(DIR, 'clips'), transition: path.join(DIR, 'transitions') };
  const MAX = Math.max(10, Number(config.ads?.maxUploadMb) || 1024) * 1024 * 1024;

  // Что сейчас играет. Живёт только в памяти: после перезапуска сервера реклама не идёт.
  let play = idle();
  let session = 0;
  let watchdog = null;

  function idle() {
    return { status: 'idle', session: 0, items: [], index: 0, phase: '', position: 0, duration: 0, error: '', startedAt: 0 };
  }

  const ads = () => state.s.ads;
  const urlOf = (kind, file) => `/assets/ads/${kind === 'clip' ? 'clips' : 'transitions'}/${encodeURIComponent(file)}`;

  function mainOverlays() {
    return hub.clients((ws) => ws.main);
  }

  function publicState() {
    const item = play.items[play.index];
    return {
      status: play.status,
      phase: play.phase,
      index: play.index,
      total: play.items.length,
      current: item ? item.name : '',
      position: play.position,
      duration: play.duration,
      error: play.error,
      mainConnected: mainOverlays().length > 0
    };
  }

  // ---------------------------------------------------------------- воспроизведение

  function transitionFor(clip) {
    const a = ads();
    const id = clip.transition === 'none' ? '' : (clip.transition || a.defaultTransition);
    const t = a.transitions.find((x) => x.id === id) || (clip.transition ? null : a.transitions[0]);
    if (!t || clip.transition === 'none') return null;
    return { url: urlOf('transition', t.file), cutMs: Math.max(0, Number(t.cutMs) || 0), volume: vol(t.volume) };
  }

  function vol(v) { return Math.max(0, Math.min(100, Number(v ?? 100))); }

  function start(ids) {
    const a = ads();
    const list = (ids && ids.length ? ids : a.queue).map((id) => a.clips.find((c) => c.id === id)).filter(Boolean);
    if (!list.length) return { error: 'Очередь пуста — добавьте ролики в очередь' };
    if (!mainOverlays().length) return { error: 'Основной оверлей не подключён: в OBS должен быть открыт overlay.html?obs=1' };
    if (play.status === 'playing') return { error: 'Реклама уже идёт' };

    session += 1;
    play = {
      ...idle(),
      status: 'playing',
      session,
      phase: 'in',
      startedAt: Date.now(),
      items: list.map((c) => ({
        id: c.id,
        name: c.name,
        url: urlOf('clip', c.file),
        volume: vol(c.volume),
        duration: Number(c.duration) || 0,
        transition: transitionFor(c)
      }))
    };
    hub.broadcast('ads', { cmd: 'play', session, items: play.items, between: a.between || 'transition' });
    console.log(`[ads] запуск: ${play.items.map((i) => i.name).join(', ')}`);
    armWatchdog();
    onUpdate();
    return { ok: true, total: play.items.length };
  }

  function stop() {
    if (play.status !== 'playing') return { error: 'Реклама сейчас не идёт' };
    hub.broadcast('ads', { cmd: 'stop', session: play.session });
    play.phase = 'out';
    onUpdate();
    return { ok: true };
  }

  function skip() {
    if (play.status !== 'playing') return { error: 'Реклама сейчас не идёт' };
    hub.broadcast('ads', { cmd: 'skip', session: play.session });
    return { ok: true };
  }

  function finish(error) {
    clearTimeout(watchdog);
    const err = error || '';
    play = { ...idle(), error: err };
    hub.broadcast('ads', { cmd: 'idle', session });
    if (err) console.warn('[ads]', err);
    onUpdate();
  }

  // Страховка: если основной оверлей пропал посреди рекламы (закрыли OBS),
  // через запас по времени считаем показ законченным, чтобы пульт не завис в «идёт».
  function armWatchdog() {
    clearTimeout(watchdog);
    const total = play.items.reduce((s, i) => s + (i.duration || 120) + 10, 0);
    watchdog = setTimeout(() => {
      if (play.status === 'playing') finish('Оверлей не сообщил о конце рекламы — показ сброшен');
    }, Math.max(30, total) * 1000);
  }

  function onMessage(ws, msg) {
    if (!ws.main || !msg || typeof msg.type !== 'string' || !msg.type.startsWith('ads-')) return;
    if (msg.session !== play.session || play.status !== 'playing') return;
    if (msg.type === 'ads-progress') {
      play.index = Math.max(0, Math.min(play.items.length - 1, Number(msg.index) || 0));
      play.phase = String(msg.phase || '');
      play.position = Number(msg.position) || 0;
      play.duration = Number(msg.duration) || play.items[play.index]?.duration || 0;
      onUpdate();
    } else if (msg.type === 'ads-error') {
      play.error = `Ролик «${play.items[msg.index]?.name || '?'}» не воспроизвёлся: ${msg.message || 'ошибка'}`;
      console.warn('[ads]', play.error);
      onUpdate();
    } else if (msg.type === 'ads-done') {
      finish(play.error);
    }
  }

  function onConnect(ws) {
    if (play.status === 'playing' && !ws.main) return;
    hub.send(ws, 'ads', { cmd: 'idle', session });
  }

  // ---------------------------------------------------------------- файлы

  function list(kind) {
    return ads()[KINDS[kind]];
  }

  function routes(app, express) {
    app.get('/api/ads', (req, res) => {
      const a = ads();
      const decorate = (kind) => (x) => ({ ...x, url: urlOf(kind, x.file), poster: x.poster ? `/assets/ads/posters/${encodeURIComponent(x.poster)}` : '' });
      res.json({
        clips: a.clips.map(decorate('clip')),
        transitions: a.transitions.map(decorate('transition')),
        queue: a.queue,
        between: a.between,
        defaultTransition: a.defaultTransition,
        play: publicState(),
        maxUploadMb: Math.round(MAX / 1024 / 1024)
      });
    });

    // Загрузка: тело запроса — сам файл; имя — в X-File-Name. Пишем потоком.
    app.post('/api/ads/upload/:kind', (req, res) => {
      const kind = req.params.kind;
      if (!KINDS[kind]) return res.status(400).json({ error: 'kind: clip или transition' });
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      const v = VIDEO[type];
      if (!v) return res.status(415).json({ error: 'Подходят MP4 (H.264) и WebM. MOV лучше перекодировать — см. README.' });
      const len = Number(req.headers['content-length'] || 0);
      if (len > MAX) return res.status(413).json({ error: `Файл больше ${Math.round(MAX / 1024 / 1024)} МБ` });

      const original = decodeURIComponent(String(req.headers['x-file-name'] || 'video'));
      const id = crypto.randomBytes(5).toString('hex');
      const file = `${Date.now()}-${safeBase(original, 'video')}${v.ext}`;
      fs.mkdirSync(SUB[kind], { recursive: true });
      const target = path.join(SUB[kind], file);
      const tmp = target + '.part';
      const out = fs.createWriteStream(tmp);
      let size = 0;
      let head = Buffer.alloc(0);
      let failed = false;

      const fail = (code, error) => {
        if (failed) return;
        failed = true;
        out.destroy();
        fs.rm(tmp, { force: true }, () => {});
        if (!res.headersSent) res.status(code).json({ error });
      };

      req.on('data', (chunk) => {
        size += chunk.length;
        if (head.length < 16) head = Buffer.concat([head, chunk.slice(0, 16)]);
        if (size > MAX) { fail(413, `Файл больше ${Math.round(MAX / 1024 / 1024)} МБ`); req.destroy(); }
      });
      req.on('aborted', () => fail(400, 'Загрузка прервана'));
      out.on('error', (err) => fail(500, 'Не удалось сохранить файл: ' + err.message));
      out.on('finish', () => {
        if (failed) return;
        if (!size) return fail(400, 'Файл пустой');
        if (!v.magic(head)) return fail(415, 'Содержимое файла не похоже на ' + v.ext.slice(1).toUpperCase());
        fs.renameSync(tmp, target);
        const name = original.replace(/\.[^.]+$/, '').slice(0, 60) || 'Ролик';
        const item = kind === 'clip'
          ? { id, file, name, duration: 0, poster: '', transition: '', volume: 100, size }
          : { id, file, name, cutMs: 500, volume: 100, size };
        change(() => {
          const a = ads();
          a[KINDS[kind]] = [...a[KINDS[kind]], item];
          if (kind === 'transition' && !a.defaultTransition) a.defaultTransition = id;
          if (kind === 'clip') a.queue = [...a.queue, id];
        });
        console.log(`[ads] загружен ${kind === 'clip' ? 'ролик' : 'переход'} ${file} (${Math.round(size / 1024 / 1024)} МБ)`);
        res.json({ ...item, url: urlOf(kind, file) });
      });
      req.pipe(out);
    });

    // Свойства: name, duration, cutMs, volume, transition
    app.patch('/api/ads/:kind/:id', (req, res) => {
      const kind = req.params.kind;
      if (!KINDS[kind]) return res.status(400).json({ error: 'kind: clip или transition' });
      const allowed = kind === 'clip' ? ['name', 'duration', 'transition', 'volume'] : ['name', 'cutMs', 'volume', 'duration'];
      let found = null;
      change(() => {
        const arr = list(kind);
        const i = arr.findIndex((x) => x.id === req.params.id);
        if (i < 0) return;
        const next = { ...arr[i] };
        for (const k of allowed) if (req.body && req.body[k] !== undefined) next[k] = req.body[k];
        if (typeof next.name === 'string') next.name = next.name.slice(0, 60);
        arr[i] = found = next;
      });
      if (!found) return res.status(404).json({ error: 'Нет такого файла' });
      res.json(found);
    });

    // Превью-кадр: пульт снимает кадр в браузере и присылает JPEG.
    app.post('/api/ads/clip/:id/poster', express.raw({ type: 'image/jpeg', limit: '2mb' }), (req, res) => {
      const clip = ads().clips.find((c) => c.id === req.params.id);
      if (!clip) return res.status(404).json({ error: 'Нет такого ролика' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Пустой кадр' });
      const dir = path.join(DIR, 'posters');
      fs.mkdirSync(dir, { recursive: true });
      const file = `${clip.id}.jpg`;
      fs.writeFileSync(path.join(dir, file), req.body);
      change(() => { const c = ads().clips.find((x) => x.id === clip.id); if (c) c.poster = file; });
      res.json({ poster: `/assets/ads/posters/${file}` });
    });

    app.delete('/api/ads/:kind/:id', (req, res) => {
      const kind = req.params.kind;
      if (!KINDS[kind]) return res.status(400).json({ error: 'kind: clip или transition' });
      const item = list(kind).find((x) => x.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'Файла уже нет' });
      if (play.status === 'playing' && play.items.some((i) => i.id === item.id)) return res.status(409).json({ error: 'Этот ролик сейчас в эфире' });
      fs.rm(path.join(SUB[kind], item.file), { force: true }, () => {});
      if (item.poster) fs.rm(path.join(DIR, 'posters', item.poster), { force: true }, () => {});
      change(() => {
        const a = ads();
        a[KINDS[kind]] = a[KINDS[kind]].filter((x) => x.id !== item.id);
        if (kind === 'clip') a.queue = a.queue.filter((id) => id !== item.id);
        if (kind === 'transition') {
          if (a.defaultTransition === item.id) a.defaultTransition = a.transitions[0]?.id || '';
          for (const c of a.clips) if (c.transition === item.id) c.transition = '';
        }
      });
      res.json({ ok: true });
    });

    // Очередь и настройки: { queue: [id…], between, defaultTransition }
    app.post('/api/ads/settings', (req, res) => {
      const b = req.body || {};
      change(() => {
        const a = ads();
        if (Array.isArray(b.queue)) a.queue = b.queue.filter((id) => a.clips.some((c) => c.id === id));
        if (b.between === 'transition' || b.between === 'cut') a.between = b.between;
        if (typeof b.defaultTransition === 'string') a.defaultTransition = b.defaultTransition;
      });
      res.json({ ok: true });
    });

    // Запуск: { ids: [...] } — эти ролики, без тела — очередь.
    app.post('/api/ads/play', (req, res) => {
      const out = start(req.body && req.body.ids);
      res.status(out.error ? 409 : 200).json(out);
    });
    app.post('/api/ads/stop', (req, res) => { const out = stop(); res.status(out.error ? 409 : 200).json(out); });
    app.post('/api/ads/skip', (req, res) => { const out = skip(); res.status(out.error ? 409 : 200).json(out); });
  }

  return {
    routes,
    onMessage,
    onConnect,
    publicState,
    play: () => start(),
    stop,
    skip
  };
}

module.exports = { createAds };
