// Uploaded files.
//   private rooms + friend chats: the browser encrypts the file first, we only ever store ciphertext ('enc')
//   public room + profile pictures: plain images, checked by their actual bytes before we serve them ('img')
// Every file belongs to a scope so it can be cleaned up with whatever it belongs to:
//   'public' (deleted with its message), 'c:XXXX' (deleted when the room burns),
//   'dm:<a>:<b>' (deleted with the message or when you unfriend), 'profile' (replaced = deleted)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, readSession } = require('./auth');
const id = require('./identity');
const rooms = require('./rooms');

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const MB = 1024 * 1024;

const CFG = {
  enabled: process.env.UPLOADS !== '0',
  maxBytes: Math.max(1, num(process.env.UPLOAD_MAX_MB, 10)) * MB,
  profileMaxBytes: 4 * MB,
  storageBytes: Math.max(10, num(process.env.UPLOAD_STORAGE_MB, 2048)) * MB,
  dailyBytes: Math.max(1, num(process.env.UPLOAD_USER_DAILY_MB, 200)) * MB,
  keepMs: Math.max(1, num(process.env.UPLOAD_KEEP_DAYS, 30)) * 86400000,
  publicUploads: ['off', 'members', 'all'].includes(process.env.PUBLIC_UPLOADS) ? process.env.PUBLIC_UPLOADS : 'members',
  unattachedMs: 60 * 60 * 1000, // public/profile uploads that never got used
};

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const ROOM_RE = /^c:[A-HJ-NP-Z2-9]{4}$/;

const dataDir = () => path.dirname(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json'));
let DIR = null;
let META = null;

const files = new Map(); // id -> { id, owner, kind, mime?, size, ts, scope, msg?, exp }
const usage = new Map(); // userId -> [{ ts, size }] over the last day
let total = 0;
let loaded = false;
let isMember = () => false; // realtime plugs this in: (userId, roomKey) => bool

/* ---------------- storage ---------------- */
function save() {
  try {
    fs.writeFileSync(META + '.tmp', JSON.stringify(Array.from(files.values())));
    fs.renameSync(META + '.tmp', META);
  } catch (e) {
    console.error('[files] could not save list:', e.message);
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  DIR = process.env.UPLOAD_DIR || path.join(dataDir(), 'files');
  META = path.join(path.dirname(DIR), 'files.json');
  try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); } catch (e) { console.error('[files] cannot use', DIR, e.message); }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(META, 'utf8')); } catch { /* first run */ }
  if (!Array.isArray(list)) list = [];
  let changed = false;
  for (const r of list) {
    if (!r || !ID_RE.test(r.id) || !Number.isFinite(r.size)) { changed = true; continue; }
    if (!fs.existsSync(path.join(DIR, r.id))) { changed = true; continue; } // blob went missing
    files.set(r.id, r);
    total += r.size;
  }
  // blobs with no record (crash between writing the file and the list): bin them
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!files.has(f)) { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* ignore */ } }
    }
  } catch { /* dir unreadable */ }
  if (changed) save();
}

function drop(fid, { persist = true } = {}) {
  const r = files.get(fid);
  if (!r) return false;
  files.delete(fid);
  total -= r.size;
  try { fs.unlinkSync(path.join(DIR, fid)); } catch { /* already gone */ }
  if (persist) save();
  return true;
}

function dropWhere(test) {
  load();
  let n = 0;
  for (const r of Array.from(files.values())) if (test(r)) { drop(r.id, { persist: false }); n++; }
  if (n) save();
  return n;
}

function sweep() {
  const now = Date.now();
  return dropWhere((r) => r.exp <= now || ((r.scope === 'public' || r.scope === 'profile') && !r.msg && now - r.ts > CFG.unattachedMs));
}

/* ---------------- byte sniffing ---------------- */
function sniffImage(buf) {
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/* ---------------- quotas ---------------- */
function usedToday(userId) {
  const now = Date.now();
  const list = (usage.get(userId) || []).filter((u) => now - u.ts < 86400000);
  usage.set(userId, list);
  return list.reduce((a, u) => a + u.size, 0);
}

/* ---------------- HTTP ---------------- */
const router = express.Router();
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, validate: false,
  keyGenerator: (req) => 'up:' + (req.session ? req.session.sub : 'anon'),
  message: { error: "You're uploading too fast. Wait a few minutes." },
});

const raw = express.raw({ type: () => true, limit: CFG.maxBytes + 1024 });

router.post('/', requireAuth, uploadLimiter, (req, res, next) => {
  if (!CFG.enabled) return res.status(403).json({ error: 'File sharing is turned off on this server.' });
  const len = Number(req.get('content-length'));
  if (Number.isFinite(len) && len > CFG.maxBytes) return res.status(413).json({ error: `Files can be up to ${Math.round(CFG.maxBytes / MB)} MB.` });
  next();
}, (req, res, next) => raw(req, res, (err) => {
  if (err) return res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? `Files can be up to ${Math.round(CFG.maxBytes / MB)} MB.` : 'Upload failed.' });
  next();
}), (req, res) => {
  load();
  const s = req.session;
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!body.length) return res.status(400).json({ error: 'That file is empty.' });
  if (body.length > CFG.maxBytes) return res.status(413).json({ error: `Files can be up to ${Math.round(CFG.maxBytes / MB)} MB.` });

  const scopeKind = String(req.get('x-zent-scope') || '');
  const target = String(req.get('x-zent-target') || '');
  let scope, kind, mime = null, exp = Date.now() + CFG.keepMs;

  if (scopeKind === 'public') {
    if (CFG.publicUploads === 'off') return res.status(403).json({ error: 'Pictures are turned off in #public.' });
    if (CFG.publicUploads === 'members' && s.role !== 'registered') return res.status(403).json({ error: 'Make an account to post pictures in #public.' });
    mime = sniffImage(body);
    if (!mime) return res.status(415).json({ error: 'Only pictures (PNG, JPEG, GIF, WebP) can go in #public.' });
    scope = 'public';
    kind = 'img';
  } else if (scopeKind === 'profile') {
    if (s.role !== 'registered') return res.status(403).json({ error: 'Guests have no profile.' });
    if (body.length > CFG.profileMaxBytes) return res.status(413).json({ error: 'Profile pictures can be up to 4 MB.' });
    mime = sniffImage(body);
    if (!mime) return res.status(415).json({ error: 'Use a PNG, JPEG, GIF or WebP picture.' });
    scope = 'profile';
    kind = 'img';
  } else if (scopeKind === 'room') {
    const room = ROOM_RE.test(target) ? rooms.get(target) : null;
    if (!room || !isMember(s.sub, target)) return res.status(403).json({ error: 'Join the room first.' });
    scope = target;
    kind = 'enc';
    if (room.expiresAt) exp = Math.min(exp, room.expiresAt);
  } else if (scopeKind === 'dm') {
    if (!target || target === s.sub || !id.areFriends(s.sub, target) || !id.areFriends(target, s.sub)) return res.status(403).json({ error: "You're not friends with this person." });
    scope = id.privateRoomName(s.sub, target);
    kind = 'enc';
  } else {
    return res.status(400).json({ error: 'Bad upload.' });
  }

  if (total + body.length > CFG.storageBytes) return res.status(507).json({ error: 'The server is out of space for files right now.' });
  if (usedToday(s.sub) + body.length > CFG.dailyBytes) return res.status(429).json({ error: "You've hit today's upload limit." });

  const fid = crypto.randomBytes(16).toString('base64url');
  try {
    const tmp = path.join(DIR, fid + '.part');
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, path.join(DIR, fid));
  } catch (e) {
    console.error('[files] write failed:', e.message);
    return res.status(500).json({ error: "Couldn't save that file." });
  }
  const rec = { id: fid, owner: s.sub, kind, size: body.length, ts: Date.now(), scope, exp };
  if (mime) rec.mime = mime;
  files.set(fid, rec);
  total += rec.size;
  usage.get(s.sub).push({ ts: Date.now(), size: rec.size });
  save();
  res.status(201).json({ id: fid, size: rec.size, mime });
});

/** GET /files/:id (outside /api so browsers can cache it) */
function serve(req, res) {
  load();
  const fid = req.params.id;
  const r = ID_RE.test(fid) ? files.get(fid) : null;
  if (!r || r.exp <= Date.now()) return res.status(404).json({ error: 'This file is gone.' });
  // profile pictures are public by design; everything else needs a signed-in session
  if (r.scope !== 'profile' && !readSession(req)) return res.status(401).json({ error: 'Not signed in.' });

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (r.kind === 'img') {
    res.set('Content-Type', r.mime);
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', r.scope === 'profile' ? 'public, max-age=604800, immutable' : 'private, max-age=86400');
  } else {
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="encrypted.bin"');
    res.set('Cache-Control', 'private, max-age=86400');
  }
  res.set('Content-Length', String(r.size));
  const stream = fs.createReadStream(path.join(DIR, fid));
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
  stream.pipe(res);
}

/* ---------------- used by realtime / profiles ---------------- */

/** links a public upload to its message. returns the record or an error string */
function attachPublic(fid, owner, msgId) {
  load();
  const r = typeof fid === 'string' ? files.get(fid) : null;
  if (!r || r.owner !== owner || r.scope !== 'public') return { error: 'That picture is gone. Try again.' };
  if (r.msg) return { error: 'That picture was already posted.' };
  r.msg = msgId;
  save();
  return { rec: r };
}

function attachProfile(fid, owner) {
  load();
  const r = typeof fid === 'string' ? files.get(fid) : null;
  if (!r || r.owner !== owner || r.scope !== 'profile') return false;
  r.msg = 'profile';
  r.exp = Number.MAX_SAFE_INTEGER; // profile pictures stay until replaced
  save();
  return true;
}

/** deletes one of your own files in a scope (used when you delete a message) */
function removeOwn(fid, owner, scope) {
  load();
  const r = typeof fid === 'string' ? files.get(fid) : null;
  if (!r || r.owner !== owner || (scope && r.scope !== scope)) return false;
  return drop(fid);
}

const dropScope = (scope) => dropWhere((r) => r.scope === scope);
const dropMsgFiles = (msgIds) => { const set = new Set(msgIds); return dropWhere((r) => r.scope === 'public' && r.msg && set.has(r.msg)); };
const dropOwner = (owner) => dropWhere((r) => r.owner === owner && r.scope === 'profile');
/** after a restart: rooms don't survive, and public pictures whose message is gone go too */
function reconcile(publicIds) {
  return dropWhere((r) => ROOM_RE.test(r.scope) || (r.scope === 'public' && r.msg && !publicIds.has(r.msg)));
}

function stats() {
  load();
  return { count: files.size, bytes: total, cap: CFG.storageBytes };
}

const config = () => ({
  enabled: CFG.enabled,
  maxBytes: CFG.maxBytes,
  publicUploads: CFG.publicUploads,
});

setInterval(() => { if (loaded) sweep(); }, 10 * 60 * 1000).unref();

module.exports = {
  router, serve, attachPublic, attachProfile, removeOwn, dropScope, dropMsgFiles, dropOwner, reconcile,
  stats, config, sweep, sniffImage, get: (fid) => { load(); return files.get(fid) || null; },
  setMembership: (fn) => { isMember = fn; },
  ID_RE,
};
