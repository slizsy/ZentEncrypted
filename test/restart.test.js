// Starts the REAL server as a separate process (the way pm2 does), restarts it, and checks saved history survives.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const { io: ioc } = require('socket.io-client');

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(env) {
  const child = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  const ready = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 8000);
    const iv = setInterval(() => { if (out.includes('listening')) { clearInterval(iv); clearTimeout(t); res(); } }, 40);
  });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  return { child, ready, exited, log: () => out };
}

async function client(base) {
  const r = await fetch(base + '/api/auth/guest', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.5.5.' + Math.floor(Math.random() * 250) }, body: '{}' });
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('token=')).split(';')[0];
  const s = ioc(base, { transports: ['websocket'], extraHeaders: { cookie }, reconnection: false, forceNew: true });
  await new Promise((res, rej) => { s.once('session:ready', res); s.once('connect_error', rej); });
  const ack = (ev, p) => new Promise((res) => s.emit(ev, p, res));
  return { s, ack };
}

test('saved public messages survive a graceful restart (SIGTERM, like pm2) and a hard kill (SIGKILL, like a power cut)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zent-restart-'));
  const port = await freePort();
  const env = { PORT: String(port), JWT_SECRET: 'restart-test-secret-restart-test-secret', DB_FILE: path.join(dir, 'db.json'), NODE_ENV: 'production' };
  const base = `http://127.0.0.1:${port}`;

  // --- run 1: say something, stop gracefully
  let srv = start(env); await srv.ready;
  let c = await client(base);
  assert.strictEqual((await c.ack('message:send', { room: 'public', text: 'survives SIGTERM' })).ok, true);
  c.s.close();
  srv.child.kill('SIGTERM');
  const ex1 = await srv.exited;
  assert.strictEqual(ex1.code, 0, 'exits cleanly on SIGTERM: ' + srv.log());

  // --- run 2: it's still there; add another, then pull the plug (SIGKILL)
  srv = start(env); await srv.ready;
  c = await client(base);
  let h = await c.ack('history:load', { room: 'public' });
  assert.deepStrictEqual(h.messages.map((m) => m.text), ['survives SIGTERM']);
  assert.strictEqual((await c.ack('message:send', { room: 'public', text: 'survives SIGKILL' })).ok, true);
  await sleep(300); // give the OS a moment to take the write, as it would in real life
  c.s.close();
  srv.child.kill('SIGKILL');
  await srv.exited;

  // --- run 3: both are there, in order, numbered continuously
  srv = start(env); await srv.ready;
  c = await client(base);
  h = await c.ack('history:load', { room: 'public' });
  assert.deepStrictEqual(h.messages.map((m) => m.text), ['survives SIGTERM', 'survives SIGKILL']);
  assert.deepStrictEqual(h.messages.map((m) => m.n), [1, 2]);
  c.s.close();
  srv.child.kill('SIGTERM'); await srv.exited;

  assert.ok(!fs.readFileSync(path.join(dir, 'db.json'), 'utf8').includes('survives'), 'never in the account database');
});
