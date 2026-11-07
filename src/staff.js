// Roles and moderation.
//   owner  > admin > mod > member > guest
//   mod:   delete any #public message, mute, kick, see + handle reports, see who's online
//   admin: everything a mod can do, plus ban, sign people out, wipe someone's #public messages,
//          change #public settings, make/remove mods, see the stats page and the audit log
//   owner: everything, plus make/remove admins and delete accounts
// Nobody here can read private rooms or friend chats: those are encrypted in the browser.
// A report only ever contains private text if the person reporting chose to include their own copy.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const bus = require('./bus');
const guestRegistry = require('./guestRegistry');
const history = require('./history');
const stats = require('./stats');
const { requireAuth, readSession, JWT_SECRET } = require('./auth');
const { uidFor } = require('./uid');
const { cleanLine, cleanBlock } = require('./text');
const { fromRequest, keyFor } = require('./clientIp');

const RANKS = ['guest', 'member', 'mod', 'admin', 'owner'];
const LEVEL = Object.fromEntries(RANKS.map((r, i) => [r, i]));
const STAFF = ['mod', 'admin', 'owner'];
const REASONS = ['spam', 'harassment', 'nsfw', 'illegal', 'other'];
const GUEST_BLOCK_MS = 24 * 3600 * 1000;
// blocked networks are kept as a keyed hash, never as the IP address itself
const netHash = (netKey) => crypto.createHmac('sha256', JWT_SECRET).update('net:' + netKey).digest('hex').slice(0, 24);

/* ---------------- storage: data/moderation.json ---------------- */
let file = null;
let state = null;
const DEFAULT_SETTINGS = { slowModeSec: 0, publicPosting: 'all', announcement: '' };

function load() {
  if (state) return state;
  file = path.join(path.dirname(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json')), 'moderation.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  state = {
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    mutes: raw.mutes && typeof raw.mutes === 'object' ? raw.mutes : {},
    netBans: raw.netBans && typeof raw.netBans === 'object' ? raw.netBans : {},
    reports: Array.isArray(raw.reports) ? raw.reports : [],
    audit: Array.isArray(raw.audit) ? raw.audit : [],
  };
  return state;
}

function save() {
  const s = load();
  const now = Date.now();
  for (const [k, until] of Object.entries(s.mutes)) if (until <= now) delete s.mutes[k];
  for (const [k, b] of Object.entries(s.netBans)) if (b.until <= now) delete s.netBans[k];
  if (s.audit.length > 2000) s.audit = s.audit.slice(-2000);
  if (s.reports.length > 1000) {
    const open = s.reports.filter((r) => r.status === 'open');
    const done = s.reports.filter((r) => r.status !== 'open');
    s.reports = open.concat(done.slice(-Math.max(0, 1000 - open.length))).sort((a, b) => a.at - b.at);
  }
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(s));
    fs.renameSync(file + '.tmp', file);
  } catch (e) { console.error('[staff] could not save:', e.message); }
}

/* ---------------- who is who ---------------- */
const users = () => db.get('users');
const findUser = (uid) => users().find({ id: uid }).value();
const findByName = (name) => users().find({ usernameLower: String(name).toLowerCase() }).value();

function rankOf(userId) {
  if (!userId) return 'guest';
  const u = findUser(userId);
  if (!u) return 'guest';
  return STAFF.includes(u.rank) ? u.rank : 'member';
}
const level = (userId) => LEVEL[rankOf(userId)];
const isStaff = (userId) => level(userId) >= LEVEL.mod;
/** the badge shown next to a name in chat */
const badge = (userId) => { const r = rankOf(userId); return STAFF.includes(r) ? r : undefined; };

const can = (userId, what) => {
  const l = level(userId);
  switch (what) {
    case 'moderate': return l >= LEVEL.mod;
    case 'ban': case 'signout': case 'purge': case 'settings': case 'audit': case 'stats': case 'set-mod': return l >= LEVEL.admin;
    case 'set-admin': case 'delete-account': return l >= LEVEL.owner;
    default: return false;
  }
};

/** OWNER_USERNAME in .env decides the owner. Without it, the oldest account is the owner. */
function ensureOwner() {
  const all = users().value();
  if (!all.length) return null;
  const want = (process.env.OWNER_USERNAME || '').trim().toLowerCase();
  if (want) {
    const u = all.find((x) => x.usernameLower === want);
    if (!u) { console.warn(`[staff] OWNER_USERNAME "${want}" doesn't match any account yet.`); return null; }
    if (u.rank !== 'owner') {
      users().find({ id: u.id }).assign({ rank: 'owner' }).write();
      console.log(`[staff] ${u.username} is the owner (from OWNER_USERNAME).`);
    }
    return u.username;
  }
  const owner = all.find((x) => x.rank === 'owner');
  if (owner) return owner.username;
  const first = all.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
  users().find({ id: first.id }).assign({ rank: 'owner' }).write();
  console.log(`[staff] ${first.username} is the owner (oldest account). Set OWNER_USERNAME in .env to choose someone else.`);
  return first.username;
}
bus.on('user:registered', () => ensureOwner());

/* ---------------- live info from realtime ---------------- */
let live = () => []; // [{ id, username, role, uid, netKey }]
const online = () => { try { return live() || []; } catch { return []; } };
const onlineIds = () => new Set(online().map((p) => p.id));

/** finds a person (account or guest that's online) from the short id shown on messages */
function byUid(uid) {
  if (typeof uid !== 'string' || !/^[0-9a-f]{10}$/.test(uid)) return null;
  const p = online().find((x) => x.uid === uid);
  if (p) return { id: p.id, username: p.username, guest: p.role === 'guest' };
  const u = users().value().find((x) => uidFor(x.id) === uid);
  return u ? { id: u.id, username: u.username, guest: false } : null;
}

function describe(id) {
  const u = findUser(id);
  if (u) return { id, username: u.username, guest: false };
  const g = guestRegistry.get(id);
  if (g) return { id, username: g.username, guest: true };
  const p = online().find((x) => x.id === id);
  return p ? { id, username: p.username, guest: p.role === 'guest' } : null;
}

/* ---------------- #public rules ---------------- */
const lastPost = new Map(); // userId -> ms
function mutedUntil(userId) {
  const until = load().mutes[userId];
  return until && until > Date.now() ? until : 0;
}
/** null if they may post in #public right now, otherwise the reason */
function publicGate(userId, role) {
  if (isStaff(userId)) return null;
  const s = load().settings;
  const m = mutedUntil(userId);
  if (m) return `You're muted in #public for ${Math.max(1, Math.ceil((m - Date.now()) / 60000))} more minute${Math.ceil((m - Date.now()) / 60000) === 1 ? '' : 's'}.`;
  if (s.publicPosting === 'staff') return '#public is read-only right now.';
  if (s.publicPosting === 'members' && role === 'guest') return 'Only accounts can post in #public right now. Guests can still use private rooms.';
  if (s.slowModeSec > 0) {
    const wait = (lastPost.get(userId) || 0) + s.slowModeSec * 1000 - Date.now();
    if (wait > 0) return `Slow mode is on. Wait ${Math.ceil(wait / 1000)}s.`;
  }
  return null;
}
const notePost = (userId) => { lastPost.set(userId, Date.now()); if (lastPost.size > 5000) lastPost.delete(lastPost.keys().next().value); };
const publicSettings = () => ({ ...load().settings });
const netBanned = (netKey) => { const b = netKey && load().netBans[netHash(netKey)]; return !!(b && b.until > Date.now()); };

/* ---------------- audit ---------------- */
function audit(actorId, action, target, detail) {
  const a = describe(actorId) || { username: '?' };
  load().audit.push({ at: Date.now(), by: a.username, rank: rankOf(actorId), action, target: target || null, detail: detail ? String(detail).slice(0, 300) : '' });
  save();
}

/* ---------------- HTTP ---------------- */
const router = express.Router();
const need = (what) => [requireAuth, (req, res, next) => {
  if (req.session.role !== 'registered' || !can(req.session.sub, what)) return res.status(403).json({ error: "You don't have permission to do that." });
  next();
}];
const staffLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: (req) => 'staff:' + (req.session ? req.session.sub : keyFor(fromRequest(req))), message: { error: 'Slow down a little.' } });
const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: (req) => 'report:' + (req.session ? req.session.sub : ''), message: { error: "You've sent a lot of reports. Try again later." } });

/** checks the actor outranks the target; returns an error string or null */
function outranks(actorId, targetId) {
  return level(actorId) > level(targetId) ? null : "You can't do that to someone with the same or a higher role.";
}

function target(req, res) {
  const id = String(req.params.id || '');
  const t = describe(id);
  if (!t) { res.status(404).json({ error: "That person isn't around any more." }); return null; }
  const err = outranks(req.session.sub, id);
  if (err) { res.status(403).json({ error: err }); return null; }
  return t;
}

router.get('/me', (req, res) => {
  const s = readSession(req);
  const r = s ? rankOf(s.sub) : 'guest';
  const id = s && s.sub;
  const out = {
    rank: r,
    can: { moderate: can(id, 'moderate'), ban: can(id, 'ban'), settings: can(id, 'settings'), audit: can(id, 'audit'), stats: can(id, 'stats'), roles: can(id, 'set-mod'), owner: can(id, 'delete-account') },
    settings: publicSettings(),
  };
  if (out.can.moderate) out.openReports = load().reports.filter((x) => x.status === 'open').length;
  res.json(out);
});

router.get('/overview', ...need('stats'), staffLimiter, (req, res) => {
  const s = load();
  res.json({
    ...stats.snapshot(),
    moderation: {
      openReports: s.reports.filter((r) => r.status === 'open').length,
      banned: users().value().filter((u) => u.banned).length,
      muted: Object.values(s.mutes).filter((u) => u > Date.now()).length,
      blockedNetworks: Object.values(s.netBans).filter((b) => b.until > Date.now()).length,
      staff: users().value().filter((u) => STAFF.includes(u.rank)).length,
    },
  });
});

function personRow(u, on) {
  const p = u.profile || {};
  return {
    id: u.id, username: u.username, displayName: p.displayName || '', rank: rankOf(u.id), guest: false,
    createdAt: u.createdAt || null, banned: u.banned ? { reason: u.banned.reason || '', at: u.banned.at, by: u.banned.by } : null,
    mutedUntil: mutedUntil(u.id) || null, online: on.has(u.id),
  };
}

router.get('/users', ...need('moderate'), staffLimiter, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 20);
  const filter = String(req.query.filter || '');
  const on = onlineIds();
  let list = users().value().filter((u) => !q || u.usernameLower.includes(q) || String((u.profile || {}).displayName || '').toLowerCase().includes(q));
  if (filter === 'staff') list = list.filter((u) => STAFF.includes(u.rank));
  if (filter === 'banned') list = list.filter((u) => u.banned);
  if (filter === 'online') list = list.filter((u) => on.has(u.id));
  const rows = list.sort((a, b) => LEVEL[rankOf(b.id)] - LEVEL[rankOf(a.id)] || String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100).map((u) => personRow(u, on));
  // guests that are online right now
  if (filter !== 'staff' && filter !== 'banned') {
    for (const p of online()) {
      if (p.role !== 'guest' || rows.some((r) => r.id === p.id)) continue;
      if (q && !p.username.toLowerCase().includes(q)) continue;
      rows.push({ id: p.id, username: p.username, displayName: '', rank: 'guest', guest: true, createdAt: null, banned: null, mutedUntil: mutedUntil(p.id) || null, online: true });
    }
  }
  res.json({ users: rows, total: users().value().length });
});

router.get('/lookup', ...need('moderate'), staffLimiter, (req, res) => {
  let p = null;
  if (req.query.uid) p = byUid(String(req.query.uid));
  else if (req.query.name) {
    const u = findByName(String(req.query.name));
    if (u) p = { id: u.id, username: u.username, guest: false };
    else { const gid = guestRegistry.idForName(String(req.query.name)); if (gid) p = describe(gid); }
  }
  if (!p) return res.status(404).json({ error: "Couldn't find that person (guests can only be found while they're online)." });
  const u = findUser(p.id);
  res.json({ person: u ? personRow(u, onlineIds()) : { id: p.id, username: p.username, rank: 'guest', guest: true, mutedUntil: mutedUntil(p.id) || null, online: onlineIds().has(p.id) } });
});

router.post('/users/:id/rank', ...need('set-mod'), staffLimiter, (req, res) => {
  const t = target(req, res); if (!t) return;
  if (t.guest) return res.status(400).json({ error: 'Guests need an account to get a role.' });
  const rank = String((req.body || {}).rank || '');
  if (!['admin', 'mod', 'member'].includes(rank)) return res.status(400).json({ error: 'Pick admin, mod or member.' });
  if (LEVEL[rank] >= level(req.session.sub)) return res.status(403).json({ error: "You can only give roles below your own." });
  users().find({ id: t.id }).assign({ rank: rank === 'member' ? undefined : rank }).write();
  audit(req.session.sub, 'set-role', t.username, rank);
  bus.emit('staff:rank', { userId: t.id });
  res.json({ ok: true, rank: rankOf(t.id) });
});

router.post('/users/:id/mute', ...need('moderate'), staffLimiter, (req, res) => {
  const t = target(req, res); if (!t) return;
  const minutes = Math.round(Number((req.body || {}).minutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 24 * 60) return res.status(400).json({ error: 'Mute for 1 minute to 7 days.' });
  load().mutes[t.id] = Date.now() + minutes * 60000;
  audit(req.session.sub, 'mute', t.username, `${minutes} min`);
  bus.emit('staff:notice', { userId: t.id, text: `A moderator muted you in #public for ${minutes >= 60 ? Math.round(minutes / 60) + ' hour' + (minutes >= 120 ? 's' : '') : minutes + ' minutes'}.` });
  res.json({ ok: true, mutedUntil: load().mutes[t.id] });
});

router.post('/users/:id/unmute', ...need('moderate'), staffLimiter, (req, res) => {
  const t = target(req, res); if (!t) return;
  delete load().mutes[t.id];
  audit(req.session.sub, 'unmute', t.username);
  res.json({ ok: true });
});

router.post('/users/:id/kick', ...need('moderate'), staffLimiter, (req, res) => {
  const t = target(req, res); if (!t) return;
  if (t.guest) guestRegistry.remove(t.id); // their guest session is over
  audit(req.session.sub, 'kick', t.username, t.guest ? 'guest session ended' : 'disconnected');
  bus.emit('staff:kick', { userId: t.id, reason: 'A moderator removed you from the chat.' });
  res.json({ ok: true });
});

router.post('/users/:id/ban', ...need('ban'), staffLimiter, (req, res) => {
  const t = target(req, res); if (!t) return;
  const reason = cleanLine((req.body || {}).reason, 200);
  const actor = describe(req.session.sub);
  if (t.guest) {
    // guests have no account to ban: end the session and block their network for a day
    const keys = online().filter((p) => p.id === t.id && p.netKey).map((p) => p.netKey);
    for (const k of keys) load().netBans[netHash(k)] = { until: Date.now() + GUEST_BLOCK_MS, by: actor.username, reason, label: t.username };
    guestRegistry.remove(t.id);
    audit(req.session.sub, 'ban-guest', t.username, (reason || 'no reason') + ' (network blocked 24h)');
  } else {
    const u = findUser(t.id);
    users().find({ id: t.id }).assign({ banned: { reason, at: Date.now(), by: actor.username }, tokenVersion: (u.tokenVersion || 0) + 1 }).write();
    audit(req.session.sub, 'ban', t.username, reason || 'no reason');
  }
  save();
  bus.emit('staff:kick', { userId: t.id, reason: 'You were banned.' + (reason ? ' Reason: ' + reason : '') });
  res.json({ ok: true });
});

router.post('/users/:id/unban', ...need('ban'), staffLimiter, (req, res) => {
  const u = findUser(String(req.params.id || ''));
  if (!u || !u.banned) return res.status(404).json({ error: "That account isn't banned." });
  users().find({ id: u.id }).assign({ banned: undefined }).write();
  audit(req.session.sub, 'unban', u.username);
  res.json({ ok: true });
});

router.post('/users/:id/signout', ...need('signout'), staffLimiter, (req, res) => {
  const t = target(req, res); if (!t) return;
  if (t.guest) return res.status(400).json({ error: 'Use kick for guests.' });
  const u = findUser(t.id);
  users().find({ id: t.id }).assign({ tokenVersion: (u.tokenVersion || 0) + 1 }).write();
  audit(req.session.sub, 'sign-out', t.username);
  bus.emit('staff:kick', { userId: t.id, reason: 'You were signed out.' });
  res.json({ ok: true });
});

router.post('/users/:id/purge-public', ...need('purge'), staffLimiter, (req, res) => {
  const t = target(req, res); if (!t) return;
  const uid = uidFor(t.id);
  const ids = [];
  history.purge((m) => { if (m.uid === uid) { ids.push(m.id); return true; } return false; });
  audit(req.session.sub, 'wipe-public', t.username, `${ids.length} messages`);
  bus.emit('staff:purge', { ids, uid });
  res.json({ ok: true, removed: ids.length });
});

router.delete('/users/:id', ...need('delete-account'), staffLimiter, (req, res) => {
  const t = target(req, res); if (!t) return;
  if (t.guest) return res.status(400).json({ error: 'Use kick for guests.' });
  bus.emit('staff:kick', { userId: t.id, reason: 'Your account was deleted.' });
  bus.emit('staff:delete-account', { userId: t.id }); // realtime cleans friend chats + files
  for (const u of users().value()) {
    if (Array.isArray(u.friends) && u.friends.includes(t.id)) users().find({ id: u.id }).assign({ friends: u.friends.filter((f) => f !== t.id) }).write();
  }
  users().remove({ id: t.id }).write();
  delete load().mutes[t.id];
  audit(req.session.sub, 'delete-account', t.username);
  res.json({ ok: true });
});

/** remove one #public message (used from the reports screen) */
router.post('/public/:msgId/delete', ...need('moderate'), staffLimiter, (req, res) => {
  const m = history.get(String(req.params.msgId || ''));
  if (!m) return res.status(404).json({ error: 'That message is already gone.' });
  const author = byUid(m.uid);
  if (author && level(req.session.sub) <= level(author.id)) return res.status(403).json({ error: "You can't remove messages from someone with the same or a higher role." });
  history.remove(m.id, null, true);
  audit(req.session.sub, 'delete-message', m.sender, m.text ? m.text.slice(0, 120) : '(picture)');
  bus.emit('staff:purge', { ids: [m.id], uid: m.uid });
  res.json({ ok: true });
});

/* ---- reports ---- */
router.post('/report', requireAuth, reportLimiter, (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  if (!['public', 'room', 'dm', 'user'].includes(kind)) return res.status(400).json({ error: 'Bad report.' });
  const reason = REASONS.includes(b.reason) ? b.reason : null;
  if (!reason) return res.status(400).json({ error: 'Pick a reason.' });
  const reporter = describe(req.session.sub) || { username: req.session.username };
  const rep = { id: crypto.randomBytes(6).toString('hex'), at: Date.now(), kind, reason, note: cleanBlock(b.note, 300, 4), status: 'open', by: { id: req.session.sub, username: reporter.username } };

  if (kind === 'public') {
    const m = typeof b.msgId === 'string' ? history.get(b.msgId) : null;
    if (!m) return res.status(404).json({ error: 'That message is gone.' });
    const who = byUid(m.uid);
    rep.target = { id: who ? who.id : null, username: m.sender, uid: m.uid };
    rep.message = { id: m.id, text: m.text, ts: m.ts, att: m.att || null };
  } else {
    // private rooms + friend chats: the server can't read them. Only what the reporter chooses to share is kept.
    let who = null;
    if (typeof b.uid === 'string') who = byUid(b.uid);
    if (!who && typeof b.target === 'string') {
      const u = findByName(b.target);
      who = u ? { id: u.id, username: u.username } : (guestRegistry.idForName(b.target) ? describe(guestRegistry.idForName(b.target)) : null);
    }
    if (!who) return res.status(404).json({ error: "Couldn't find that person." });
    if (who.id === req.session.sub) return res.status(400).json({ error: "You can't report yourself." });
    rep.target = { id: who.id, username: who.username, uid: uidFor(who.id) };
    if (kind !== 'user' && typeof b.text === 'string' && b.text.trim()) rep.message = { id: typeof b.msgId === 'string' ? b.msgId.slice(0, 64) : null, text: cleanBlock(b.text, 2000, 30), ts: Number(b.ts) || null, shared: true };
  }
  load().reports.push(rep);
  save();
  bus.emit('staff:report', { id: rep.id });
  res.status(201).json({ ok: true });
});

router.get('/reports', ...need('moderate'), staffLimiter, (req, res) => {
  const status = req.query.status === 'resolved' ? 'resolved' : 'open';
  const list = load().reports.filter((r) => (status === 'open' ? r.status === 'open' : r.status !== 'open')).slice(-200).reverse();
  // tell the panel whether this viewer may act on the person (so it only shows buttons that will work)
  res.json({ reports: list.map((r) => ({ ...r, canAct: !!(r.target && r.target.id && r.target.id !== req.session.sub && level(req.session.sub) > level(r.target.id)) })) });
});

router.post('/reports/:id/resolve', ...need('moderate'), staffLimiter, (req, res) => {
  const r = load().reports.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'No such report.' });
  const outcome = (req.body || {}).outcome === 'actioned' ? 'actioned' : 'dismissed';
  const actor = describe(req.session.sub);
  Object.assign(r, { status: outcome, resolvedBy: actor.username, resolvedAt: Date.now(), resolution: cleanLine((req.body || {}).note, 200) });
  audit(req.session.sub, 'report-' + outcome, r.target && r.target.username, r.reason);
  res.json({ ok: true });
});

/* ---- audit + settings + blocked networks ---- */
router.get('/audit', ...need('audit'), staffLimiter, (req, res) => res.json({ audit: load().audit.slice(-300).reverse() }));

router.get('/settings', (req, res) => res.json({ settings: publicSettings() }));
router.put('/settings', ...need('settings'), staffLimiter, (req, res) => {
  const b = req.body || {};
  const s = load().settings;
  const before = JSON.stringify(s);
  if ('slowModeSec' in b) {
    const n = Math.round(Number(b.slowModeSec));
    if (!Number.isFinite(n) || n < 0 || n > 600) return res.status(400).json({ error: 'Slow mode is 0 to 600 seconds.' });
    s.slowModeSec = n;
  }
  if ('publicPosting' in b) {
    if (!['all', 'members', 'staff'].includes(b.publicPosting)) return res.status(400).json({ error: 'Bad posting setting.' });
    s.publicPosting = b.publicPosting;
  }
  if ('announcement' in b) s.announcement = cleanLine(b.announcement, 200);
  if (JSON.stringify(s) !== before) audit(req.session.sub, 'settings', null, `slow ${s.slowModeSec}s, posting ${s.publicPosting}${s.announcement ? ', announcement set' : ''}`);
  save();
  bus.emit('staff:settings', publicSettings());
  res.json({ settings: publicSettings() });
});

router.get('/netbans', ...need('ban'), staffLimiter, (req, res) => {
  const now = Date.now();
  res.json({ netbans: Object.entries(load().netBans).filter(([, b]) => b.until > now).map(([key, b]) => ({ key, until: b.until, by: b.by, reason: b.reason, label: b.label })) });
});
router.delete('/netbans/:key', ...need('ban'), staffLimiter, (req, res) => {
  if (!load().netBans[req.params.key]) return res.status(404).json({ error: 'Not blocked.' });
  const label = load().netBans[req.params.key].label;
  delete load().netBans[req.params.key];
  audit(req.session.sub, 'unblock-network', label);
  res.json({ ok: true });
});

/** in front of POST /api/auth/guest: blocked networks can't make new guest sessions */
function guestGate(req, res, next) {
  if (netBanned(keyFor(fromRequest(req)))) return res.status(403).json({ error: 'Guest access from your network is blocked for now. Try again later.' });
  next();
}

module.exports = {
  router, rankOf, badge, can, isStaff, ensureOwner, publicGate, notePost, publicSettings, netBanned, guestGate, audit, byUid, mutedUntil,
  setLive: (fn) => { live = fn; },
  RANKS, LEVEL,
};
