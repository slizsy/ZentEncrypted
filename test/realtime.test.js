const test = require('node:test');
const assert = require('node:assert');
const { boot, client, connect, once, ack, sleep, fakeAuth, fakeLocator } = require('./helpers');

let srv, ipN = 0;
const nextIp = () => `10.20.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const sockets = [];

async function guest() {
  const ip = nextIp();
  const c = client(srv.base, ip);
  const r = await c.req('POST', '/api/auth/guest', {});
  assert.strictEqual(r.status, 200, 'guest sign-in failed: ' + r.status);
  const conn = await connect(srv.base, c.cookie, { headers: { 'cf-connecting-ip': ip } });
  sockets.push(conn.s);
  return { c, ...conn };
}
const passwordsByName = {};
async function member(name) {
  const ip = nextIp();
  const c = client(srv.base, ip);
  const pw = (passwordsByName[name] = 'Tq7-' + Math.random().toString(36).slice(2, 10) + '-zv');
  const r = await c.req('POST', '/api/auth/register', { username: name, password: pw });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const conn = await connect(srv.base, c.cookie, { headers: { 'cf-connecting-ip': ip } });
  sockets.push(conn.s);
  return { c, ...conn, id: r.json.id, ip };
}

test.before(async () => { srv = await boot(); });
test.after(async () => { sockets.forEach((s) => s.close()); await srv.close(); });

test('sockets need a valid session; foreign Origin is refused', async () => {
  await assert.rejects(connect(srv.base, ''), /Unauthorized/);
  await assert.rejects(connect(srv.base, 'token=garbage'), /Unauthorized/);
  const c = client(srv.base, nextIp());
  await c.req('POST', '/api/auth/guest', {});
  await assert.rejects(connect(srv.base, c.cookie, { headers: { origin: 'https://evil.example' } }));
  const ok = await connect(srv.base, c.cookie, { headers: { origin: new URL(srv.base).origin } });
  sockets.push(ok.s);
  assert.ok(ok.me.uid && ok.me.room === 'public');
});

test('public room: plaintext relay to everyone, sender included, with stable uid; never needs a passphrase', async () => {
  const a = await guest(), b = await guest();
  const got = once(b.s, 'message:receive');
  const echo = once(a.s, 'message:receive');
  const res = await ack(a.s, 'message:send', { room: 'public', text: '  hello  <b>world</b>  ' });
  assert.strictEqual(res.ok, true);
  const m = await got;
  assert.strictEqual(m.text, 'hello  <b>world</b>');
  assert.strictEqual(m.sender, a.me.username);
  assert.strictEqual(m.uid, a.me.uid);
  assert.ok(m.id && m.ts);
  assert.strictEqual((await echo).id, m.id);
  assert.ok(!('ciphertext' in m));
});

test('public room: empty / oversized / wrong-shape / control-char messages are handled', async () => {
  const a = await guest();
  assert.strictEqual((await ack(a.s, 'message:send', { room: 'public', text: '   ' })).ok, false);
  assert.strictEqual((await ack(a.s, 'message:send', { room: 'public', text: 'x'.repeat(1001) })).ok, false);
  assert.strictEqual((await ack(a.s, 'message:send', { room: 'public', text: 42 })).ok, false);
  assert.strictEqual((await ack(a.s, 'message:send', { room: 'public', text: 'a'.repeat(5000) })).ok, false); // over app limit
  assert.strictEqual((await ack(a.s, 'message:send', null)).ok, false);
  assert.strictEqual((await ack(a.s, 'message:send', { room: 'public', ciphertext: 'x', iv: 'y' })).ok, false);
  await sleep(1100); // the flood limiter (5/s) counts rejected attempts too
  const got = once(a.s, 'message:receive');
  await ack(a.s, 'message:send', { room: 'public', text: 'a\u0000b\u202Ec' });
  assert.strictEqual((await got).text, 'abc');
  // missing ack callback must not crash the server
  a.s.emit('message:send', { room: 'public', text: 'no ack' });
  a.s.emit('room:join');
  await sleep(1100);
  assert.strictEqual((await ack(a.s, 'message:send', { room: 'public', text: 'still alive' })).ok, true);
});

test('a frame bigger than the hard cap drops the connection (DoS protection)', async () => {
  const a = await guest();
  const closed = new Promise((r) => a.s.once('disconnect', r));
  a.s.emit('message:send', { room: 'public', text: 'a'.repeat(40000) });
  await Promise.race([closed, sleep(3000).then(() => { throw new Error('socket was not dropped'); })]);
});

test('flooding: more than 5 messages/second is refused', async () => {
  const a = await guest();
  const results = [];
  for (let i = 0; i < 12; i++) results.push((await ack(a.s, 'message:send', { room: 'public', text: 'spam ' + i })).ok);
  assert.ok(results.filter(Boolean).length <= 6, JSON.stringify(results));
  assert.ok(results.includes(false));
});

test('cannot post into a room you have not joined (old bug: any socket could)', async () => {
  const a = await guest(), outsider = await guest();
  const locator = fakeLocator();
  const made = await ack(a.s, 'room:create', { name: 'Secret', locator, auth: fakeAuth(), ttlMs: 60000 });
  assert.strictEqual(made.ok, true);
  const r = await ack(outsider.s, 'message:send', { room: made.room.key, ciphertext: 'abc', iv: 'def' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Join/);
});

test('join-code room: create, join with right code, wrong code gets a generic error, ciphertext relays', async () => {
  const a = await guest(), b = await guest(), c = await guest();
  const locator = fakeLocator(), auth = fakeAuth();
  const made = await ack(a.s, 'room:create', { name: '  Study\u0000 group  ', locator, auth, ttlMs: 60000 });
  assert.strictEqual(made.ok, true);
  assert.strictEqual(made.room.name, 'Study group');
  assert.strictEqual(made.room.key, 'c:' + locator);
  assert.ok(made.room.expiresAt > Date.now());

  const bad = await ack(b.s, 'room:join', { locator, auth: fakeAuth() });
  const missing = await ack(b.s, 'room:join', { locator: 'ZZZZ', auth: fakeAuth() });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, missing.error, 'wrong code and unknown room must look identical');
  assert.strictEqual((await ack(b.s, 'room:join', { locator: 'bad!', auth: 'nope' })).ok, false);
  assert.strictEqual((await ack(b.s, 'room:join', { locator })).ok, false);

  const good = await ack(b.s, 'room:join', { locator, auth });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.room.count, 2);

  const got = once(b.s, 'message:receive');
  assert.strictEqual((await ack(a.s, 'message:send', { room: made.room.key, ciphertext: 'Zm9v', iv: 'YmFy' })).ok, true);
  const m = await got;
  assert.strictEqual(m.ciphertext, 'Zm9v');
  assert.ok(!('text' in m));

  // c never joined => hears nothing, and can't send
  let heard = false;
  c.s.once('message:receive', () => (heard = true));
  await ack(a.s, 'message:send', { room: made.room.key, ciphertext: 'a', iv: 'b' });
  await sleep(150);
  assert.strictEqual(heard, false);
});

test('join-code room: a room locks after repeated wrong guesses', async () => {
  const owner = await guest();
  const locator = fakeLocator(), auth = fakeAuth();
  await ack(owner.s, 'room:create', { name: 'Locked', locator, auth, ttlMs: 60000 });
  for (let i = 0; i < 4; i++) { // spread attempts over several sockets so the per-socket cap doesn't hide the room lock
    const g = await guest();
    for (let k = 0; k < 6; k++) await ack(g.s, 'room:join', { locator, auth: fakeAuth() });
  }
  const late = await guest();
  const r = await ack(late.s, 'room:join', { locator, auth });
  assert.strictEqual(r.ok, false, 'even the RIGHT code is refused while locked');
  assert.match(r.error, /locked/i);
});

test('per-socket wrong-code guessing is capped', async () => {
  const g = await guest();
  let last;
  for (let i = 0; i < 12; i++) last = await ack(g.s, 'room:join', { locator: fakeLocator(), auth: fakeAuth() });
  assert.match(last.error, /Too many/);
});

test('rooms burn at their deadline: everyone is told, room is gone, code no longer works', async () => {
  const a = await guest(), b = await guest();
  const locator = fakeLocator(), auth = fakeAuth();
  const made = await ack(a.s, 'room:create', { name: 'Short lived', locator, auth, ttlMs: 1000 }); // server min is 1000ms in tests
  await ack(b.s, 'room:join', { locator, auth });
  const expA = once(a.s, 'room:expired', 4000);
  const expB = once(b.s, 'room:expired', 4000);
  const ea = await expA, eb = await expB;
  assert.strictEqual(ea.room, made.room.key);
  assert.strictEqual(eb.reason, 'expired');
  const late = await guest();
  assert.strictEqual((await ack(late.s, 'room:join', { locator, auth })).ok, false);
  assert.strictEqual((await ack(a.s, 'message:send', { room: made.room.key, ciphertext: 'a', iv: 'b' })).ok, false);
});

test('TTL is clamped to the server min/max', async () => {
  const a = await guest();
  const lo = await ack(a.s, 'room:create', { name: 'lo', locator: fakeLocator(), auth: fakeAuth(), ttlMs: 1 });
  assert.ok(lo.room.expiresAt - Date.now() >= 900);
  const hi = await ack(a.s, 'room:create', { name: 'hi', locator: fakeLocator(), auth: fakeAuth(), ttlMs: 1e15 });
  assert.ok(hi.room.expiresAt - Date.now() <= 7 * 24 * 3600 * 1000 + 1000);
  const nan = await ack(a.s, 'room:create', { name: 'nan', locator: fakeLocator(), auth: fakeAuth(), ttlMs: 'soon' });
  assert.strictEqual(nan.ok, true);
});

test('burn-when-empty: the room disappears after everyone leaves', async () => {
  const a = await guest(), watcher = await guest();
  const locator = fakeLocator(), auth = fakeAuth();
  await ack(a.s, 'room:create', { name: 'Burner', locator, auth, ttlMs: 600000, burnWhenEmpty: true });
  a.s.disconnect();
  await sleep(900); // grace 300ms + sweep 150ms
  assert.strictEqual((await ack(watcher.s, 'room:join', { locator, auth })).ok, false);
});

test('a normal room survives its owner leaving (until its timer ends)', async () => {
  const a = await guest(), b = await guest();
  const locator = fakeLocator(), auth = fakeAuth();
  await ack(a.s, 'room:create', { name: 'Persist', locator, auth, ttlMs: 600000 });
  a.s.disconnect();
  await sleep(700);
  assert.strictEqual((await ack(b.s, 'room:join', { locator, auth })).ok, true);
});

test('room creation validation + per-user cap + duplicate locator', async () => {
  const a = await guest();
  const mk = (over = {}) => ack(a.s, 'room:create', { name: 'r', locator: fakeLocator(), auth: fakeAuth(), ttlMs: 60000, ...over });
  assert.strictEqual((await mk({ name: '   ' })).ok, false);
  assert.strictEqual((await mk({ auth: 'short' })).ok, false);
  assert.strictEqual((await mk({ locator: 'abcd' })).ok, false);
  assert.strictEqual((await mk({ locator: 'OOOO' })).ok, false);
  const loc = fakeLocator();
  assert.strictEqual((await mk({ locator: loc })).ok, true);
  assert.strictEqual((await mk({ locator: loc })).error, 'taken');
  for (let i = 0; i < 3; i++) assert.strictEqual((await mk()).ok, true);
  const fifth = await mk();
  assert.strictEqual(fifth.ok, true);
  const sixth = await mk();
  assert.strictEqual(sixth.ok, false);
  assert.match(sixth.error, /5 active rooms|too fast/);
});

const fakeKeys = (seed = 1) => ({ pub: Buffer.alloc(65, seed).toString('base64'), wrapped: Buffer.alloc(150, seed).toString('base64'), salt: Buffer.alloc(16, seed).toString('base64'), iv: Buffer.alloc(12, seed).toString('base64'), iters: 310000 });
const setKeys = async (who, seed) => assert.strictEqual((await who.c.req('POST', '/api/keys', fakeKeys(seed))).status, 201);
const ct = (s) => Buffer.from(s).toString('base64');
const iv = Buffer.alloc(12, 7).toString('base64');
let mid = 0; const msgId = () => 'msg-' + (++mid).toString().padStart(6, '0') + '-' + Date.now();
const befriend = async (x, y) => { const code = (await y.c.req('GET', '/api/friends/me')).json.friendCode; assert.strictEqual((await x.c.req('POST', '/api/friends/add', { code })).status, 201); };

test('friend messages: only real friends; they wait for an offline friend; unread + read markers; my other devices get copies; unfriend deletes the chat', async () => {
  const a = await member('dmAlice'), b = await member('dmBob'), eve = await member('dmEve');
  await setKeys(a, 1); await setKeys(b, 2); await setKeys(eve, 3);

  assert.strictEqual((await ack(a.s, 'dm:send', { to: b.id, id: msgId(), iv, ct: ct('hi') })).ok, false, 'not friends yet');
  assert.strictEqual((await ack(a.s, 'dm:history', { friend: b.id })).ok, false);

  const notifyB = once(b.s, 'friends:changed');
  await befriend(a, b);
  await notifyB;
  const list = (await a.c.req('GET', '/api/friends/list')).json.friends;
  assert.strictEqual(list[0].pub, fakeKeys(2).pub, "friend list carries the friend's public key");

  assert.strictEqual((await ack(eve.s, 'dm:send', { to: a.id, id: msgId(), iv, ct: ct('x') })).ok, false, 'eve is not a friend');
  assert.strictEqual((await ack(eve.s, 'dm:history', { friend: b.id })).ok, false);
  for (const bad of [{ to: b.id, id: 'x', iv, ct: ct('a') }, { to: b.id, id: msgId(), iv: 'short', ct: ct('a') }, { to: b.id, id: msgId(), iv, ct: '<script>' }, { to: b.id, id: msgId(), iv, ct: 'A'.repeat(7004) }, { to: a.id, id: msgId(), iv, ct: ct('me') }, null]) {
    assert.strictEqual((await ack(a.s, 'dm:send', bad)).ok, false, JSON.stringify(bad && { ...bad, ct: String(bad.ct).slice(0, 10) }));
  }

  await sleep(1100); // let the flood guard reset after the burst of bad sends
  // Bob goes offline; Alice writes anyway, and her second device gets a copy
  b.s.disconnect();
  const a2 = await connect(srv.base, a.c.cookie, { headers: { 'cf-connecting-ip': a.ip } }); sockets.push(a2.s);
  const copy = once(a2.s, 'dm:message');
  const s1 = await ack(a.s, 'dm:send', { to: b.id, id: msgId(), iv, ct: ct('while you were away') });
  assert.strictEqual(s1.ok, true, 'send failed: ' + s1.error);
  assert.strictEqual((await copy).ct, ct('while you were away'));
  await sleep(1100);
  assert.strictEqual((await ack(a.s, 'dm:send', { to: b.id, id: msgId(), iv, ct: ct('second one') })).ok, true);

  // Bob comes back: two unread, history has both in order with only the expected fields
  const b2 = await connect(srv.base, b.c.cookie, { headers: { 'cf-connecting-ip': b.ip } }); sockets.push(b2.s);
  assert.deepStrictEqual((await ack(b2.s, 'dm:unread', {})).counts, { [a.id]: 2 });
  const h = await ack(b2.s, 'dm:history', { friend: a.id });
  assert.deepStrictEqual(h.messages.map((m) => Buffer.from(m.ct, 'base64').toString()), ['while you were away', 'second one']);
  assert.deepStrictEqual(Object.keys(h.messages[0]).sort(), ['c', 'ct', 'f', 'id', 'iv', 'n', 'ts']);
  assert.strictEqual(h.messages[0].f, a.id);
  b2.s.emit('dm:read', { friend: a.id, n: h.messages[1].n });
  await sleep(100);
  assert.deepStrictEqual((await ack(b2.s, 'dm:unread', {})).counts, {});
  assert.deepStrictEqual((await ack(a.s, 'dm:unread', {})).counts, {}, "my own messages are never unread for me");

  // live delivery + typing go only to the friend
  const live = once(b2.s, 'dm:message');
  await sleep(1100);
  await ack(a.s, 'dm:send', { to: b.id, id: msgId(), iv, ct: ct('live now') });
  assert.strictEqual((await live).ct, ct('live now'));
  const typing = once(b2.s, 'dm:typing');
  let eveSaw = false; eve.s.once('dm:typing', () => (eveSaw = true));
  a.s.emit('dm:typing', { to: b.id });
  assert.strictEqual((await typing).from, a.id);
  eve.s.emit('dm:typing', { to: b.id });
  await sleep(150);
  assert.strictEqual(eveSaw, false);

  // unfriend: both told, conversation deleted on the server
  const cleared = once(b2.s, 'dm:cleared');
  assert.strictEqual((await a.c.req('DELETE', `/api/friends/${b.id}`)).status, 200);
  assert.strictEqual((await cleared).friend, a.id);
  const conv = `dm:${[a.id, b.id].sort().join(':')}`;
  assert.strictEqual(require('../src/dmstore').page(conv).messages.length, 0);
  assert.strictEqual((await ack(b2.s, 'dm:history', { friend: a.id })).ok, false);
});

test('message keys: set once, bad shapes refused, reset needs the password and deletes old chats; guests keep a public key only; no key = no messages', async () => {
  const k = await member('keyKate'), f = await member('keyFrank');
  assert.deepStrictEqual((await k.c.req('GET', '/api/keys/me')).json, { keys: null });
  for (const bad of [{}, { ...fakeKeys(4), pub: 'short' }, { ...fakeKeys(4), iters: 10 }, { ...fakeKeys(4), wrapped: '<b>' }, { pub: fakeKeys(4).pub }]) {
    assert.strictEqual((await k.c.req('POST', '/api/keys', bad)).status, 400);
  }
  await befriend(k, f);
  assert.strictEqual((await ack(k.s, 'dm:send', { to: f.id, id: msgId(), iv, ct: ct('x') })).ok, false, 'neither has keys yet');
  await setKeys(k, 4);
  assert.strictEqual((await k.c.req('POST', '/api/keys', fakeKeys(5))).status, 409, 'cannot silently replace a key');
  assert.strictEqual((await k.c.req('GET', '/api/keys/me')).json.keys.pub, fakeKeys(4).pub);
  assert.strictEqual((await ack(k.s, 'dm:send', { to: f.id, id: msgId(), iv, ct: ct('x') })).ok, false, 'friend has no key yet');
  await setKeys(f, 6);
  assert.strictEqual((await ack(k.s, 'dm:send', { to: f.id, id: msgId(), iv, ct: ct('now it works') })).ok, true);

  assert.strictEqual((await k.c.req('POST', '/api/keys/reset', { password: 'wrong-wrong-1' })).status, 401);
  assert.strictEqual((await k.c.req('POST', '/api/keys/reset', { password: passwordsByName.keyKate })).status, 200);
  assert.deepStrictEqual((await k.c.req('GET', '/api/keys/me')).json, { keys: null });
  assert.strictEqual((await ack(f.s, 'dm:history', { friend: k.id })).messages.length, 0, 'old chat deleted (nobody could read it any more)');

  const g = await guest();
  assert.strictEqual((await g.c.req('POST', '/api/keys', { pub: fakeKeys(7).pub })).status, 201);
  assert.deepStrictEqual((await g.c.req('GET', '/api/keys/me')).json, { keys: { pub: fakeKeys(7).pub } });
  assert.strictEqual((await g.c.req('POST', '/api/keys', { pub: fakeKeys(8).pub })).status, 409);
  assert.strictEqual((await g.c.req('POST', '/api/keys/reset', {})).status, 200);
  assert.deepStrictEqual((await g.c.req('GET', '/api/keys/me')).json, { keys: null });
});

test('changing password re-locks the message key in the same step (refused without it)', async () => {
  const p = await member('keyPat');
  await setKeys(p, 9);
  const pw = passwordsByName.keyPat;
  assert.strictEqual((await p.c.req('POST', '/api/auth/password', { current: pw, next: 'brand-new-pass-77' })).status, 400, 'no re-locked key => refused');
  const relocked = { ...fakeKeys(10), pub: undefined };
  assert.strictEqual((await p.c.req('POST', '/api/auth/password', { current: pw, next: 'brand-new-pass-77', keys: relocked })).status, 200);
  const keys = (await p.c.req('GET', '/api/keys/me')).json.keys;
  assert.strictEqual(keys.wrapped, fakeKeys(10).wrapped, 'locked copy replaced');
  assert.strictEqual(keys.pub, fakeKeys(9).pub, 'public key unchanged, so friends notice nothing');
});

test('friend presence: online/offline pushed to friends; friends:online lists who is up', async () => {
  const a = await member('presA'), b = await member('presB');
  await a.c.req('POST', '/api/friends/add', { code: (await b.c.req('GET', '/api/friends/me')).json.friendCode });
  const who = await ack(a.s, 'friends:online', {});
  assert.deepStrictEqual(who.online, [b.id]);
  const offline = once(a.s, 'friend:presence');
  b.s.disconnect();
  const p = await offline;
  assert.deepStrictEqual(p, { id: b.id, online: false });
  const b2c = client(srv.base, nextIp());
  await b2c.req('POST', '/api/auth/login', { username: 'presB', password: passwordsByName.presB });
  const online = once(a.s, 'friend:presence');
  const b2 = await connect(srv.base, b2c.cookie, { headers: { 'cf-connecting-ip': b.ip } }); sockets.push(b2.s);
  assert.deepStrictEqual(await online, { id: b.id, online: true });
});

test('guests and members can be friends; guest friendship is in memory only', async () => {
  const g = await guest(), m = await member('memFriend');
  const code = (await m.c.req('GET', '/api/friends/me')).json.friendCode;
  const r = await g.c.req('POST', '/api/friends/add', { code });
  assert.strictEqual(r.status, 201);
  const list = await m.c.req('GET', '/api/friends/list');
  assert.strictEqual(list.json.friends[0].username, g.me.username);
  assert.strictEqual(list.json.friends[0].role, 'guest');
});

test('presence + counts: joining/leaving announces and counts update', async () => {
  const a = await guest();
  const joined = once(a.s, 'room:count');
  const b = await guest();
  const cnt = await joined;
  assert.strictEqual(cnt.room, 'public');
  assert.ok(cnt.count >= 2);
  const left = once(a.s, 'presence:leave');
  b.s.disconnect();
  assert.strictEqual((await left).uid, b.me.uid);
});

test('typing is only relayed to members of that room', async () => {
  const a = await guest(), b = await guest();
  const t = once(b.s, 'typing');
  a.s.emit('typing', { room: 'public' });
  assert.strictEqual((await t).uid, a.me.uid);
  let leaked = false;
  b.s.once('typing', () => (leaked = true));
  a.s.emit('typing', { room: 'c:ZZZZ' });
  await sleep(150);
  assert.strictEqual(leaked, false);
});

test('public messages are saved and served as history (and only the intended fields)', async () => {
  const a = await guest();
  await sleep(1100);
  await ack(a.s, 'message:send', { room: 'public', text: 'SAVED-ONE' });
  await ack(a.s, 'message:send', { room: 'public', text: 'SAVED-TWO' });
  const b = await guest();                                     // a brand new person arrives afterwards
  assert.strictEqual(b.me.publicHistory.enabled, true);
  const h = await ack(b.s, 'history:load', { room: 'public' });
  assert.strictEqual(h.ok, true); assert.strictEqual(h.enabled, true);
  const texts = h.messages.map((m) => m.text);
  assert.ok(texts.indexOf('SAVED-ONE') >= 0 && texts.indexOf('SAVED-ONE') < texts.indexOf('SAVED-TWO'), 'both there, in order');
  const m = h.messages.find((x) => x.text === 'SAVED-ONE');
  assert.deepStrictEqual(Object.keys(m).sort(), ['id', 'n', 'sender', 'text', 'ts', 'uid']);
  assert.strictEqual(m.uid, a.me.uid);
  assert.strictEqual(m.sender, a.me.username);
});

test('history paging over the socket: newest page first, older pages by cursor, limit clamped, bad input safe', async () => {
  const hist = require('../src/history');
  for (let i = 1; i <= 250; i++) hist.append({ id: 'seed' + i, ts: Date.now(), sender: 'seeder', uid: 'seedu', text: 'seed message ' + i });
  const a = await guest();
  const p1 = await ack(a.s, 'history:load', { room: 'public', limit: 99999 });
  assert.strictEqual(p1.messages.length, 100); assert.strictEqual(p1.hasMore, true);
  assert.strictEqual(p1.messages.at(-1).text, 'seed message 250');
  const p2 = await ack(a.s, 'history:load', { room: 'public', before: p1.messages[0].n, limit: 100 });
  assert.strictEqual(p2.messages.at(-1).n, p1.messages[0].n - 1, 'pages join up with no gap or overlap');
  for (const bad of [null, {}, { room: 'nope' }, { room: 'public', before: 'x', limit: 'y' }, { room: 'public', before: {}, limit: [] }]) {
    const r = await ack(a.s, 'history:load', bad);
    assert.strictEqual(r.ok, true);
  }
});

test('history requests are rate limited', async () => {
  const a = await guest();
  let blocked = false;
  for (let i = 0; i < 40; i++) { const r = await ack(a.s, 'history:load', { room: 'public', limit: 1 }); if (r.ok === false) { blocked = true; break; } }
  assert.ok(blocked);
});

test('encrypted join-code rooms are never saved: no trace on disk, and no history', async () => {
  const fs = require('fs');
  const a = await guest(), b = await guest();
  await sleep(1100);
  const locator = fakeLocator(), auth = fakeAuth();
  const made = await ack(a.s, 'room:create', { name: 'Private', locator, auth, ttlMs: 60000 });
  await ack(b.s, 'room:join', { locator, auth });
  const marker = 'CIPHERTEXT-MARKER-' + Date.now();
  await ack(a.s, 'message:send', { room: made.room.key, ciphertext: Buffer.from(marker).toString('base64'), iv: 'aXY=' });
  await sleep(150);
  const path = require('path');
  const walk = (d) => fs.readdirSync(d).flatMap((f) => (fs.statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
  for (const f of walk(path.dirname(process.env.DB_FILE))) { // every file, uploads folder included
    const body = fs.readFileSync(f, 'utf8');
    assert.ok(!body.includes(marker) && !body.includes(Buffer.from(marker).toString('base64')), `${f} must not contain private-room traffic`);
  }
  const r = await ack(b.s, 'history:load', { room: made.room.key });
  assert.deepStrictEqual([r.enabled, r.messages.length], [false, 0]);
});

test('the account database never contains chat messages; the history file is separate', async () => {
  const fs = require('fs');
  const a = await guest();
  await sleep(1100);
  const marker = 'UNIQUE-MARKER-' + Date.now();
  await ack(a.s, 'message:send', { room: 'public', text: marker });
  await sleep(250);
  assert.ok(!fs.readFileSync(process.env.DB_FILE, 'utf8').includes(marker), 'not in db.json');
  const hist = require('path').join(require('path').dirname(process.env.DB_FILE), 'public-history.jsonl');
  assert.ok(fs.readFileSync(hist, 'utf8').includes(marker), 'public message is in the history file');
  assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(fs.readFileSync(hist, 'utf8').split('\n').filter((l) => l.includes(marker)).join('')), 'no IP address stored with it');
});

test('connection flood guard still works (small cap): extra sockets from one network get a clear connect_error', async () => {
  const shield = require('../src/shield');
  const key = 'flood-test-net';
  const opened = [];
  for (let i = 0; i < 400; i++) { if (shield.connOpen(key)) opened.push(i); else break; }
  assert.ok(opened.length >= 200 && opened.length <= 500, 'cap should be a few hundred, got ' + opened.length);
  assert.strictEqual(shield.connOpen(key), false);
  for (let i = 0; i < opened.length; i++) shield.connClose(key);
});
