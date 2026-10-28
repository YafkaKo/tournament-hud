/**
 * Фоны заставок: загрузка картинок и видео (до 20 МБ) в public/assets/backgrounds.
 * Фон общий для обеих игр.
 */

const fs = require('fs');
const path = require('path');
const { safeBase } = require('./util');

const BG_MAX = 20 * 1024 * 1024;
const BG_TYPES = {
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xFF && b[1] === 0xD8 },
  'image/png':  { ext: '.png', magic: (b) => b.slice(0, 4).toString('hex') === '89504e47' },
  'image/webp': { ext: '.webp', magic: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  'video/mp4':  { ext: '.mp4', magic: (b) => b.slice(4, 8).toString() === 'ftyp' },
  'video/webm': { ext: '.webm', magic: (b) => b.slice(0, 4).toString('hex') === '1a45dfa3' }
};

function backgroundRoutes(app, express, { root, state, change }) {
  const BG_DIR = path.join(root, 'public', 'assets', 'backgrounds');

  // Тело запроса — сам файл, имя — в заголовке X-File-Name.
  app.post('/api/backgrounds',
    express.raw({ type: Object.keys(BG_TYPES), limit: BG_MAX }),
    (req, res) => {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      const kind = BG_TYPES[type];
      if (!kind) return res.status(415).json({ error: 'Подходят только JPG, PNG, WebP, MP4 и WebM' });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Файл пустой' });
      if (!kind.magic(req.body)) return res.status(415).json({ error: 'Содержимое файла не похоже на ' + kind.ext.slice(1).toUpperCase() });

      const original = decodeURIComponent(String(req.headers['x-file-name'] || 'фон'));
      const name = `${Date.now()}-${safeBase(original, 'background')}${kind.ext}`;
      fs.mkdirSync(BG_DIR, { recursive: true });
      fs.writeFileSync(path.join(BG_DIR, name), req.body);
      console.log(`[background] загружен ${name} (${Math.round(req.body.length / 1024)} КБ)`);
      res.json({ url: `/assets/backgrounds/${encodeURIComponent(name)}`, name, size: req.body.length });
    });

  app.get('/api/backgrounds', (req, res) => {
    let files = [];
    try {
      files = fs.readdirSync(BG_DIR)
        .filter((f) => /\.(jpe?g|png|webp|gif|svg|mp4|webm)$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(BG_DIR, f));
          return { name: f, url: `/assets/backgrounds/${encodeURIComponent(f)}`, size: st.size, at: st.mtimeMs };
        })
        .sort((a, b) => b.at - a.at);
    } catch { /* папки ещё нет */ }
    res.json(files);
  });

  app.delete('/api/backgrounds/:name', (req, res) => {
    const name = path.basename(req.params.name);
    const file = path.join(BG_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Файла уже нет' });
    fs.unlinkSync(file);

    // Если удалённый файл где-то стоял фоном — возвращаем стандартный.
    const urls = new Set([`/assets/backgrounds/${encodeURIComponent(name)}`, `/assets/backgrounds/${name}`]);
    change(() => {
      const bg = state.s.shared.background;
      if (urls.has(bg.all)) bg.all = '';
      for (const k of Object.keys(bg.scenes)) if (urls.has(bg.scenes[k])) bg.scenes[k] = '';
    });
    res.json({ ok: true });
  });
}

module.exports = { backgroundRoutes };
