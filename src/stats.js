// Counts for the admin page. Only numbers are kept here: never message text, names or IPs.
// Who may see them is decided by roles (src/staff.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../config/database');

const KEEP_DAYS = 60;
const started = Date.now();
const version = require('../package.json').version;

/* ---------------- daily counters ---------------- */
let file = null;
let days = {}; // 'YYYY-MM-DD' -> { pub, room, dm, peak }
let dirty = false;
let loaded = false;

const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function load() {
  if (loaded) return;
  loaded = true;
  file = path.join(path.dirname(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json')), 'stats.json');
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && typeof d.days === 'object') days = d.days;
  } catch { /* first run */ }
}

function flush() {
  if (!dirty || !file) return;
  dirty = false;
  const cutoff = today(Date.now() - KEEP_DAYS * 86400000);
  for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify({ days }));
    fs.renameSync(file + '.tmp', file);
  } catch (e) { console.error('[stats] could not save:', e.message); }
}
setInterval(flush, 30000).unref();

function bucket() {
  load();
  const k = today();
  return days[k] || (days[k] = { pub: 0, room: 0, dm: 0, peak: 0 });
}

/** type: 'pub' | 'room' | 'dm' */
function count(type) {
  const b = bucket();
  if (type in b) { b[type]++; dirty = true; }
}

function notePeak(n) {
  const b = bucket();
  if (n > b.peak) { b.peak = n; dirty = true; }
}

/* ---------------- what the page shows ---------------- */
let live = () => ({}); // realtime plugs in who's online, rooms, etc.
let extra = () => ({}); // stored-data counts from other modules

function cpuTemp() {
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    const c = Number(raw) / 1000;
    return Number.isFinite(c) && c > 0 && c < 150 ? Math.round(c * 10) / 10 : null;
  } catch { return null; }
}

function disk() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(path.dirname(file || '.'));
    const gb = (n) => Math.round((n * s.bsize) / 1e8) / 10;
    return { freeGB: gb(s.bavail), totalGB: gb(s.blocks) };
  } catch { return null; }
}

function snapshot() {
  load();
  const now = Date.now();
  const users = db.get('users').value();
  const since = (ms) => users.filter((u) => u.createdAt && now - Date.parse(u.createdAt) < ms).length;
  const startOfToday = Date.parse(today() + 'T00:00:00.000Z');
  const L = live() || {};
  if (Number.isFinite(L.online)) notePeak(L.online);

  const series = [];
  for (let i = 13; i >= 0; i--) {
    const k = today(now - i * 86400000);
    const d = days[k] || { pub: 0, room: 0, dm: 0, peak: 0 };
    const signups = users.filter((u) => String(u.createdAt || '').slice(0, 10) === k).length;
    series.push({ date: k, pub: d.pub, room: d.room, dm: d.dm, peak: d.peak, signups });
  }
  const mem = process.memoryUsage();
  return {
    version,
    now,
    uptimeSec: Math.round((now - started) / 1000),
    people: {
      online: L.online || 0,
      members: L.members || 0,
      guests: L.guests || 0,
      connections: L.connections || 0,
      peakToday: (days[today()] || {}).peak || 0,
    },
    accounts: {
      total: users.length,
      today: users.filter((u) => u.createdAt && Date.parse(u.createdAt) >= startOfToday).length,
      week: since(7 * 86400000),
      month: since(30 * 86400000),
    },
    rooms: { active: L.rooms || 0, inRooms: L.inRooms || 0 },
    days: series,
    stored: extra() || {},
    server: {
      rssMB: Math.round(mem.rss / 1048576),
      heapMB: Math.round(mem.heapUsed / 1048576),
      load: os.loadavg().map((x) => Math.round(x * 100) / 100),
      cpus: os.cpus().length,
      memFreeMB: Math.round(os.freemem() / 1048576),
      memTotalMB: Math.round(os.totalmem() / 1048576),
      cpuTempC: cpuTemp(),
      disk: disk(),
      node: process.version,
      systemUptimeSec: Math.round(os.uptime()),
    },
  };
}

module.exports = {
  count, notePeak, snapshot, flush,
  setLive: (fn) => { live = fn; },
  setExtra: (fn) => { extra = fn; },
  close: () => { dirty = true; flush(); },
};
