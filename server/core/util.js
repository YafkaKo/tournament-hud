/** Мелкие общие функции сервера. */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Глубокая склейка: объекты сливаются, массивы и простые значения заменяются. */
function mergeDeep(target, patch) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeDeep(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Сначала во временный файл, потом переименование: при сбое посреди записи
    // старый файл останется целым.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[data] не удалось сохранить', path.basename(file) + ':', err.message);
    return false;
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** Безопасное имя файла из того, что прислал пользователь. */
function safeBase(name, fallback = 'file') {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || fallback;
}

module.exports = { mergeDeep, readJson, writeJson, lanAddresses, safeBase };
