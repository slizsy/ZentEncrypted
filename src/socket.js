/**
 * socket.js
 * All real-time behavior lives here: authenticating sockets via the JWT
 * cookie, joining/leaving rooms, relaying ENCRYPTED payloads only, and
 * enforcing per-socket rate limits / payload size / idle timeouts.
 *
 * IMPORTANT: this server never decrypts, inspects, or stores plaintext
 * message content. It only ever sees and forwards ciphertext produced by
 * the browser's Web Crypto API (see public/js/crypto.js).
 */
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { JWT_SECRET } = require('./auth');

const GLOBAL_ROOM = 'global';

const MAX_MSGS_PER_SEC = Number(process.env.WS_MAX_MESSAGES_PER_SECOND || 5);
const MAX_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES || 10 * 1024);
const IDLE_TIMEOUT_MS = Number(process.env.WS_IDLE_TIMEOUT_MS || 10 * 60 * 1000);

// In-memory only — never persisted. Cleared as clients disconnect/reconnect.
const rooms = new Map(); // roomName -> { members: Set<socketId>, createdBy, isDefault }
rooms.set(GLOBAL_ROOM, { members: new Set(), createdBy: 'system', isDefault: true });

function roomListPublic() {
  return Array.from(rooms.entries()).map(([name, r]) => ({
    name,
    memberCount: r.members.size,
    isDefault: !!r.isDefault,
  }));
}

function byteSize(obj) {
  try {
    return Buffer.byteLength(JSON.stringify(obj));
  } catch {
    return Infinity;
  }
}

function authenticateSocket(socket, next) {
  try {
    const rawCookies = socket.handshake.headers.cookie || '';
    const parsed = cookie.parse(rawCookies);
    const token = parsed.token;
    if (!token) return next(new Error('Unauthorized'));

    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = { id: payload.sub, username: payload.username, role: payload.role };
    return next();
  } catch (err) {
    return next(new Error('Unauthorized'));
  }
}

function initSocket(io) {
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const { username, role } = socket.user;

    // --- Per-socket rate limiting state ---
    let msgTimestamps = [];
    let idleTimer = null;

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        socket.emit('server:notice', { message: 'Disconnected due to inactivity.' });
        socket.disconnect(true);
      }, IDLE_TIMEOUT_MS);
    }
    resetIdleTimer();

    function isRateLimited() {
      const now = Date.now();
      msgTimestamps = msgTimestamps.filter((t) => now - t < 1000);
      msgTimestamps.push(now);
      return msgTimestamps.length > MAX_MSGS_PER_SEC;
    }

    // Join default global room automatically
    socket.join(GLOBAL_ROOM);
    rooms.get(GLOBAL_ROOM).members.add(socket.id);
    io.emit('rooms:update', roomListPublic());
    io.to(GLOBAL_ROOM).emit('presence:join', { username, room: GLOBAL_ROOM });

    socket.emit('rooms:update', roomListPublic());
    socket.emit('session:ready', { username, role, room: GLOBAL_ROOM });

    // --- Create a public room ---
    socket.on('room:create', (roomName) => {
      resetIdleTimer();
      if (typeof roomName !== 'string') return;
      const name = roomName.trim().slice(0, 40);
      if (!name || rooms.has(name)) {
        return socket.emit('server:error', { message: 'Invalid or duplicate room name.' });
      }
      rooms.set(name, { members: new Set(), createdBy: username, isDefault: false });
      io.emit('rooms:update', roomListPublic());
    });

    // --- Join a room ---
    socket.on('room:join', (roomName) => {
      resetIdleTimer();
      if (!rooms.has(roomName)) {
        return socket.emit('server:error', { message: 'Room does not exist.' });
      }
      socket.join(roomName);
      rooms.get(roomName).members.add(socket.id);
      io.to(roomName).emit('presence:join', { username, room: roomName });
      io.emit('rooms:update', roomListPublic());
    });

    // --- Leave a room (never leave the global default) ---
    socket.on('room:leave', (roomName) => {
      resetIdleTimer();
      if (roomName === GLOBAL_ROOM) return;
      socket.leave(roomName);
      const r = rooms.get(roomName);
      if (r) {
        r.members.delete(socket.id);
        io.to(roomName).emit('presence:leave', { username, room: roomName });
        // Clean up empty, non-default rooms
        if (r.members.size === 0 && !r.isDefault) {
          rooms.delete(roomName);
        }
      }
      io.emit('rooms:update', roomListPublic());
    });

    // --- Relay an encrypted chat message. Server sees ciphertext only. ---
    socket.on('message:send', (payload) => {
      resetIdleTimer();

      if (isRateLimited()) {
        return socket.emit('server:error', { message: 'Rate limit exceeded: slow down.' });
      }
      if (byteSize(payload) > MAX_PAYLOAD_BYTES) {
        return socket.emit('server:error', { message: 'Message too large.' });
      }
      if (!payload || typeof payload !== 'object') {
        return socket.emit('server:error', { message: 'Malformed message.' });
      }

      const { room, ciphertext, iv, senderPublicKey } = payload;
      if (!room || !rooms.has(room) || !ciphertext || !iv) {
        return socket.emit('server:error', { message: 'Malformed message.' });
      }

      // Broadcast the opaque ciphertext blob as-is — server does not
      // decrypt, log, or persist message content anywhere.
      io.to(room).emit('message:receive', {
        room,
        ciphertext,
        iv,
        senderPublicKey,
        sender: username,
        ts: Date.now(),
      });
    });

    socket.on('typing', ({ room }) => {
      resetIdleTimer();
      if (room && rooms.has(room)) {
        socket.to(room).emit('typing', { username, room });
      }
    });

    socket.on('disconnect', () => {
      if (idleTimer) clearTimeout(idleTimer);
      for (const [name, r] of rooms.entries()) {
        if (r.members.has(socket.id)) {
          r.members.delete(socket.id);
          io.to(name).emit('presence:leave', { username, room: name });
          if (r.members.size === 0 && !r.isDefault) {
            rooms.delete(name);
          }
        }
      }
      io.emit('rooms:update', roomListPublic());
    });
  });
}

module.exports = { initSocket, MAX_PAYLOAD_BYTES };
