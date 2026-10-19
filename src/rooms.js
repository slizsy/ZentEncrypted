// In-memory room registry: public, join-code rooms (only a hash of the auth token is kept), DMs.
const crypto = require('crypto');

const PUBLIC = 'public';
const LOCATOR_RE = /^[A-HJ-NP-Z2-9]{4}$/;
const AUTH_RE = /^[0-9a-f]{64}$/;

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const CFG = {
  minTtl: num(process.env.ROOM_MIN_TTL_MS, 5 * 60 * 1000),
  maxTtl: num(process.env.ROOM_MAX_TTL_MS, 7 * 24 * 60 * 60 * 1000),
  defaultTtl: num(process.env.ROOM_DEFAULT_TTL_MS, 24 * 60 * 60 * 1000),
  maxPerUser: num(process.env.MAX_ROOMS_PER_USER, 5),
  maxTotal: num(process.env.MAX_ROOMS_TOTAL, 500),
  emptyGraceMs: num(process.env.ROOM_EMPTY_GRACE_MS, 30 * 1000),
  failLimit: 20,
  failWindowMs: 10 * 60 * 1000,
  lockMs: 10 * 60 * 1000,
};

const rooms = new Map();
rooms.set(PUBLIC, { key: PUBLIC, type: 'public', name: 'public', members: new Set(), expiresAt: null });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function cleanName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '') // control + bidi tricks
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

function info(room) {
  return { key: room.key, type: room.type, name: room.name, expiresAt: room.expiresAt || null, count: room.members.size };
}

function get(key) {
  return rooms.get(key);
}

function createCodeRoom({ locator, name, auth, ownerId, ttlMs, burnWhenEmpty }) {
  if (!LOCATOR_RE.test(String(locator))) return { ok: false, error: 'Bad room code.' };
  if (!AUTH_RE.test(String(auth))) return { ok: false, error: 'Bad room code.' };
  const key = `c:${locator}`;
  if (rooms.has(key)) return { ok: false, error: 'taken' };
  if (rooms.size >= CFG.maxTotal) return { ok: false, error: 'The server is full of rooms right now. Try again later.' };

  let mine = 0;
  for (const r of rooms.values()) if (r.ownerId && r.ownerId === ownerId) mine += 1;
  if (mine >= CFG.maxPerUser) return { ok: false, error: `You can have ${CFG.maxPerUser} active rooms at a time.` };

  const label = cleanName(name);
  if (!label) return { ok: false, error: 'Give the room a name.' };

  let ttl = Number(ttlMs);
  if (!Number.isFinite(ttl)) ttl = CFG.defaultTtl;
  ttl = Math.min(CFG.maxTtl, Math.max(CFG.minTtl, ttl));

  const room = {
    key,
    type: 'code',
    name: label,
    members: new Set(),
    ownerId,
    authHash: sha256(auth),
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    burnWhenEmpty: !!burnWhenEmpty,
    emptySince: Date.now(),
    fails: [],
    lockedUntil: 0,
  };
  rooms.set(key, room);
  return { ok: true, room };
}

/** Same generic error for "no such room" and "wrong code" on purpose. */
function verifyJoin(locator, auth) {
  const generic = { ok: false, error: "That code didn't work." };
  if (!LOCATOR_RE.test(String(locator)) || !AUTH_RE.test(String(auth))) return generic;
  const room = rooms.get(`c:${locator}`);
  if (!room) return generic;
  const now = Date.now();
  if (room.lockedUntil > now) return { ok: false, error: 'Too many wrong codes. This room is locked for a few minutes.' };

  const good = crypto.timingSafeEqual(sha256(auth), room.authHash);
  if (!good) {
    room.fails = room.fails.filter((t) => now - t < CFG.failWindowMs);
    room.fails.push(now);
    if (room.fails.length >= CFG.failLimit) {
      room.lockedUntil = now + CFG.lockMs;
      room.fails = [];
    }
    return generic;
  }
  return { ok: true, room };
}

function ensureDm(key) {
  let r = rooms.get(key);
  if (!r) {
    r = { key, type: 'dm', name: 'direct', members: new Set(), expiresAt: null };
    rooms.set(key, r);
  }
  return r;
}

function join(key, socketId) {
  const r = rooms.get(key);
  if (!r) return null;
  r.members.add(socketId);
  r.emptySince = null;
  return r;
}

function leave(key, socketId) {
  const r = rooms.get(key);
  if (!r) return null;
  r.members.delete(socketId);
  if (r.members.size === 0) {
    if (r.type === 'dm') rooms.delete(key);
    else if (r.type === 'code') r.emptySince = Date.now();
  }
  return r;
}

function leaveAll(socketId) {
  const touched = [];
  for (const key of Array.from(rooms.keys())) {
    const r = rooms.get(key);
    if (r.members.has(socketId)) {
      leave(key, socketId);
      touched.push(key);
    }
  }
  return touched;
}

function destroy(key) {
  rooms.delete(key);
}

/** Returns rooms that just ran out of time (or emptied out if set to burn). */
function expireDue(now = Date.now()) {
  const gone = [];
  for (const r of Array.from(rooms.values())) {
    if (r.type !== 'code') continue;
    if (r.expiresAt <= now) gone.push({ room: r, reason: 'expired' });
    else if (r.burnWhenEmpty && r.members.size === 0 && r.emptySince && now - r.emptySince > CFG.emptyGraceMs) {
      gone.push({ room: r, reason: 'empty' });
    }
  }
  for (const g of gone) rooms.delete(g.room.key);
  return gone;
}

/** counts for the admin page: how many join-code rooms exist and how many connections are in them */
function summary() {
  let active = 0, inRooms = 0;
  for (const r of rooms.values()) if (r.type === 'code') { active++; inRooms += r.members.size; }
  return { active, inRooms };
}

module.exports = {
  PUBLIC, CFG, LOCATOR_RE, get, info, createCodeRoom, verifyJoin, ensureDm,
  join, leave, leaveAll, destroy, expireDue, cleanName, summary,
};
