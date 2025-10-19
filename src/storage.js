const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INVITE_CACHE_PATH = path.join(DATA_DIR, 'invites.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');

async function ensureFiles() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const defaults = [
    [INVITE_CACHE_PATH, {}],
    [CONFIG_PATH, {}],
    [STATS_PATH, {}],
  ];
  for (const [p, defVal] of defaults) {
    try { await fsp.access(p); }
    catch { await fsp.writeFile(p, JSON.stringify(defVal, null, 2), 'utf8'); }
  }
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return {}; }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

module.exports = {
  paths: { DATA_DIR, INVITE_CACHE_PATH, CONFIG_PATH, STATS_PATH },
  ensureFiles,
  readJSON,
  writeJSON,
};
