// Counts for the admin page. Only numbers are kept here: never message text, names or IPs.
// The admin page is off unless ADMIN_PASSWORD is set in .env (12+ characters).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { parse: parseCookies } = require('cookie');
const db = require('../config/database');
const shield = require('./shield');
const { JWT_SECRET } = require('./auth');
const { fromRequest, keyFor } = require('./clientIp');

const KEEP_DAYS = 60;
const ADMIN_PW = process.env.ADMIN_PASSWORD || '';
const adminOn = () => ADMIN_PW.length >= 12;
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

/* ---------------- admin login ---------------- */
const COOKIE = 'zadmin';
// changing ADMIN_PASSWORD in .env signs out every admin session
const pwTag = () => crypto.createHash('sha256').update('zent-admin:' + ADMIN_PW).digest('hex').slice(0, 16);

function isAdmin(req) {
  if (!adminOn()) return false;
  const token = parseCookies(req.headers.cookie || '')[COOKIE];
  if (!token) return false;
  try {
    const c = jwt.verify(token, JWT_SECRET);
    return c.role === 'admin' && c.tag === pwTag();
  } catch { return false; }
}

const router = express.Router();
router.use((req, res, next) => {
  if (!adminOn()) return res.status(404).json({ error: 'The admin page is turned off. Set ADMIN_PASSWORD in .env to use it.', off: true });
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: (req) => 'adm:' + keyFor(fromRequest(req)), message: { error: 'Too many tries. Wait 15 minutes.' } });

router.post('/login', shield.guard({ account: () => 'admin' }), loginLimiter, (req, res) => {
  const pw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  const a = crypto.createHash('sha256').update(pw.slice(0, 500)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PW).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    shield.noteFail(req, 'admin');
    return res.status(401).json({ error: 'Wrong password.' });
  }
  shield.noteSuccess(req, 'admin');
  const token = jwt.sign({ role: 'admin', tag: pwTag() }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: !!req.secure, path: '/api/admin', maxAge: 12 * 3600 * 1000 });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: !!req.secure, path: '/api/admin' });
  res.json({ ok: true });
});

router.get('/stats', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Sign in first.' });
  res.json(snapshot());
});

module.exports = {
  router, count, notePeak, snapshot, flush,
  setLive: (fn) => { live = fn; },
  setExtra: (fn) => { extra = fn; },
  close: () => { dirty = true; flush(); },
};
