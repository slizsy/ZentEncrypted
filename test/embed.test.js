// embedding the chat inside another site (Fablehop): who may frame it, and how sign-in cookies behave
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { boot, client } = require('./helpers');

const csp = (res) => res.headers.get('content-security-policy') || '';
const frameRule = (res) => (csp(res).match(/frame-ancestors ([^;]*)/) || [])[1];

let srv;
test.before(async () => { srv = await boot(); }); // EMBED_ORIGINS unset: the default applies
test.after(async () => { await srv.close(); });

test('default: only this site and slizsy.github.io may frame the chat, and no X-Frame-Options contradicts that', async () => {
  const res = await fetch(srv.base + '/');
  assert.strictEqual(frameRule(res), "'self' https://slizsy.github.io");
  assert.strictEqual(res.headers.get('x-frame-options'), null, 'X-Frame-Options would block the embed');
  const prof = await fetch(srv.base + '/u/someone');
  assert.strictEqual(frameRule(prof), "'self' https://slizsy.github.io", 'same rule on every page');
  assert.match(csp(res), /script-src 'self'/, 'the rest of the policy is untouched');
});

test('normal sign-in keeps a Lax cookie; inside a frame it becomes SameSite=None + Secure + Partitioned', async () => {
  const normal = await client(srv.base, '10.88.0.1').req('POST', '/api/auth/guest', {});
  assert.strictEqual(normal.status, 200);
  assert.match(normal.setCookie, /SameSite=Lax/i);
  assert.match(normal.setCookie, /HttpOnly/i);
  assert.doesNotMatch(normal.setCookie, /Partitioned|SameSite=None/i);

  const framed = await client(srv.base, '10.88.0.2').req('POST', '/api/auth/guest', {}, { 'x-zent-embed': '1' });
  assert.strictEqual(framed.status, 200);
  assert.match(framed.setCookie, /SameSite=None/i);
  assert.match(framed.setCookie, /Secure/i);
  assert.match(framed.setCookie, /Partitioned/i);
  assert.match(framed.setCookie, /HttpOnly/i);
});

test('a cookie issued for the frame works for the session, and logging out clears the matching cookie', async () => {
  const c = client(srv.base, '10.88.0.3');
  assert.strictEqual((await c.req('POST', '/api/auth/guest', {}, { 'x-zent-embed': '1' })).status, 200);
  assert.strictEqual((await c.req('GET', '/api/auth/me')).status, 200, 'the cookie value is usable');
  const out = await c.req('POST', '/api/auth/logout', {}, { 'x-zent-embed': '1' });
  assert.match(out.setCookie, /^token=;/);
  assert.match(out.setCookie, /Partitioned/i, 'must carry the same attributes or the browser keeps the old cookie');
  assert.match(out.setCookie, /SameSite=None/i);
  const plain = await client(srv.base, '10.88.0.4').req('POST', '/api/auth/logout', {});
  assert.doesNotMatch(plain.setCookie, /Partitioned/i);
  assert.match(plain.setCookie, /SameSite=Lax/i);
});

test('the embed header does not weaken the cross-site request checks', async () => {
  const embedded = { 'x-zent-embed': '1' };
  const crossSite = await client(srv.base, '10.88.0.5').req('POST', '/api/auth/guest', {}, { ...embedded, 'sec-fetch-site': 'cross-site' });
  assert.strictEqual(crossSite.status, 403);
  const evil = await client(srv.base, '10.88.0.6').req('POST', '/api/auth/guest', {}, { ...embedded, origin: 'https://evil.example' });
  assert.strictEqual(evil.status, 403);
  const sameSite = await client(srv.base, '10.88.0.7').req('POST', '/api/auth/guest', {}, { ...embedded, 'sec-fetch-site': 'same-origin' });
  assert.strictEqual(sameSite.status, 200, 'what the page inside the frame really sends');
});

/* the setting is read once at start-up, so each value needs its own server process */
function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
async function frameRuleWith(embedEnv) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zent-embed-'));
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', JWT_SECRET: 'integration-test-secret-integration-test-secret', DB_FILE: path.join(dir, 'db.json') };
  if (embedEnv === undefined) delete env.EMBED_ORIGINS; else env.EMBED_ORIGINS = embedEnv;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        return { rule: frameRule(res), xfo: res.headers.get('x-frame-options') };
      } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    throw new Error('server did not start');
  } finally { child.kill(); }
}

test('EMBED_ORIGINS= (empty) allows no other site to frame the chat', async () => {
  const r = await frameRuleWith('');
  assert.strictEqual(r.rule, "'self'");
  assert.strictEqual(r.xfo, null);
});

test('EMBED_ORIGINS accepts several sites, tolerates spaces, and ignores blanks', async () => {
  const r = await frameRuleWith(' https://one.example , https://two.example ,, ');
  assert.strictEqual(r.rule, "'self' https://one.example https://two.example");
});
