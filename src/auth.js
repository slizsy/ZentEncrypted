// Accounts, guest sessions and the login cookie.
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID, randomInt } = require('crypto');
const { parse: parseCookies } = require('cookie');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const guestRegistry = require('./guestRegistry');
const shield = require('./shield');
const passwords = require('./passwords');
const bus = require('./bus');
const { fromRequest, keyFor } = require('./clientIp');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  throw new Error('JWT_SECRET is missing or too short. Copy .env.example to .env and set a long random secret.');
}

// Unknown usernames are checked against this so they take as long as wrong passwords.
let dummyHash = null;
passwords.hash('not-a-real-password').then((h) => (dummyHash = h));

const byNetwork = { standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: (req) => keyFor(fromRequest(req)) };
const loginLimiter = rateLimit({ ...byNetwork, windowMs: 15 * 60 * 1000, max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 15), skipSuccessfulRequests: true, message: { error: 'Too many failed attempts. Try again in a few minutes.' } });
const registerLimiter = rateLimit({ ...byNetwork, windowMs: 60 * 60 * 1000, max: 12, message: { error: 'Too many new accounts from this network. Try again later.' } });
const guestLimiter = rateLimit({ ...byNetwork, windowMs: 15 * 60 * 1000, max: 80, message: { error: 'Too many guest sessions from this network. Try again shortly.' } });
const accountLimiter = rateLimit({ standardHeaders: true, legacyHeaders: false, validate: false, windowMs: 60 * 60 * 1000, max: 10, keyGenerator: (req) => 'acct:' + (req.session ? req.session.sub : keyFor(fromRequest(req))), message: { error: 'Too many attempts. Try again later.' } });

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const RESERVED = /^(admin|administrator|system|server|zent|zentencrypted|mod|moderator|support|staff|you|them|root|null|undefined|guest\d*)$/i;

const findUser = (id) => db.get('users').find({ id }).value();
const findByName = (name) => db.get('users').find({ usernameLower: String(name).toLowerCase() }).value();

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: 'registered', tv: user.tokenVersion || 0 }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// `secure` follows the real protocol, so plain-http LAN access still signs in.
function setCookie(req, res, token, remember = true, maxAgeMs = REMEMBER_MS) {
  const opts = { httpOnly: true, sameSite: 'lax', secure: !!req.secure };
  if (remember) opts.maxAge = maxAgeMs;
  res.cookie('token', token, opts);
}

const clearCookie = (req, res) => res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: !!req.secure });

// The one place a cookie becomes a session. Used by HTTP routes and sockets.
function sessionFromCookie(header) {
  const token = parseCookies(header || '').token;
  if (!token) return null;
  let claims;
  try { claims = jwt.verify(token, JWT_SECRET); } catch { return null; }
  if (claims.role === 'guest') return guestRegistry.get(claims.sub) ? claims : null;
  const user = findUser(claims.sub);
  if (!user || (user.tokenVersion || 0) !== (claims.tv || 0)) return null; // revoked by a password change / sign-out-everywhere
  return claims;
}

const readSession = (req) => sessionFromCookie(req.headers.cookie);

function requireAuth(req, res, next) {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'Not signed in.' });
  req.session = s;
  req.user = s;
  next();
}

const accountName = (req) => (req.body && typeof req.body.username === 'string' ? req.body.username.toLowerCase() : null);

router.post('/register', shield.guard(), registerLimiter, async (req, res) => {
  try {
    const { username, password, remember } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 3-20 letters, numbers or _.' });
    if (RESERVED.test(username)) return res.status(400).json({ error: 'That username is reserved.' });
    const weak = passwords.policyError(password, username);
    if (weak) return res.status(400).json({ error: weak });
    if (findByName(username)) return res.status(409).json({ error: 'That username is taken.' });

    const user = {
      id: randomUUID(),
      username,
      usernameLower: username.toLowerCase(),
      passwordHash: await passwords.hash(password),
      friendCode: db.generateFriendCode(guestRegistry.codeTaken),
      friends: [],
      tokenVersion: 0,
      createdAt: new Date().toISOString(),
    };
    if (findByName(username)) return res.status(409).json({ error: 'That username is taken.' }); // lost a race during hashing
    db.get('users').push(user).write();
    setCookie(req, res, signToken(user), remember !== false);
    res.status(201).json({ id: user.id, username: user.username, role: 'registered' });
  } catch (err) {
    console.error('register:', err.message);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.post('/login', shield.guard({ account: accountName }), loginLimiter, async (req, res) => {
  try {
    const { username, password, remember } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const name = username.toLowerCase();
    const user = findByName(name);
    const ok = await passwords.verify(password.slice(0, 200), user ? user.passwordHash : dummyHash || (await passwords.hash('x')));
    if (!user || !ok) {
      shield.noteFail(req, name);
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    shield.noteSuccess(req, name);

    const patch = {};
    if (passwords.needsUpgrade(user.passwordHash)) patch.passwordHash = await passwords.hash(password); // move old bcrypt hashes to scrypt
    if (!user.friendCode) { patch.friendCode = db.generateFriendCode(guestRegistry.codeTaken); patch.friends = user.friends || []; }
    if (Object.keys(patch).length) db.get('users').find({ id: user.id }).assign(patch).write();

    setCookie(req, res, signToken(findUser(user.id)), remember !== false);
    res.json({ id: user.id, username: user.username, role: 'registered' });
  } catch (err) {
    console.error('login:', err.message);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

router.post('/guest', shield.guard(), guestLimiter, (req, res) => {
  const id = randomUUID();
  let handle;
  do handle = `Guest${randomInt(1000, 10000)}`; while (guestRegistry.nameTaken(handle));
  guestRegistry.register(id, handle, db.codeTaken);
  const token = jwt.sign({ sub: id, username: handle, role: 'guest' }, JWT_SECRET, { expiresIn: '24h' });
  setCookie(req, res, token, !(req.body && req.body.remember === false), guestRegistry.TTL_MS);
  res.json({ id, username: handle, role: 'guest' });
});

router.post('/logout', (req, res) => {
  clearCookie(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const s = readSession(req);
  if (!s) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ id: s.sub, username: s.username, role: s.role });
});

// Change password: every other device is signed out, this one stays in.
router.post('/password', requireAuth, accountLimiter, async (req, res) => {
  if (req.session.role !== 'registered') return res.status(403).json({ error: 'Guests have no password.' });
  const { current, next } = req.body || {};
  if (typeof current !== 'string' || typeof next !== 'string') return res.status(400).json({ error: 'Enter your current and new password.' });
  const user = findUser(req.session.sub);
  if (!(await passwords.verify(current.slice(0, 200), user.passwordHash))) {
    shield.noteFail(req, user.usernameLower);
    return res.status(401).json({ error: 'Current password is wrong.' });
  }
  const weak = passwords.policyError(next, user.username);
  if (weak) return res.status(400).json({ error: weak });
  if (next === current) return res.status(400).json({ error: 'Pick a different password.' });
  const patch = { passwordHash: await passwords.hash(next), tokenVersion: (user.tokenVersion || 0) + 1 };
  if (user.keys) {
    // The message key is locked with the password, so it has to be re-locked in the same step.
    const k = req.body.keys;
    if (!require('./keys').validLocked(k)) return res.status(400).json({ error: 'Reload the page and try again.' });
    patch.keys = { ...user.keys, wrapped: k.wrapped, salt: k.salt, iv: k.iv, iters: k.iters };
  }
  db.get('users').find({ id: user.id }).assign(patch).write();
  bus.emit('session:revoked', user.id);
  setCookie(req, res, signToken(findUser(user.id)), true);
  res.json({ ok: true });
});

// Sign out of every device, including this one.
router.post('/logout-all', requireAuth, (req, res) => {
  if (req.session.role !== 'registered') { clearCookie(req, res); return res.json({ ok: true }); }
  const user = findUser(req.session.sub);
  db.get('users').find({ id: user.id }).assign({ tokenVersion: (user.tokenVersion || 0) + 1 }).write();
  bus.emit('session:revoked', user.id);
  clearCookie(req, res);
  res.json({ ok: true });
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
module.exports.requireAuth = requireAuth;
module.exports.readSession = readSession;
module.exports.sessionFromCookie = sessionFromCookie;
