// roles + moderation, against the real server
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { boot, client, connect, once, ack, sleep, fakeAuth, fakeLocator } = require('./helpers');

let srv, ipN = 0;
const sockets = [];
const nextIp = () => `10.40.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const pw = () => 'Zq8-' + Math.random().toString(36).slice(2, 10) + '-kx-42';

async function member(name) {
  const ip = nextIp();
  const c = client(srv.base, ip);
  const password = pw();
  const r = await c.req('POST', '/api/auth/register', { username: name, password });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const conn = await connect(srv.base, c.cookie, { headers: { 'cf-connecting-ip': ip } });
  sockets.push(conn.s);
  return { c, ip, password, ...conn, id: r.json.id, name };
}
async function guest() {
  const ip = nextIp();
  const c = client(srv.base, ip);
  const r = await c.req('POST', '/api/auth/guest', {});
  assert.strictEqual(r.status, 200);
  const conn = await connect(srv.base, c.cookie, { headers: { 'cf-connecting-ip': ip } });
  sockets.push(conn.s);
  return { c, ip, ...conn, id: r.json.id, name: r.json.username };
}
const me = async (who) => (await who.c.req('GET', '/api/staff/me')).json;

let owner, admin, mod, alice, bob;

test.before(async () => {
  srv = await boot({ SHIELD_AUTH_SOFT: '300', HISTORY_COMPACT_MS: '30' });
  owner = await member('theowner'); // first account on a fresh install
  admin = await member('anadmin');
  mod = await member('amod');
  alice = await member('alice');
  bob = await member('bobby');
});
test.after(async () => { sockets.forEach((s) => s.close()); await srv.close(); });

test('the first account is the owner; everyone else starts as a member', async () => {
  assert.strictEqual((await me(owner)).rank, 'owner');
  const m = await me(alice);
  assert.strictEqual(m.rank, 'member');
  assert.strictEqual(m.can.moderate, false);
  assert.strictEqual(m.can.owner, false);
  assert.ok(m.settings && 'slowModeSec' in m.settings);
});

test('roles: owner makes admins, admins make mods, nobody can promote to their own level or touch someone above them', async () => {
  const setRank = (actor, target, rank) => actor.c.req('POST', `/api/staff/users/${target.id}/rank`, { rank });
  assert.strictEqual((await setRank(alice, bob, 'mod')).status, 403, 'members have no say');
  assert.strictEqual((await setRank(owner, admin, 'admin')).status, 200);
  assert.strictEqual((await me(admin)).rank, 'admin');
  assert.strictEqual((await setRank(admin, alice, 'admin')).status, 403, "admins can't make admins");
  assert.strictEqual((await setRank(admin, mod, 'mod')).status, 200);
  assert.strictEqual((await me(mod)).rank, 'mod');
  assert.strictEqual((await setRank(admin, owner, 'member')).status, 403, "can't demote the owner");
  assert.strictEqual((await setRank(mod, alice, 'mod')).status, 403, "mods can't hand out roles");
  assert.strictEqual((await setRank(owner, alice, 'owner')).status, 400, 'owner is not a role you can give');
  const g = await guest();
  assert.strictEqual((await setRank(owner, g, 'mod')).status, 400, 'guests need an account first');
});

test('badges: staff messages carry their role in #public and in saved history', async () => {
  await sleep(1100);
  const got = once(alice.s, 'message:receive');
  assert.ok((await ack(mod.s, 'message:send', { room: 'public', text: 'mod speaking' })).ok);
  const m = await got;
  assert.strictEqual(m.rank, 'mod');
  const h = await ack(alice.s, 'history:load', { room: 'public' });
  assert.strictEqual(h.messages.find((x) => x.id === m.id).rank, 'mod');
  const plain = once(mod.s, 'message:receive');
  assert.ok((await ack(alice.s, 'message:send', { room: 'public', text: 'member speaking' })).ok);
  assert.strictEqual((await plain).rank, undefined, 'members get no badge');
});

test('mods remove anyone-below-them messages in #public; not other staff; it is logged', async () => {
  await sleep(1100);
  const sent = await ack(bob.s, 'message:send', { room: 'public', text: 'spam spam spam' });
  const seen = once(alice.s, 'message:deleted');
  const del = await ack(mod.s, 'message:delete', { room: 'public', id: sent.id });
  assert.ok(del.ok, JSON.stringify(del));
  const e = await seen;
  assert.strictEqual(e.by, 'staff');
  assert.strictEqual(e.id, sent.id);
  const h = await ack(alice.s, 'history:load', { room: 'public' });
  assert.ok(!h.messages.some((x) => x.id === sent.id));

  await sleep(1100);
  const fromAdmin = await ack(admin.s, 'message:send', { room: 'public', text: 'admin note' });
  assert.strictEqual((await ack(mod.s, 'message:delete', { room: 'public', id: fromAdmin.id })).ok, false, "mods can't remove an admin's message");
  assert.strictEqual((await ack(alice.s, 'message:delete', { room: 'public', id: fromAdmin.id })).ok, false, "members can't remove others' messages");
  const log = (await admin.c.req('GET', '/api/staff/audit')).json.audit;
  assert.ok(log.some((x) => x.action === 'delete-message' && x.by === 'amod' && x.target === 'bobby'));
});

test('mute: a muted person cannot post or edit in #public until it runs out; private rooms still work', async () => {
  await sleep(1100);
  const before = await ack(bob.s, 'message:send', { room: 'public', text: 'about to be muted' });
  const notice = once(bob.s, 'staff:notice');
  assert.strictEqual((await mod.c.req('POST', `/api/staff/users/${bob.id}/mute`, { minutes: 5 })).status, 200);
  assert.match((await notice).text, /muted/);
  await sleep(1100);
  const r = await ack(bob.s, 'message:send', { room: 'public', text: 'hello?' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /muted/);
  assert.strictEqual((await ack(bob.s, 'message:edit', { room: 'public', id: before.id, text: 'edited' })).ok, false, 'no edits while muted');
  const locator = fakeLocator(), auth = fakeAuth();
  const made = await ack(bob.s, 'room:create', { name: 'Side', locator, auth, ttlMs: 60000 });
  assert.ok((await ack(bob.s, 'message:send', { room: made.room.key, ciphertext: 'eHl6', iv: 'aXZpdml2aXZpdml2' })).ok, 'private rooms unaffected');
  assert.strictEqual((await mod.c.req('POST', `/api/staff/users/${bob.id}/mute`, { minutes: 99999 })).status, 400);
  assert.strictEqual((await alice.c.req('POST', `/api/staff/users/${bob.id}/mute`, { minutes: 5 })).status, 403);
  assert.strictEqual((await mod.c.req('POST', `/api/staff/users/${admin.id}/mute`, { minutes: 5 })).status, 403, "can't mute staff above you");
  assert.strictEqual((await mod.c.req('POST', `/api/staff/users/${bob.id}/unmute`)).status, 200);
  await sleep(1100);
  assert.ok((await ack(bob.s, 'message:send', { room: 'public', text: 'back' })).ok);
});

test('#public settings: slow mode, accounts-only and read-only, all live; staff are exempt; members cannot change them', async () => {
  assert.strictEqual((await mod.c.req('PUT', '/api/staff/settings', { slowModeSec: 30 })).status, 403, 'mods cannot change settings');
  const live = once(alice.s, 'staff:settings');
  const r = await admin.c.req('PUT', '/api/staff/settings', { slowModeSec: 30, announcement: 'Be nice \u202E in here' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await live), { slowModeSec: 30, publicPosting: 'all', announcement: 'Be nice in here' });
  const fresh = await member('slowpoke'); // hasn't posted yet, so the 30s window starts now
  await sleep(1100);
  assert.ok((await ack(fresh.s, 'message:send', { room: 'public', text: 'one' })).ok);
  await sleep(1100);
  const slow = await ack(fresh.s, 'message:send', { room: 'public', text: 'two' });
  assert.strictEqual(slow.ok, false);
  assert.match(slow.error, /Slow mode/);
  assert.ok((await ack(mod.s, 'message:send', { room: 'public', text: 'staff ignore slow mode' })).ok);
  await sleep(1100);
  assert.ok((await ack(mod.s, 'message:send', { room: 'public', text: 'twice' })).ok);

  await admin.c.req('PUT', '/api/staff/settings', { slowModeSec: 0, publicPosting: 'members' });
  const g = await guest();
  await sleep(1100);
  const gr = await ack(g.s, 'message:send', { room: 'public', text: 'guest here' });
  assert.strictEqual(gr.ok, false);
  assert.match(gr.error, /Only accounts/);
  await admin.c.req('PUT', '/api/staff/settings', { publicPosting: 'staff' });
  await sleep(1100);
  assert.strictEqual((await ack(alice.s, 'message:send', { room: 'public', text: 'x' })).ok, false, 'read-only for members');
  assert.ok((await ack(mod.s, 'message:send', { room: 'public', text: 'staff can' })).ok);
  assert.strictEqual((await admin.c.req('PUT', '/api/staff/settings', { publicPosting: 'everyone!' })).status, 400);
  assert.strictEqual((await admin.c.req('PUT', '/api/staff/settings', { slowModeSec: 9999 })).status, 400);
  await admin.c.req('PUT', '/api/staff/settings', { publicPosting: 'all', announcement: '' });
  const pub = await (await fetch(srv.base + '/api/staff/settings')).json();
  assert.strictEqual(pub.settings.publicPosting, 'all');
});

test('reports: anyone can report; #public reports snapshot the message; private reports hold only what the reporter shares', async () => {
  await sleep(1100);
  const bad = await ack(bob.s, 'message:send', { room: 'public', text: 'something rude' });
  assert.strictEqual((await alice.c.req('POST', '/api/staff/report', { kind: 'public', msgId: bad.id, reason: 'nope' })).status, 400, 'reason is required');
  const pubRep = await alice.c.req('POST', '/api/staff/report', { kind: 'public', msgId: bad.id, reason: 'harassment', note: 'not ok' });
  assert.strictEqual(pubRep.status, 201);
  // a private-room report: the server never saw the text, the reporter pastes their own decrypted copy
  const privRep = await alice.c.req('POST', '/api/staff/report', { kind: 'room', uid: bob.me.uid, text: 'what bob said in our room', reason: 'spam' });
  assert.strictEqual(privRep.status, 201);
  const noText = await alice.c.req('POST', '/api/staff/report', { kind: 'dm', target: 'bobby', reason: 'other' });
  assert.strictEqual(noText.status, 201, 'reporting without sharing the text is fine');
  assert.strictEqual((await alice.c.req('POST', '/api/staff/report', { kind: 'user', target: 'alice', reason: 'spam' })).status, 400, "can't report yourself");

  assert.strictEqual((await alice.c.req('GET', '/api/staff/reports')).status, 403, 'members cannot read reports');
  const ping = once(mod.s, 'staff:reports');
  await alice.c.req('POST', '/api/staff/report', { kind: 'user', target: 'bobby', reason: 'spam' });
  await ping;
  const list = (await mod.c.req('GET', '/api/staff/reports')).json.reports;
  const p = list.find((r) => r.kind === 'public');
  assert.strictEqual(p.message.text, 'something rude');
  assert.strictEqual(p.target.username, 'bobby');
  assert.strictEqual(p.target.id, bob.id, 'linked to the real account so staff can act');
  const r2 = list.find((r) => r.kind === 'room');
  assert.strictEqual(r2.message.text, 'what bob said in our room');
  assert.strictEqual(r2.message.shared, true, 'marked as shared by the reporter');
  assert.strictEqual(list.find((r) => r.kind === 'dm').message, undefined);
  assert.ok((await me(mod)).openReports >= 4);

  assert.strictEqual((await mod.c.req('POST', `/api/staff/reports/${p.id}/resolve`, { outcome: 'actioned', note: 'muted them' })).status, 200);
  const resolved = (await mod.c.req('GET', '/api/staff/reports?status=resolved')).json.reports;
  assert.strictEqual(resolved.find((r) => r.id === p.id).resolvedBy, 'amod');
});

test('ban: account is signed out everywhere at once, cannot sign back in, and unban restores it; mods cannot ban', async () => {
  const victim = await member('banme');
  assert.strictEqual((await mod.c.req('POST', `/api/staff/users/${victim.id}/ban`, { reason: 'x' })).status, 403);
  const kicked = once(victim.s, 'staff:notice');
  const gone = once(victim.s, 'disconnect');
  assert.strictEqual((await admin.c.req('POST', `/api/staff/users/${victim.id}/ban`, { reason: 'spamming' })).status, 200);
  assert.match((await kicked).text, /banned.*spamming/);
  await gone;
  assert.strictEqual((await victim.c.req('GET', '/api/auth/me')).status, 401, 'old session is dead');
  const again = client(srv.base, nextIp());
  const login = await again.req('POST', '/api/auth/login', { username: 'banme', password: victim.password });
  assert.strictEqual(login.status, 403);
  assert.match(login.json.error, /banned/);
  const found = (await admin.c.req('GET', '/api/staff/users?filter=banned')).json.users;
  assert.ok(found.some((u) => u.username === 'banme' && u.banned.reason === 'spamming'));
  assert.strictEqual((await admin.c.req('POST', `/api/staff/users/${victim.id}/unban`)).status, 200);
  assert.strictEqual((await again.req('POST', '/api/auth/login', { username: 'banme', password: victim.password })).status, 200);
  assert.strictEqual((await admin.c.req('POST', `/api/staff/users/${owner.id}/ban`, { reason: 'coup' })).status, 403, "admins can't ban the owner");
});

test('guests: kick ends their session; a guest ban also blocks their network from new guest sessions for a while', async () => {
  const g = await guest();
  const found = (await mod.c.req('GET', '/api/staff/lookup?uid=' + g.me.uid)).json.person;
  assert.strictEqual(found.id, g.id);
  assert.strictEqual(found.guest, true);
  const gone = once(g.s, 'disconnect');
  assert.strictEqual((await mod.c.req('POST', `/api/staff/users/${g.id}/kick`)).status, 200);
  await gone;
  assert.strictEqual((await g.c.req('GET', '/api/auth/me')).status, 401, 'guest session ended');

  const g2 = await guest();
  const gone2 = once(g2.s, 'disconnect');
  assert.strictEqual((await admin.c.req('POST', `/api/staff/users/${g2.id}/ban`, { reason: 'trolling' })).status, 200);
  await gone2;
  const retry = client(srv.base, g2.ip);
  const r = await retry.req('POST', '/api/auth/guest', {});
  assert.strictEqual(r.status, 403, 'same network blocked');
  assert.match(r.json.error, /blocked/);
  const blocks = (await admin.c.req('GET', '/api/staff/netbans')).json.netbans;
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].label, g2.name);
  assert.ok(!JSON.stringify(blocks).includes(g2.ip), 'the IP itself is never shown or kept');
  assert.strictEqual((await admin.c.req('DELETE', '/api/staff/netbans/' + encodeURIComponent(blocks[0].key))).status, 200);
  assert.strictEqual((await retry.req('POST', '/api/auth/guest', {})).status, 200, 'unblocked');
});

test('wipe someone\'s #public messages (admin), sign them out (admin), delete their account (owner only)', async () => {
  const t = await member('wipeme');
  await sleep(1100);
  await ack(t.s, 'message:send', { room: 'public', text: 'wipe 1' });
  await sleep(1100);
  await ack(t.s, 'message:send', { room: 'public', text: 'wipe 2' });
  assert.strictEqual((await mod.c.req('POST', `/api/staff/users/${t.id}/purge-public`)).status, 403);
  const w = await admin.c.req('POST', `/api/staff/users/${t.id}/purge-public`);
  assert.strictEqual(w.json.removed, 2);
  const h = await ack(alice.s, 'history:load', { room: 'public' });
  assert.ok(!h.messages.some((m) => m.sender === 'wipeme'));

  const out = once(t.s, 'disconnect');
  assert.strictEqual((await admin.c.req('POST', `/api/staff/users/${t.id}/signout`)).status, 200);
  await out;
  assert.strictEqual((await t.c.req('GET', '/api/auth/me')).status, 401);

  assert.strictEqual((await admin.c.req('DELETE', `/api/staff/users/${t.id}`)).status, 403, 'only the owner deletes accounts');
  assert.strictEqual((await owner.c.req('DELETE', `/api/staff/users/${t.id}`)).status, 200);
  const db = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  assert.ok(!db.users.some((u) => u.username === 'wipeme'));
});

test('staff lists: search, filters, online; overview is admin+ and still counts-only for message content', async () => {
  const list = (await mod.c.req('GET', '/api/staff/users?q=ali')).json.users;
  assert.deepStrictEqual(list.map((u) => u.username), ['alice']);
  const staffOnly = (await mod.c.req('GET', '/api/staff/users?filter=staff')).json.users.map((u) => u.rank);
  assert.deepStrictEqual(staffOnly, ['owner', 'admin', 'mod']);
  assert.strictEqual((await alice.c.req('GET', '/api/staff/users')).status, 403);
  assert.strictEqual((await mod.c.req('GET', '/api/staff/overview')).status, 403, 'stats are admin+');
  const o = (await admin.c.req('GET', '/api/staff/overview')).json;
  assert.ok(o.people.online >= 1);
  assert.ok(o.moderation.staff === 3);
  const text = JSON.stringify(o);
  assert.ok(!text.includes('something rude') && !text.includes('mod speaking'), 'no message content in stats');
  assert.strictEqual((await mod.c.req('GET', '/api/staff/audit')).status, 403, 'audit is admin+');
  const audit = (await admin.c.req('GET', '/api/staff/audit')).json.audit;
  for (const a of ['set-role', 'mute', 'unmute', 'ban', 'unban', 'kick', 'ban-guest', 'wipe-public', 'delete-account', 'settings']) {
    assert.ok(audit.some((x) => x.action === a), 'audit has ' + a);
  }
  const file = fs.readFileSync(path.join(path.dirname(process.env.DB_FILE), 'moderation.json'), 'utf8');
  assert.ok(!file.includes('10.40.'), 'no IP addresses stored');
});

test('nobody on staff can read private rooms or friend chats: there is simply no endpoint for it', async () => {
  for (const url of ['/api/staff/rooms', '/api/staff/dms', '/api/staff/messages', '/api/staff/conversations']) {
    assert.strictEqual((await owner.c.req('GET', url)).status, 404, url);
  }
});
