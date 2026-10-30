// Entry point: Express, Socket.io and the PeerJS signalling server.
require('dotenv').config();
process.umask(0o077); // account and chat files readable by this user only

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const fs = require('fs');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const { WebSocketServer } = require('ws');

const authRoutes = require('./src/auth');
const friendsRoutes = require('./src/friends');
const realtime = require('./src/realtime');
const shield = require('./src/shield');
const history = require('./src/history');
const files = require('./src/files');
const gifs = require('./src/gifs');
const profiles = require('./src/profiles');
const stats = require('./src/stats');

const app = express();
const server = http.createServer(app);

// cloudflared (or nginx) runs on this machine and talks to us over loopback;
// trusting only loopback keeps X-Forwarded-* spoof-proof from the LAN.
app.set('trust proxy', 'loopback');

// Sites allowed to show ZentEncrypted inside a frame (Fablehop). Comma-separated; set EMBED_ORIGINS= to allow none.
const embedOrigins = (process.env.EMBED_ORIGINS ?? 'https://slizsy.github.io').split(',').map((s) => s.trim()).filter(Boolean);

app.use(
  helmet({
    hsts: false, // TLS is handled by Cloudflare; Node may also be reached over plain http on the LAN
    crossOriginEmbedderPolicy: false,
    xFrameOptions: false, // can't name another site; frame-ancestors below decides who may embed us
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'], // blob: = pictures decrypted in the browser
        connectSrc: ["'self'", 'ws:', 'wss:'],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'", ...embedOrigins],
      },
    },
  })
);

app.use(express.json({ limit: '20kb' }));

const extraOrigins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
const sameHost = (origin, req) => {
  try {
    return new URL(origin).host === (req.get('x-forwarded-host') || req.get('host')) || extraOrigins.includes(origin);
  } catch {
    return false;
  }
};

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // Refuse state-changing requests forged by other websites (CSRF).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'Blocked.' });
    const origin = req.get('origin');
    if (origin && !sameHost(origin, req)) return res.status(403).json({ error: 'Blocked.' });
  }
  next();
});
app.get('/api/config', (req, res) => res.json({ publicUrl: process.env.PUBLIC_URL || null, gifs: gifs.enabled(), uploads: files.config() }));
app.use('/api/auth', authRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/keys', require('./src/keys'));
app.use('/api/files', files.router);
app.use('/api/gifs', gifs.router);
app.use('/api/profiles', profiles.router);
app.use('/api/admin', stats.router);
app.get('/health', (req, res) => res.json({ ok: true }));

// uploaded files and GIFs live outside /api so the browser is allowed to cache them
app.get('/files/:id', files.serve);
app.get('/gif/:id.gif', gifs.mediaLimiter, gifs.media);

// pages: profile pages at /u/name, and the admin page (kept out of search engines)
const page = (name) => (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('X-Robots-Tag', name === 'admin.html' ? 'noindex, nofollow' : 'noindex');
  res.sendFile(path.join(__dirname, 'public', name));
};
app.get('/u/:name', page('profile.html'));
app.get('/admin', page('admin.html'));

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (/\.(woff2|png|ico|svg)$/.test(filePath)) res.set('Cache-Control', 'public, max-age=604800');
      else res.set('Cache-Control', 'no-cache'); // JS/CSS/HTML revalidate so updates show up
    },
  })
);

const io = new Server(server, {
  maxHttpBufferSize: realtime.MAX_PAYLOAD_BYTES + 2048,
  // Refuse cross-site WebSocket handshakes: the Origin must match our own host.
  allowRequest(req, cb) {
    const origin = req.headers.origin;
    if (!origin) return cb(null, true);
    try {
      cb(null, new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host) || extraOrigins.includes(origin));
    } catch {
      cb(null, false);
    }
  },
});
realtime.attach(io);

// Self-hosted WebRTC signaling for the "Link" (peer-to-peer) tab. It only
// brokers the handshake; messages in that mode never touch this server.
//
// IMPORTANT: PeerJS normally attaches its own WebSocket server directly to
// `server`, and the `ws` library answers every upgrade that isn't for its
// path with "400 Bad Request" — which kills Socket.io's websocket transport.
// So we hand PeerJS a detached (noServer) WebSocket server and route the
// upgrade requests ourselves: /peerjs/* -> PeerJS, everything else -> Socket.io.
let peerWss = null;
const peerServer = ExpressPeerServer(server, {
  path: '/',
  allow_discovery: false,
  proxied: true,
  concurrent_limit: 300,
  createWebSocketServer: (opts) => (peerWss = new WebSocketServer({ noServer: true, path: opts.path })),
});
app.use('/peerjs', peerServer);

server.on('upgrade', (req, socket, head) => {
  if (!peerWss) return;
  const pathname = String(req.url || '').split('?')[0];
  if (pathname !== peerWss.options.path) return; // not ours: Socket.io handles /socket.io/
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host) || extraOrigins.includes(origin);
    } catch { /* bad Origin header */ }
    if (!ok) return socket.destroy();
  }
  peerWss.handleUpgrade(req, socket, head, (ws) => peerWss.emit('connection', ws, req));
});

// Tighten permissions on data written by older versions. Folders need 700 (600 would lock us out of them).
const dataDir = path.dirname(process.env.DB_FILE || path.join(__dirname, 'data', 'db.json'));
try {
  fs.chmodSync(dataDir, 0o700);
  for (const f of fs.readdirSync(dataDir)) {
    const full = path.join(dataDir, f);
    try { fs.chmodSync(full, fs.statSync(full).isDirectory() ? 0o700 : 0o600); } catch { /* skip that one */ }
  }
} catch { /* not fatal */ }

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || undefined; // set HOST=127.0.0.1 to accept connections only via the tunnel
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`ZentEncrypted listening on port ${PORT}`);
    if (shield.status().config.always) console.log('Shield: ALWAYS-ON human check is enabled.');
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    history.close(); // flush saved messages before pm2 stops/restarts us
    require('./src/dmstore').close();
    stats.close();
    setTimeout(() => process.exit(0), 150);
  });
}

module.exports = { app, server, io };
