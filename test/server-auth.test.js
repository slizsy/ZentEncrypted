const test = require('node:test');
const assert = require('node:assert');
const { boot, client } = require('./helpers');
const { solve } = require('../public/js/pow-worker.js');

let srv;
test.before(async () => { srv = await boot({ PUBLIC_URL: 'https://chat.example.org' }); });
test.after(async () => { await srv.close(); });

test('health + security headers (no HSTS, strict CSP, no upgrade-insecure-requests)', async () => {
  const r = await fetch(srv.base + '/health');
  assert.strictEqual((await r.json()).ok, true);
  assert.strictEqual(r.headers.get('strict-transport-security'), null);
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp.includes("script-src 'self'") && csp.includes("style-src 'self'"));
  assert.ok(!csp.includes('unsafe-inline'));
  assert.ok(!csp.includes('upgrade-insecure-requests'));
  assert.ok(csp.includes("frame-ancestors 'self' https://slizsy.github.io"), csp);
  assert.strictEqual(r.headers.get('x-frame-options'), null);
});

test('register validation: reserved names, bad chars, short passwords, non-strings', async () => {
  let n = 0;
  const post = (body) => client(srv.base, '10.0.0.' + (++n)).req('POST', '/api/auth/register', body); // fresh visitor each time
  for (const u of ['admin', 'System', 'guest1234', 'ab', 'bad name!', 'x'.repeat(21)]) {
    assert.strictEqual((await post({ username: u, password: 'longenough1' })).status, 400, u);
  }
  assert.strictEqual((await post({ username: 'okname', password: 'short' })).status, 400);
  assert.strictEqual((await post({ username: { $ne: 1 }, password: 'longenough1' })).status, 400);
  assert.strictEqual((await post({ username: 'okname', password: ['a'] })).status, 400);
});

test('register -> login -> me; duplicate names (any case) rejected; wrong password 401', async () => {
  const c = client(srv.base, '10.0.0.2');
  const r = await c.req('POST', '/api/auth/register', { username: 'Alice_1', password: 'correct horse' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await c.req('GET', '/api/auth/me')).json.username, 'Alice_1');
  assert.strictEqual((await client(srv.base, '10.0.0.3').req('POST', '/api/auth/register', { username: 'alice_1', password: 'whatever12' })).status, 409);

  const c2 = client(srv.base, '10.0.0.4');
  assert.strictEqual((await c2.req('POST', '/api/auth/login', { username: 'alice_1', password: 'nope-nope' })).status, 401);
  assert.strictEqual((await c2.req('POST', '/api/auth/login', { username: 'nobody', password: 'nope-nope' })).status, 401);
  const ok = await c2.req('POST', '/api/auth/login', { username: 'ALICE_1', password: 'correct horse' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.role, 'registered');
});

test('login is not blocked by simulated concurrent duplicate signups (race re-check)', async () => {
  const body = { username: 'racer', password: 'racepassword' };
  const rs = await Promise.all([1, 2, 3].map((i) => client(srv.base, '10.1.0.' + i).req('POST', '/api/auth/register', body)));
  assert.strictEqual(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.status)));
});

test('cookie: NOT Secure on plain http (LAN login works), Secure when proxied as https', async () => {
  const plain = await client(srv.base, '10.0.1.1').req('POST', '/api/auth/guest', {});
  assert.ok(plain.setCookie.includes('HttpOnly'));
  assert.ok(!/;\s*Secure/i.test(plain.setCookie), 'Secure cookie over http would silently break LAN logins: ' + plain.setCookie);

  const viaProxy = await client(srv.base, '10.0.1.2').req('POST', '/api/auth/guest', {}, { 'x-forwarded-proto': 'https' });
  assert.ok(/;\s*Secure/i.test(viaProxy.setCookie), viaProxy.setCookie);
});

test('"stay signed in" off => session cookie; on (default) => persistent', async () => {
  const keep = await client(srv.base, '10.0.2.1').req('POST', '/api/auth/guest', {});
  assert.ok(/Max-Age|Expires/i.test(keep.setCookie));
  const session = await client(srv.base, '10.0.2.2').req('POST', '/api/auth/guest', { remember: false });
  assert.ok(!/Max-Age|Expires/i.test(session.setCookie), session.setCookie);
});

test('guest: unique handle, /me works, logout clears cookie', async () => {
  const c = client(srv.base, '10.0.3.1');
  const g = await c.req('POST', '/api/auth/guest', {});
  assert.match(g.json.username, /^Guest\d{4}$/);
  assert.strictEqual((await c.req('GET', '/api/auth/me')).json.role, 'guest');
  const out = await c.req('POST', '/api/auth/logout', {});
  assert.strictEqual(out.json.ok, true);
});

test('rate limits are per real visitor IP, not one shared bucket for the whole site', async () => {
  // 20 failed logins from IP A must not affect IP B
  const a = client(srv.base, '172.16.5.1');
  let sawLimit = false;
  for (let i = 0; i < 20; i++) {
    const r = await a.req('POST', '/api/auth/login', { username: 'nobodyhere', password: 'wrongwrong' }, { 'x-zent-pow': 'skip' });
    if (r.status === 429) { sawLimit = true; break; }
    if (r.status === 428) {
      const ch = r.json.challenge;
      const proof = `${ch.token}|${solve(ch.n, ch.difficulty, 0, 1)}`;
      const r2 = await a.req('POST', '/api/auth/login', { username: 'nobodyhere', password: 'wrongwrong' }, { 'x-zent-pow': proof });
      if (r2.status === 429) { sawLimit = true; break; }
    }
  }
  assert.ok(sawLimit, 'IP A should hit the failed-login limit');
  const b = client(srv.base, '172.16.5.2');
  const r = await b.req('POST', '/api/auth/login', { username: 'someoneelse', password: 'wrongwrong' });
  assert.strictEqual(r.status, 401, 'IP B must be unaffected, got ' + r.status);
});

test('shield: calm visitors never see a challenge; a flood does; solving works; replay fails', async () => {
  const calm = client(srv.base, '192.0.2.10');
  for (let i = 0; i < 3; i++) assert.strictEqual((await calm.req('POST', '/api/auth/guest', {})).status, 200);

  const bot = client(srv.base, '192.0.2.99');
  let challenge = null;
  for (let i = 0; i < 12; i++) {
    const r = await bot.req('POST', '/api/auth/guest', {});
    if (r.status === 428) { challenge = r.json.challenge; break; }
    assert.strictEqual(r.status, 200);
  }
  assert.ok(challenge, 'a burst of requests must trigger the human check');
  assert.ok(challenge.difficulty >= 15 && challenge.difficulty <= 20);

  const proof = `${challenge.token}|${solve(challenge.n, challenge.difficulty, 0, 1)}`;
  const ok = await bot.req('POST', '/api/auth/guest', {}, { 'x-zent-pow': proof });
  assert.strictEqual(ok.status, 200, 'solved proof should be accepted (no retry loop)');
  const replay = await bot.req('POST', '/api/auth/guest', {}, { 'x-zent-pow': proof });
  assert.strictEqual(replay.status, 428, 'a proof must be single-use');

  // proof is bound to the network it was issued for
  const other = client(srv.base, '192.0.2.77');
  const st = await bot.req('POST', '/api/auth/guest', {});
  const ch2 = st.json.challenge;
  const p2 = `${ch2.token}|${solve(ch2.n, ch2.difficulty, 0, 1)}`;
  for (let i = 0; i < 8; i++) await other.req('POST', '/api/auth/guest', {});
  const stolen = await other.req('POST', '/api/auth/guest', {}, { 'x-zent-pow': p2 });
  assert.notStrictEqual(stolen.status, 200, 'a proof issued to another network must not work');
});

test('friends API needs auth; bad input handled', async () => {
  assert.strictEqual((await client(srv.base, '10.9.0.1').req('GET', '/api/friends/me')).status, 401);
  const c = client(srv.base, '10.9.0.2');
  await c.req('POST', '/api/auth/guest', {});
  assert.strictEqual((await c.req('POST', '/api/friends/add', {})).status, 400);
  assert.strictEqual((await c.req('POST', '/api/friends/add', { code: 'ZZZZ-ZZZZ' })).status, 404);
  const me = await c.req('GET', '/api/friends/me');
  assert.strictEqual((await c.req('POST', '/api/friends/add', { code: me.json.friendCode })).status, 400);
  assert.ok(me.json.expiresAt > Date.now(), 'guest codes expire');
});


const { connect, once } = require('./helpers');
const db = require('../config/database');
const bcryptjs = require('bcryptjs');
const solveFor = (ch) => `${ch.token}|${solve(ch.n, ch.difficulty, 0, 1)}`;
let ipn = 0; const ipx = () => `10.66.${Math.floor(++ipn / 250)}.${(ipn % 250) + 1}`;

test('password rules: common passwords, passwords containing the username, and one-character repeats are refused', async () => {
  for (const [u, pw] of [['plainjoe', 'password123'], ['plainjoe', 'qwertyuiop'], ['mikesmith', 'xx-MikeSmith-99'], ['repeatguy', 'aaaaaaaaaaaa']]) {
    const r = await client(srv.base, ipx()).req('POST', '/api/auth/register', { username: u, password: pw });
    assert.strictEqual(r.status, 400, `${u}/${pw} should be refused`);
  }
  assert.strictEqual((await client(srv.base, ipx()).req('POST', '/api/auth/register', { username: 'plainjoe', password: 'river-lamp-42-tide' })).status, 201);
});

test('old bcrypt accounts still sign in, and their hash is upgraded to scrypt on the way', async () => {
  db.get('users').push({ id: '11111111-2222-4333-8444-555555555555', username: 'legacyUser', usernameLower: 'legacyuser', passwordHash: bcryptjs.hashSync('old-account-pass-7', 10), friendCode: 'LGCY-0001', friends: [], createdAt: new Date().toISOString() }).write();
  const c = client(srv.base, ipx());
  assert.strictEqual((await c.req('POST', '/api/auth/login', { username: 'legacyuser', password: 'old-account-pass-7' })).status, 200);
  const stored = db.get('users').find({ usernameLower: 'legacyuser' }).value().passwordHash;
  assert.ok(stored.startsWith('scrypt$'), 'hash upgraded: ' + stored.slice(0, 10));
  assert.strictEqual((await client(srv.base, ipx()).req('POST', '/api/auth/login', { username: 'legacyuser', password: 'old-account-pass-7' })).status, 200, 'still works after upgrade');
  assert.strictEqual((await client(srv.base, ipx()).req('POST', '/api/auth/login', { username: 'legacyuser', password: 'wrong-pass-1234' })).status, 401);
});

test('change password: needs the current one, follows the rules, signs out every OTHER device (cookies and live sockets), keeps this one', async () => {
  const phone = client(srv.base, ipx()), laptop = client(srv.base, ipx());
  await phone.req('POST', '/api/auth/register', { username: 'changer', password: 'first-pass-river-9' });
  await laptop.req('POST', '/api/auth/login', { username: 'changer', password: 'first-pass-river-9' });
  const sock = await connect(srv.base, laptop.cookie);
  const dropped = once(sock.s, 'disconnect', 4000);

  assert.strictEqual((await phone.req('POST', '/api/auth/password', { current: 'nope-nope-nope', next: 'second-pass-lake-3' })).status, 401);
  assert.strictEqual((await phone.req('POST', '/api/auth/password', { current: 'first-pass-river-9', next: 'password123' })).status, 400);
  assert.strictEqual((await phone.req('POST', '/api/auth/password', { current: 'first-pass-river-9', next: 'second-pass-lake-3' })).status, 200);

  await dropped; // the laptop's live connection was cut
  assert.strictEqual((await laptop.req('GET', '/api/auth/me')).status, 401, 'other device is signed out');
  await assert.rejects(connect(srv.base, laptop.cookie), /Unauthorized/, 'and cannot reconnect');
  assert.strictEqual((await phone.req('GET', '/api/auth/me')).status, 200, 'this device stays signed in');
  assert.strictEqual((await client(srv.base, ipx()).req('POST', '/api/auth/login', { username: 'changer', password: 'first-pass-river-9' })).status, 401);
  assert.strictEqual((await client(srv.base, ipx()).req('POST', '/api/auth/login', { username: 'changer', password: 'second-pass-lake-3' })).status, 200);
});

test('sign out everywhere kills every session, including this one; guests cannot change a password', async () => {
  const a = client(srv.base, ipx()), b = client(srv.base, ipx());
  await a.req('POST', '/api/auth/register', { username: 'everywhere', password: 'tall-oak-map-55' });
  await b.req('POST', '/api/auth/login', { username: 'everywhere', password: 'tall-oak-map-55' });
  assert.strictEqual((await a.req('POST', '/api/auth/logout-all', {})).status, 200);
  assert.strictEqual((await b.req('GET', '/api/auth/me')).status, 401);
  const g = client(srv.base, ipx());
  await g.req('POST', '/api/auth/guest', {});
  assert.strictEqual((await g.req('POST', '/api/auth/password', { current: 'x', next: 'y-y-y-y-y-y-1' })).status, 403);
});

test('forged cross-site requests are blocked (CSRF), same-site ones work', async () => {
  const c = client(srv.base, ipx());
  assert.strictEqual((await c.req('POST', '/api/auth/guest', {}, { origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await c.req('POST', '/api/auth/guest', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.strictEqual((await c.req('POST', '/api/auth/guest', {}, { origin: 'not a url' })).status, 403);
  assert.strictEqual((await c.req('POST', '/api/auth/guest', {}, { origin: srv.base })).status, 200);
  assert.strictEqual((await c.req('POST', '/api/auth/logout', {}, { origin: 'https://evil.example' })).status, 403);
});

test('credential stuffing spread across many networks: after 5 misses the account needs a puzzle from ANY network; the owner can still get in', async () => {
  db.get('users').push({ id: '99999999-2222-4333-8444-555555555555', username: 'victim', usernameLower: 'victim', passwordHash: await require('../src/passwords').hash('real-owner-pass-1'), friendCode: 'VCTM-0001', friends: [], tokenVersion: 0, createdAt: new Date().toISOString() }).write();
  for (let i = 0; i < 5; i++) assert.strictEqual((await client(srv.base, ipx()).req('POST', '/api/auth/login', { username: 'victim', password: 'guess-' + i + '-abcdef' })).status, 401);
  const attacker = client(srv.base, ipx());
  const r = await attacker.req('POST', '/api/auth/login', { username: 'VICTIM', password: 'guess-x-abcdef' });
  assert.strictEqual(r.status, 428, 'a brand new network still has to solve the puzzle (case-insensitive account match)');
  assert.ok(r.json.challenge.difficulty >= 16);
  const owner = client(srv.base, ipx());
  const ch = (await owner.req('POST', '/api/auth/login', { username: 'victim', password: 'real-owner-pass-1' })).json.challenge;
  const ok = await owner.req('POST', '/api/auth/login', { username: 'victim', password: 'real-owner-pass-1' }, { 'x-zent-pow': solveFor(ch) });
  assert.strictEqual(ok.status, 200, 'owner gets in after the puzzle');
  assert.strictEqual((await client(srv.base, ipx()).req('POST', '/api/auth/login', { username: 'victim', password: 'real-owner-pass-1' })).status, 200, 'a success clears the account flag');
});

test('/api/config tells the page the secure address; private data files are not world-readable', async () => {
  const r = await fetch(srv.base + '/api/config');
  const cfg = await r.json();
  assert.strictEqual(cfg.publicUrl, 'https://chat.example.org');
  assert.strictEqual(cfg.gifs, false, 'GIFs stay off without an API key');
  assert.deepStrictEqual(Object.keys(cfg.uploads).sort(), ['enabled', 'maxBytes', 'publicUploads']);
  assert.ok(!JSON.stringify(cfg).includes(process.env.JWT_SECRET), 'no secrets in the config');
  const fs = require('fs');
  const mode = fs.statSync(process.env.DB_FILE).mode & 0o777;
  assert.strictEqual(mode & 0o077, 0, 'db.json is private to the owner, mode ' + mode.toString(8));
});

test('admin page is off unless ADMIN_PASSWORD is set; uploads need a session', async () => {
  const r = await fetch(srv.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '' }) });
  assert.strictEqual(r.status, 404);
  assert.strictEqual((await r.json()).off, true);
  assert.strictEqual((await fetch(srv.base + '/api/admin/stats')).status, 404);
  const up = await fetch(srv.base + '/api/files', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-zent-scope': 'public' }, body: 'x' });
  assert.strictEqual(up.status, 401);
});
