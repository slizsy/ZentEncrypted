/**
 * auth.js
 * Express routes for registration, login, and guest session issuance.
 * Passwords are hashed with bcrypt. Sessions are stateless JWTs delivered
 * as httpOnly cookies, so the server never needs a session store.
 */
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const SALT_ROUNDS = 12;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to .env and set a strong secret.');
}

// --- Rate limiting for auth endpoints (mitigates credential stuffing / brute force) ---
const authLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: 'registered' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

// --- Register ---
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, underscore).' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = db.get('users').find({ username: username.toLowerCase() }).value();
    if (existing) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = {
      id: uuidv4(),
      username,
      usernameLower: username.toLowerCase(),
      passwordHash,
      createdAt: new Date().toISOString(),
    };

    db.get('users').push(user).write();

    const token = signToken(user);
    setAuthCookie(res, token);
    return res.status(201).json({ id: user.id, username: user.username });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- Login ---
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = db.get('users').find({ usernameLower: String(username).toLowerCase() }).value();
    // Constant-shape response whether or not user exists, to reduce user enumeration
    const hash = user ? user.passwordHash : '$2b$12$invalidsaltinvalidsaltinvalidsalu';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = signToken(user);
    setAuthCookie(res, token);
    return res.json({ id: user.id, username: user.username });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- Guest session (never persisted to DB) ---
router.post('/guest', authLimiter, (req, res) => {
  const guestId = uuidv4();
  const handle = `Guest_${Math.floor(1000 + Math.random() * 9000)}`;

  const token = jwt.sign(
    { sub: guestId, username: handle, role: 'guest' },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  setAuthCookie(res, token);
  return res.json({ id: guestId, username: handle, role: 'guest' });
});

// --- Logout ---
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  return res.json({ ok: true });
});

// --- Who am I (used by frontend on load) ---
router.get('/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return res.json({ id: payload.sub, username: payload.username, role: payload.role });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
});

module.exports = router;
module.exports.JWT_SECRET = JWT_SECRET;
