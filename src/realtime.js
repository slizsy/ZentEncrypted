// Socket.io: rooms, message relay, DM key exchange, presence, limits, edits and deletes.
// Public-room messages are saved as text (src/history.js); friend messages as ciphertext (src/dmstore.js).
// Join-code rooms are never saved.
const crypto = require('crypto');
const { JWT_SECRET, sessionFromCookie } = require('./auth');
const rooms = require('./rooms');
const id = require('./identity');
const shield = require('./shield');
const history = require('./history');
const dm = require('./dmstore');
const bus = require('./bus');
const files = require('./files');
const gifs = require('./gifs');
const stats = require('./stats');
const { cleanText } = require('./text');
const { fromRequest, keyFor } = require('./clientIp');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const MAX_MSGS_PER_SEC = num(process.env.WS_MAX_MESSAGES_PER_SECOND, 5);
const MAX_PAYLOAD_BYTES = num(process.env.WS_MAX_PAYLOAD_BYTES, 12 * 1024);
const IDLE_TIMEOUT_MS = num(process.env.WS_IDLE_TIMEOUT_MS, 15 * 60 * 1000);
const PUBLIC_MAX_CHARS = 1000;
const CIPHER_MAX_CHARS = 7000;

const uidFor = (userId) =>
  crypto.createHmac('sha256', JWT_SECRET).update('uid:' + userId).digest('hex').slice(0, 10);

const noop = () => {};
const fn = (f) => (typeof f === 'function' ? f : noop);

function byteSize(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj));
  } catch {
    return Infinity;
  }
}

const MSG_REF = /^[A-Za-z0-9-]{4,64}$/; // ids of messages being edited/deleted
const dim = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 && n <= 10000 ? n : 0; };
const fileList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && files.ID_RE.test(x)).slice(0, 4) : []);

function authenticateSocket(socket, next) {
  const session = sessionFromCookie(socket.handshake.headers.cookie);
  if (!session || !id.getIdentity(session.sub)) return next(new Error('Unauthorized'));
  socket.user = { id: session.sub, username: session.username, role: session.role, uid: uidFor(session.sub) };
  next();
}

function attach(io) {
  io.use(authenticateSocket);

  // pictures in #public go away with their message (deleted, expired or over the cap)
  history.onDrop((list) => files.dropMsgFiles(list.filter((m) => m.att && m.att.t === 'img').map((m) => m.id)));
  // rooms don't survive a restart, and the cleanup script may have removed public messages
  files.reconcile(history.ids());
  files.setMembership((userId, roomKey) => {
    const set = io.sockets.adapter.rooms.get(roomKey);
    if (!set) return false;
    for (const sid of set) { const s = io.sockets.sockets.get(sid); if (s && s.user && s.user.id === userId) return true; }
    return false;
  });
  stats.setLive(() => {
    const people = new Map();
    for (const s of io.sockets.sockets.values()) if (s.user) people.set(s.user.id, s.user.role);
    let members = 0, guests = 0;
    for (const r of people.values()) (r === 'guest' ? guests++ : members++);
    const r = rooms.summary();
    return { online: people.size, members, guests, connections: io.sockets.sockets.size, rooms: r.active, inRooms: r.inRooms };
  });
  stats.setExtra(() => {
    const f = files.stats();
    return { publicMessages: history.size(), friendMessages: dm.size(), files: f.count, fileBytes: f.bytes, fileCap: f.cap };
  });
  const killConv = (c) => { dm.deleteConv(c); files.dropScope(c); };

  // Cap connections per network. Rejecting during the handshake means the
  // browser gets an explicit connect_error instead of hanging.
  io.use((socket, next) => {
    const key = keyFor(fromRequest(socket.request));
    if (!shield.connOpen(key)) return next(new Error('Too many connections'));
    socket.once('disconnect', () => shield.connClose(key));
    next();
  });

  const userRoom = (userId) => `u:${userId}`;
  const isOnline = (userId) => (io.sockets.adapter.rooms.get(userRoom(userId))?.size || 0) > 0;

  function announceCount(key) {
    const r = rooms.get(key);
    if (r) io.to(key).emit('room:count', { room: key, count: r.members.size });
  }

  function enter(socket, key) {
    if (socket.rooms.has(key)) return rooms.get(key);
    socket.join(key);
    const r = rooms.join(key, socket.id);
    io.to(key).emit('presence:join', { room: key, username: socket.user.username, uid: socket.user.uid });
    announceCount(key);
    return r;
  }

  function exit(socket, key) {
    const wasIn = socket.rooms.has(key);
    socket.leave(key);
    const r = rooms.leave(key, socket.id);
    if (wasIn) io.to(key).emit('presence:leave', { room: key, username: socket.user.username, uid: socket.user.uid });
    if (r) announceCount(key);
  }

  io.on('connection', (socket) => {
    const { id: userId, username, role, uid } = socket.user;

    let stamps = [];
    let createStamps = [];
    let joinFails = [];
    let typingAt = 0;
    let idleTimer = null;

    const bump = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        socket.emit('session:idle', { message: 'Disconnected after a period of inactivity.' });
        socket.disconnect(true);
      }, IDLE_TIMEOUT_MS);
    };
    bump();

    const limited = () => {
      const now = Date.now();
      stamps = stamps.filter((t) => now - t < 1000);
      stamps.push(now);
      return stamps.length > MAX_MSGS_PER_SEC;
    };

    // First tab for this person => tell their friends they're online.
    socket.join(userRoom(userId));
    const sockets = io.sockets.adapter.rooms.get(userRoom(userId));
    if (sockets && sockets.size === 1) {
      for (const f of id.getIdentity(userId)?.friends || []) io.to(userRoom(f)).emit('friend:presence', { id: userId, online: true });
    }

    enter(socket, rooms.PUBLIC);
    if (sockets && sockets.size === 1) stats.notePeak(new Set(Array.from(io.sockets.sockets.values(), (x) => x.user && x.user.id)).size);
    socket.emit('session:ready', { id: userId, uid, username, role, room: rooms.PUBLIC, publicHistory: history.info() });

    /* ---------- joining / creating ---------- */
    socket.on('room:create', (p, ack) => {
      ack = fn(ack);
      bump();
      const now = Date.now();
      createStamps = createStamps.filter((t) => now - t < 10 * 60 * 1000);
      if (createStamps.length >= 6) return ack({ ok: false, error: "You're creating rooms too fast. Wait a few minutes." });
      if (!p || typeof p !== 'object') return ack({ ok: false, error: 'Bad request.' });

      const res = rooms.createCodeRoom({
        locator: p.locator, name: p.name, auth: p.auth, ownerId: userId,
        ttlMs: p.ttlMs, burnWhenEmpty: p.burnWhenEmpty,
      });
      if (!res.ok) return ack(res);
      createStamps.push(now); // only rooms that actually got created count against the allowance
      enter(socket, res.room.key);
      ack({ ok: true, room: rooms.info(res.room) });
    });

    socket.on('room:join', (p, ack) => {
      ack = fn(ack);
      bump();
      if (!p || typeof p !== 'object') return ack({ ok: false, error: 'Bad request.' });

      // Public
      if (p.room === rooms.PUBLIC) {
        enter(socket, rooms.PUBLIC);
        return ack({ ok: true, room: rooms.info(rooms.get(rooms.PUBLIC)) });
      }


      // Join-code room
      const now = Date.now();
      joinFails = joinFails.filter((t) => now - t < 5 * 60 * 1000);
      if (joinFails.length >= 8) return ack({ ok: false, error: 'Too many wrong codes. Wait a few minutes.' });
      const v = rooms.verifyJoin(p.locator, p.auth);
      if (!v.ok) {
        joinFails.push(now);
        return ack(v);
      }
      enter(socket, v.room.key);
      ack({ ok: true, room: rooms.info(v.room) });
    });

    socket.on('room:leave', (p, ack) => {
      ack = fn(ack);
      bump();
      const key = p && p.room;
      if (typeof key !== 'string' || key === rooms.PUBLIC) return ack({ ok: false });
      exit(socket, key);
      ack({ ok: true });
    });

    /* ---------- messages ---------- */
    socket.on('message:send', (p, ack) => {
      ack = fn(ack);
      bump();
      if (limited()) return ack({ ok: false, error: "You're sending messages too fast." });
      if (!p || typeof p !== 'object' || byteSize(p) > MAX_PAYLOAD_BYTES) {
        return ack({ ok: false, error: 'That message is too large.' });
      }
      const key = p.room;
      if (typeof key !== 'string' || !socket.rooms.has(key)) return ack({ ok: false, error: 'Join the room first.' });
      const room = rooms.get(key);
      if (!room) return ack({ ok: false, error: 'That room is gone.' });

      const msg = { id: crypto.randomBytes(6).toString('hex'), room: key, sender: username, uid, ts: Date.now() };
      if (room.type === 'public') {
        const hasAtt = p.att !== undefined && p.att !== null;
        if (typeof p.text !== 'string' && !(hasAtt && p.text === undefined)) return ack({ ok: false, error: 'Malformed message.' });
        const text = cleanText(p.text || '');
        if (!text && !hasAtt) return ack({ ok: false, error: 'Empty message.' });
        if (text.length > PUBLIC_MAX_CHARS) return ack({ ok: false, error: `Max ${PUBLIC_MAX_CHARS} characters in public.` });
        if (hasAtt) {
          const a = p.att;
          if (typeof a !== 'object') return ack({ ok: false, error: 'Malformed message.' });
          if (a.t === 'gif') {
            if (!gifs.enabled()) return ack({ ok: false, error: 'GIFs are turned off on this server.' });
            if (typeof a.id !== 'string' || !gifs.GIF_ID.test(a.id)) return ack({ ok: false, error: 'Malformed message.' });
            msg.att = { t: 'gif', id: a.id, w: dim(a.w), h: dim(a.h) };
          } else if (a.t === 'img') {
            const r = files.attachPublic(a.id, userId, msg.id); // last check, so a failed send never claims the picture
            if (r.error) return ack({ ok: false, error: r.error });
            msg.att = { t: 'img', id: a.id, w: dim(a.w), h: dim(a.h) };
          } else {
            return ack({ ok: false, error: 'Malformed message.' });
          }
        }
        msg.text = text;
        const saved = history.append(msg); // public room only: encrypted rooms are never saved
        if (saved) msg.n = saved.n;
        stats.count('pub');
      } else {
        const { ciphertext, iv } = p;
        if (typeof ciphertext !== 'string' || typeof iv !== 'string' || !ciphertext || !iv ||
            ciphertext.length > CIPHER_MAX_CHARS || iv.length > 32) {
          return ack({ ok: false, error: 'Malformed message.' });
        }
        msg.ciphertext = ciphertext;
        msg.iv = iv;
        stats.count('room');
      }
      io.to(key).emit('message:receive', msg);
      ack({ ok: true, id: msg.id });
    });

    /* ---------- editing / deleting your own messages ----------
     * #public (saved): the server checks it's yours.
     * join-code rooms (never saved): the server stamps who's asking, and every browser only
     * applies it if that matches who sent the original. */
    socket.on('message:edit', (p, ack) => {
      ack = fn(ack);
      bump();
      if (limited()) return ack({ ok: false, error: 'Slow down a little.' });
      if (!p || typeof p !== 'object' || byteSize(p) > MAX_PAYLOAD_BYTES) return ack({ ok: false, error: 'That message is too large.' });
      const key = p.room;
      if (typeof key !== 'string' || !socket.rooms.has(key)) return ack({ ok: false, error: 'Join the room first.' });
      const room = rooms.get(key);
      if (!room) return ack({ ok: false, error: 'That room is gone.' });
      if (typeof p.id !== 'string' || !MSG_REF.test(p.id)) return ack({ ok: false, error: 'Bad request.' });
      const out = { room: key, id: p.id, uid, edited: Date.now() };
      if (room.type === 'public') {
        if (typeof p.text !== 'string') return ack({ ok: false, error: 'Malformed message.' });
        const text = cleanText(p.text);
        if (text.length > PUBLIC_MAX_CHARS) return ack({ ok: false, error: `Max ${PUBLIC_MAX_CHARS} characters in public.` });
        if (history.info().enabled) {
          const rec = history.edit(p.id, uid, text);
          if (!rec) return ack({ ok: false, error: text ? 'You can only edit your own messages.' : "A message can't be empty." });
          out.edited = rec.edited;
        } else if (!text) return ack({ ok: false, error: "A message can't be empty." });
        out.text = text;
      } else {
        const { ciphertext, iv } = p;
        if (typeof ciphertext !== 'string' || typeof iv !== 'string' || !ciphertext || !iv ||
            ciphertext.length > CIPHER_MAX_CHARS || iv.length > 32) return ack({ ok: false, error: 'Malformed message.' });
        out.ciphertext = ciphertext;
        out.iv = iv;
      }
      io.to(key).emit('message:edited', out);
      ack({ ok: true, edited: out.edited });
    });

    socket.on('message:delete', (p, ack) => {
      ack = fn(ack);
      bump();
      if (limited()) return ack({ ok: false, error: 'Slow down a little.' });
      if (!p || typeof p !== 'object') return ack({ ok: false, error: 'Bad request.' });
      const key = p.room;
      if (typeof key !== 'string' || !socket.rooms.has(key)) return ack({ ok: false, error: 'Join the room first.' });
      const room = rooms.get(key);
      if (!room) return ack({ ok: false, error: 'That room is gone.' });
      if (typeof p.id !== 'string' || !MSG_REF.test(p.id)) return ack({ ok: false, error: 'Bad request.' });
      if (room.type === 'public' && history.info().enabled) {
        const rec = history.remove(p.id, uid);
        if (!rec) return ack({ ok: false, error: 'You can only delete your own messages.' });
        if (rec.att && rec.att.t === 'img') files.removeOwn(rec.att.id, userId, 'public');
      } else {
        // nothing saved here: also bin the encrypted files that message pointed at (yours only)
        for (const f of fileList(p.files)) files.removeOwn(f, userId, room.type === 'public' ? 'public' : key);
      }
      io.to(key).emit('message:deleted', { room: key, id: p.id, uid });
      ack({ ok: true });
    });

    let historyStamps = [];
    const historyLimited = () => {
      const now = Date.now();
      historyStamps = historyStamps.filter((t) => now - t < 60000);
      if (historyStamps.length >= 30) return true;
      historyStamps.push(now);
      return false;
    };
    socket.on('history:load', (p, ack) => {
      ack = fn(ack);
      bump();
      if (historyLimited()) return ack({ ok: false, error: 'Slow down a little.' });
      // Only the public room has saved history; everything else is never stored.
      if (!p || p.room !== rooms.PUBLIC) return ack({ ok: true, enabled: false, messages: [], hasMore: false });
      const info = history.info();
      if (!info.enabled) return ack({ ok: true, enabled: false, messages: [], hasMore: false });
      const { messages, hasMore } = history.page({ before: p.before, limit: p.limit });
      ack({ ok: true, enabled: true, messages, hasMore });
    });

    socket.on('typing', (p) => {
      bump();
      const now = Date.now();
      if (now - typingAt < 700) return;
      typingAt = now;
      const key = p && p.room;
      if (typeof key === 'string' && socket.rooms.has(key)) socket.to(key).emit('typing', { room: key, username, uid });
    });

    /* ---------- friend messages: stored as ciphertext, readable only by the two friends ---------- */
    const friendConv = (other) => {
      if (typeof other !== 'string' || other === userId) return null;
      if (!id.areFriends(userId, other) || !id.areFriends(other, userId)) return null;
      return id.privateRoomName(userId, other);
    };
    const MSG_ID = /^[A-Za-z0-9-]{8,64}$/;
    const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
    let dmTypingAt = 0;

    socket.on('dm:send', (p, ack) => {
      ack = fn(ack);
      bump();
      if (limited()) return ack({ ok: false, error: 'Slow down a little.' });
      if (!p || typeof p !== 'object') return ack({ ok: false, error: 'Bad request.' });
      const c = friendConv(p.to);
      if (!c) return ack({ ok: false, error: "You're not friends with this person." });
      const peer = id.getIdentity(p.to);
      const me = id.getIdentity(userId);
      if (!peer || !peer.pub || !me || !me.pub) return ack({ ok: false, error: 'Messages are not set up yet.' });
      if (typeof p.id !== 'string' || !MSG_ID.test(p.id)) return ack({ ok: false, error: 'Bad request.' });
      if (typeof p.iv !== 'string' || p.iv.length !== 16 || !B64.test(p.iv)) return ack({ ok: false, error: 'Bad request.' });
      if (typeof p.ct !== 'string' || !p.ct || p.ct.length > CIPHER_MAX_CHARS || !B64.test(p.ct)) return ack({ ok: false, error: 'Message too long.' });
      if (dm.has(c, p.id)) return ack({ ok: false, error: 'Bad request.' });
      const m = dm.append({ c, id: p.id, f: userId, iv: p.iv, ct: p.ct });
      stats.count('dm');
      io.to(userRoom(userId)).to(userRoom(p.to)).emit('dm:message', m); // the friend, and my other devices
      ack({ ok: true, n: m.n, ts: m.ts });
    });

    socket.on('dm:edit', (p, ack) => {
      ack = fn(ack);
      bump();
      if (limited()) return ack({ ok: false, error: 'Slow down a little.' });
      if (!p || typeof p !== 'object') return ack({ ok: false, error: 'Bad request.' });
      const c = friendConv(p.to);
      if (!c) return ack({ ok: false, error: "You're not friends with this person." });
      if (typeof p.id !== 'string' || !MSG_ID.test(p.id)) return ack({ ok: false, error: 'Bad request.' });
      if (typeof p.iv !== 'string' || p.iv.length !== 16 || !B64.test(p.iv)) return ack({ ok: false, error: 'Bad request.' });
      if (typeof p.ct !== 'string' || !p.ct || p.ct.length > CIPHER_MAX_CHARS || !B64.test(p.ct)) return ack({ ok: false, error: 'Message too long.' });
      const m = dm.edit(c, p.id, userId, p.iv, p.ct);
      if (!m) return ack({ ok: false, error: 'You can only edit your own messages.' });
      io.to(userRoom(userId)).to(userRoom(p.to)).emit('dm:edited', { c, id: m.id, f: m.f, iv: m.iv, ct: m.ct, e: m.e });
      ack({ ok: true, e: m.e });
    });

    socket.on('dm:delete', (p, ack) => {
      ack = fn(ack);
      bump();
      if (limited()) return ack({ ok: false, error: 'Slow down a little.' });
      if (!p || typeof p !== 'object') return ack({ ok: false, error: 'Bad request.' });
      const c = friendConv(p.to);
      if (!c) return ack({ ok: false, error: "You're not friends with this person." });
      if (typeof p.id !== 'string' || !MSG_ID.test(p.id)) return ack({ ok: false, error: 'Bad request.' });
      const m = dm.remove(c, p.id, userId);
      if (!m) return ack({ ok: false, error: 'You can only delete your own messages.' });
      for (const f of fileList(p.files)) files.removeOwn(f, userId, c);
      io.to(userRoom(userId)).to(userRoom(p.to)).emit('dm:deleted', { c, id: m.id });
      ack({ ok: true });
    });

    socket.on('dm:history', (p, ack) => {
      ack = fn(ack);
      bump();
      if (historyLimited()) return ack({ ok: false, error: 'Slow down a little.' });
      const c = friendConv(p && p.friend);
      if (!c) return ack({ ok: false, error: "You're not friends with this person." });
      const { messages, hasMore } = dm.page(c, { before: p.before, limit: p.limit });
      ack({ ok: true, messages, hasMore });
    });

    socket.on('dm:read', (p) => {
      bump();
      const c = friendConv(p && p.friend);
      if (c) dm.markRead(userId, c, p.n);
    });

    socket.on('dm:unread', (_p, ack) => {
      ack = fn(ack);
      const me = id.getIdentity(userId);
      const counts = {};
      for (const f of me ? me.friends : []) {
        const c = friendConv(f);
        const n = c ? dm.unread(userId, c) : 0;
        if (n) counts[f] = n;
      }
      ack({ ok: true, counts });
    });

    socket.on('dm:typing', (p) => {
      bump();
      const now = Date.now();
      if (now - dmTypingAt < 700) return;
      dmTypingAt = now;
      if (friendConv(p && p.to)) io.to(userRoom(p.to)).emit('dm:typing', { from: userId, username });
    });

    /* ---------- friends ---------- */
    socket.on('friends:online', (_p, ack) => {
      ack = fn(ack);
      const friends = id.getIdentity(userId)?.friends || [];
      ack({ online: friends.filter(isOnline) });
    });

    socket.on('activity', bump);

    socket.on('disconnect', () => {
      if (idleTimer) clearTimeout(idleTimer);
      for (const key of rooms.leaveAll(socket.id)) {
        io.to(key).emit('presence:leave', { room: key, username, uid });
        announceCount(key);
      }
      if (!isOnline(userId)) {
        for (const f of id.getIdentity(userId)?.friends || []) io.to(userRoom(f)).emit('friend:presence', { id: userId, online: false });
      }
    });
  });

  /* ---------- server-side events ---------- */
  // Password changed / signed out everywhere: drop that person's open connections.
  bus.on('session:revoked', (userId) => io.in(userRoom(userId)).disconnectSockets(true));
  bus.on('friends:changed', (ids) => ids.forEach((i) => io.to(userRoom(i)).emit('friends:changed')));
  bus.on('friends:removed', ({ a, b, room }) => {
    killConv(room);
    io.to(userRoom(a)).emit('dm:cleared', { friend: b });
    io.to(userRoom(b)).emit('dm:cleared', { friend: a });
  });

  // Conversations with people who no longer exist (expired guests) are deleted.
  setInterval(() => {
    for (const c of dm.conversations()) {
      const pair = id.parseDmRoom(c);
      if (!pair || !id.getIdentity(pair[0]) || !id.getIdentity(pair[1])) killConv(c);
    }
  }, 3600000).unref();

  // Burn rooms whose time is up (or that emptied out, if set to burn when empty).
  const sweeper = setInterval(() => {
    for (const { room, reason } of rooms.expireDue()) {
      io.to(room.key).emit('room:expired', { room: room.key, name: room.name, reason });
      io.in(room.key).socketsLeave(room.key);
      files.dropScope(room.key); // the room's encrypted files burn with it
    }
  }, num(process.env.ROOM_SWEEP_MS, 5000));
  sweeper.unref();
}

module.exports = { attach, MAX_PAYLOAD_BYTES };
