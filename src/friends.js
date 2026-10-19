// Friend codes and friend lists.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('./auth');
const bus = require('./bus');
const { fromRequest, keyFor } = require('./clientIp');
const id = require('./identity');

const router = express.Router();

const addLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => keyFor(fromRequest(req)),
  message: { error: 'Too many attempts. Please wait a bit and try again.' },
});

router.get('/me', requireAuth, (req, res) => {
  const me = id.getIdentity(req.user.sub);
  if (!me) return res.status(404).json({ error: 'Session expired.' });
  return res.json({ friendCode: me.friendCode, role: me.role, expiresAt: me.expiresAt || null });
});

router.get('/list', requireAuth, (req, res) => {
  const me = id.getIdentity(req.user.sub);
  if (!me) return res.status(404).json({ error: 'Session expired.' });
  const friends = me.friends
    .map((fid) => {
      const f = id.getIdentity(fid);
      return f ? { id: f.id, username: f.username, role: f.role, room: id.privateRoomName(me.id, f.id), pub: f.pub } : null;
    })
    .filter(Boolean);
  return res.json({ friends });
});

router.post('/add', requireAuth, addLimiter, (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Enter a friend code.' });

  const me = id.getIdentity(req.user.sub);
  if (!me) return res.status(404).json({ error: 'Session expired.' });

  const target = id.findByCode(code.trim().toUpperCase());
  if (!target) return res.status(404).json({ error: 'No account found with that code — it may have expired.' });
  if (target.id === me.id) return res.status(400).json({ error: "That's your own code." });
  if (me.friends.includes(target.id)) return res.status(409).json({ error: 'Already friends.' });

  id.addFriendRelationship({ id: me.id, role: me.role }, { id: target.id, role: target.role });
  bus.emit('friends:changed', [me.id, target.id]);

  return res.status(201).json({
    friend: { id: target.id, username: target.username, role: target.role, room: id.privateRoomName(me.id, target.id) },
  });
});

router.delete('/:friendId', requireAuth, (req, res) => {
  const me = id.getIdentity(req.user.sub);
  if (!me) return res.status(404).json({ error: 'Session expired.' });
  const other = id.getIdentity(req.params.friendId);
  if (!other || !me.friends.includes(other.id)) return res.status(404).json({ error: 'Not in your friends list.' });
  id.removeFriendRelationship({ id: me.id, role: me.role }, { id: other.id, role: other.role });
  bus.emit('friends:changed', [me.id, other.id]);
  bus.emit('friends:removed', { a: me.id, b: other.id, room: id.privateRoomName(me.id, other.id) });
  return res.json({ ok: true });
});

module.exports = router;
