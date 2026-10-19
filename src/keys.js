// Account keys for friend messages. The server stores the public key and a password-locked
// copy of the private key; it never sees the private key itself.
const express = require('express');
const db = require('../config/database');
const guestRegistry = require('./guestRegistry');
const passwords = require('./passwords');
const dm = require('./dmstore');
const files = require('./files');
const bus = require('./bus');
const id = require('./identity');
const { requireAuth } = require('./auth');

const router = express.Router();

const b64 = (s, min, max) => typeof s === 'string' && s.length >= min && s.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
const validPub = (s) => b64(s, 87, 88); // raw uncompressed P-256 point, 65 bytes
const validLocked = (k) => !!k && b64(k.wrapped, 100, 400) && b64(k.salt, 22, 24) && b64(k.iv, 16, 16) && Number.isInteger(k.iters) && k.iters >= 100000 && k.iters <= 5000000;

function wipeConversations(userId) {
  for (const c of dm.conversations()) if (c.includes(userId)) { dm.deleteConv(c); files.dropScope(c); }
}

router.get('/me', requireAuth, (req, res) => {
  if (req.session.role === 'guest') {
    const g = guestRegistry.get(req.session.sub);
    return res.json({ keys: g && g.pub ? { pub: g.pub } : null });
  }
  const user = db.get('users').find({ id: req.session.sub }).value();
  res.json({ keys: (user && user.keys) || null });
});

router.post('/', requireAuth, (req, res) => {
  const k = req.body || {};
  if (!validPub(k.pub)) return res.status(400).json({ error: 'Bad key.' });
  if (req.session.role === 'guest') {
    const g = guestRegistry.get(req.session.sub);
    if (!g) return res.status(401).json({ error: 'Session expired.' });
    if (g.pub) return res.status(409).json({ error: 'Key already set.' });
    g.pub = k.pub;
  } else {
    if (!validLocked(k)) return res.status(400).json({ error: 'Bad key.' });
    const user = db.get('users').find({ id: req.session.sub }).value();
    if (user.keys) return res.status(409).json({ error: 'Key already set.' });
    db.get('users').find({ id: user.id }).assign({ keys: { pub: k.pub, wrapped: k.wrapped, salt: k.salt, iv: k.iv, iters: k.iters } }).write();
  }
  const me = id.getIdentity(req.session.sub);
  bus.emit('friends:changed', [me.id, ...me.friends]); // friends pick up the new public key
  res.status(201).json({ ok: true });
});

// Start over with a new key. Old messages can't be read by anyone after this, so they're deleted.
router.post('/reset', requireAuth, async (req, res) => {
  if (req.session.role === 'guest') {
    const g = guestRegistry.get(req.session.sub);
    if (g) delete g.pub;
  } else {
    const user = db.get('users').find({ id: req.session.sub }).value();
    const pw = req.body && req.body.password;
    if (typeof pw !== 'string' || !(await passwords.verify(pw.slice(0, 200), user.passwordHash))) return res.status(401).json({ error: 'Wrong password.' });
    db.get('users').find({ id: user.id }).unset('keys').write();
  }
  wipeConversations(req.session.sub);
  const me = id.getIdentity(req.session.sub);
  bus.emit('friends:changed', [me.id, ...me.friends]);
  res.json({ ok: true });
});

module.exports = router;
module.exports.validLocked = validLocked;
module.exports.validPub = validPub;
