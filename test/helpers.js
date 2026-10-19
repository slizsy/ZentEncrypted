const os = require('os');
const path = require('path');
const fs = require('fs');
const { io: ioc } = require('socket.io-client');

/** Boots the real server on a random port with a throwaway database. */
async function boot(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zent-'));
  Object.assign(process.env, {
    NODE_ENV: 'production',
    JWT_SECRET: 'integration-test-secret-integration-test-secret',
    DB_FILE: path.join(dir, 'db.json'),
    ROOM_MIN_TTL_MS: '1000',
    ROOM_SWEEP_MS: '150',
    ROOM_EMPTY_GRACE_MS: '300',
    SHIELD_AUTH_SOFT: '6',
    ...extraEnv,
  });
  const { server, io } = require('../server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, io, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** Minimal cookie-aware HTTP client. */
function client(base, ip) {
  let cookie = '';
  const api = {
    get cookie() { return cookie; },
    async req(method, url, body, headers = {}) {
      const res = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.getSetCookie?.() || [];
      const tok = set.find((c) => c.startsWith('token='));
      if (tok) cookie = tok.split(';')[0];
      let json = null;
      try { json = await res.json(); } catch {}
      return { status: res.status, json, setCookie: tok || '' };
    },
  };
  return api;
}

function connect(base, cookie, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = ioc(base, {
      transports: ['websocket'],
      extraHeaders: { cookie, ...(opts.headers || {}) },
      reconnection: false,
      forceNew: true,
    });
    const events = [];
    s.onAny((ev, ...args) => events.push([ev, ...args]));
    s.once('connect_error', (e) => reject(e));
    s.once('session:ready', (me) => resolve({ s, me, events }));
  });
}

const once = (s, ev, ms = 2000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), ms);
    s.once(ev, (...a) => { clearTimeout(t); res(a.length > 1 ? a : a[0]); });
  });

const ack = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeAuth = () => require('crypto').randomBytes(32).toString('hex');
const fakeLocator = () => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => A[Math.floor(Math.random() * 32)]).join('');
};

module.exports = { boot, client, connect, once, ack, sleep, fakeAuth, fakeLocator };
