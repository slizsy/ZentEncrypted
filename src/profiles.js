// Custom profiles for accounts: display name, bio, colors, picture, banner, links.
// Signed-in people can see anyone's profile. A profile page is visible to the whole internet
// only if its owner turns "public page" on.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const files = require('./files');
const guestRegistry = require('./guestRegistry');
const { requireAuth, readSession } = require('./auth');
const { cleanLine, cleanBlock } = require('./text');
const { fromRequest, keyFor } = require('./clientIp');

const router = express.Router();
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_LINKS = 6;
const DEFAULTS = { displayName: '', status: '', pronouns: '', bio: '', accent: '#e2b45c', bg: '#161513', avatar: null, banner: null, links: [], public: false };

const findByName = (name) => db.get('users').find({ usernameLower: String(name).toLowerCase() }).value();
const findUser = (uid) => db.get('users').find({ id: uid }).value();
const fileUrl = (fid) => (fid ? `/files/${fid}` : null);

function cleanUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s; // "github.com/me" is fine
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null; // no javascript:, data:, etc
  if (u.username || u.password) return null;
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
  const out = u.toString();
  return out.length <= 300 ? out : null;
}

/** checks + cleans what the editor sent. returns { profile } or { error } */
function validate(body, current) {
  const b = body && typeof body === 'object' ? body : {};
  const p = { ...DEFAULTS, ...(current || {}) };
  if ('displayName' in b) p.displayName = cleanLine(b.displayName, 32);
  if ('status' in b) p.status = cleanLine(b.status, 60);
  if ('pronouns' in b) p.pronouns = cleanLine(b.pronouns, 24);
  if ('bio' in b) p.bio = cleanBlock(b.bio, 300, 8);
  for (const k of ['accent', 'bg']) {
    if (k in b) {
      if (typeof b[k] !== 'string' || !HEX.test(b[k])) return { error: 'Pick a color from the color picker.' };
      p[k] = b[k].toLowerCase();
    }
  }
  if ('public' in b) p.public = b.public === true;
  if ('links' in b) {
    if (!Array.isArray(b.links)) return { error: 'Bad links.' };
    const links = [];
    for (const l of b.links.slice(0, MAX_LINKS + 4)) {
      if (!l || typeof l !== 'object') continue;
      const url = String(l.url || '').trim();
      const label = cleanLine(l.label, 24);
      if (!url && !label) continue; // empty row
      const clean = cleanUrl(url);
      if (!clean) return { error: `"${label || url.slice(0, 30)}" isn't a working web link.` };
      links.push({ label: label || new URL(clean).hostname.replace(/^www\./, ''), url: clean });
    }
    if (links.length > MAX_LINKS) return { error: `Up to ${MAX_LINKS} links.` };
    p.links = links;
  }
  for (const k of ['avatar', 'banner']) {
    if (k in b && b[k] !== null && (typeof b[k] !== 'string' || !files.ID_RE.test(b[k]))) return { error: 'That picture is gone. Upload it again.' };
    if (k in b) p[k] = b[k];
  }
  return { profile: p };
}

function publicView(user, viewerIsOwner) {
  const p = { ...DEFAULTS, ...(user.profile || {}) };
  const out = {
    username: user.username,
    displayName: p.displayName,
    status: p.status,
    pronouns: p.pronouns,
    bio: p.bio,
    accent: p.accent,
    bg: p.bg,
    avatar: fileUrl(p.avatar),
    banner: fileUrl(p.banner),
    links: p.links,
    memberSince: String(user.createdAt || '').slice(0, 7), // month only, e.g. 2026-10
    public: !!p.public,
  };
  if (viewerIsOwner) { out.avatarId = p.avatar; out.bannerId = p.banner; }
  return out;
}

const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 90, standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: (req) => keyFor(fromRequest(req)), message: { error: 'Slow down a little.' } });
const writeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: (req) => 'prof:' + (req.session ? req.session.sub : ''), message: { error: 'Too many saves. Wait a few minutes.' } });

router.get('/me', requireAuth, (req, res) => {
  if (req.session.role !== 'registered') return res.status(403).json({ error: 'Make an account to get a profile.' });
  const user = findUser(req.session.sub);
  if (!user) return res.status(404).json({ error: 'Session expired.' });
  res.json({ profile: publicView(user, true) });
});

router.put('/me', requireAuth, writeLimiter, (req, res) => {
  if (req.session.role !== 'registered') return res.status(403).json({ error: 'Make an account to get a profile.' });
  const user = findUser(req.session.sub);
  if (!user) return res.status(404).json({ error: 'Session expired.' });
  const before = { ...DEFAULTS, ...(user.profile || {}) };
  const v = validate(req.body, before);
  if (v.error) return res.status(400).json({ error: v.error });
  const p = v.profile;
  // new pictures must be this person's own fresh profile uploads
  for (const k of ['avatar', 'banner']) {
    if (p[k] && p[k] !== before[k] && !files.attachProfile(p[k], user.id)) return res.status(400).json({ error: 'That picture is gone. Upload it again.' });
  }
  db.get('users').find({ id: user.id }).assign({ profile: p }).write();
  for (const k of ['avatar', 'banner']) if (before[k] && before[k] !== p[k]) files.removeOwn(before[k], user.id, 'profile');
  res.json({ profile: publicView(findUser(user.id), true) });
});

router.get('/:name', readLimiter, (req, res) => {
  const name = String(req.params.name || '');
  const viewer = readSession(req);
  const user = /^[a-zA-Z0-9_]{3,20}$/.test(name) ? findByName(name) : null;
  if (!user) {
    if (viewer && guestRegistry.nameTaken(name)) return res.status(404).json({ error: "Guests don't have profiles.", guest: true });
    return res.status(404).json({ error: 'No profile here.' });
  }
  const isOwner = !!viewer && viewer.sub === user.id;
  if (!viewer && !(user.profile && user.profile.public)) return res.status(404).json({ error: 'No profile here.' });
  res.json({ profile: publicView(user, isOwner) });
});

const counts = () => {
  const users = db.get('users').value();
  return { withProfile: users.filter((u) => u.profile).length, publicPages: users.filter((u) => u.profile && u.profile.public).length };
};

module.exports = { router, validate, cleanUrl, counts };
