// edits/deletes, file sharing, GIFs, profiles and the admin page, against the real server
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { boot, client, connect, once, ack, sleep, fakeAuth, fakeLocator } = require('./helpers');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
const ADMIN_PASSWORD = 'correct horse battery staple 9';

let srv, giphy, giphyHits = [], ipN = 0;
const sockets = [];
const nextIp = () => `10.30.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;

/* ---- a fake Giphy so search + the media proxy can be tested offline ---- */
function startGiphy() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      giphyHits.push(req.url);
      const u = new URL(req.url, 'http://x');
      const base = `http://127.0.0.1:${s.address().port}`;
      if (u.pathname === '/v1/gifs/search' || u.pathname === '/v1/gifs/trending') {
        if (u.searchParams.get('api_key') !== 'test-giphy-key') { res.writeHead(403); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'catGif123', title: 'a cat', images: { fixed_height: { url: `${base}/learned/catGif123.gif?cid=1`, width: '356', height: '200' } } },
          { id: 'bad id!', title: 'skip me', images: { fixed_height: { url: 'https://evil.example/x.gif' } } },
          { id: 'dogGif456', title: 'a dog', images: { fixed_height: { width: '9999999', height: 'x' } } },
        ] }));
      }
      if (u.pathname === '/learned/catGif123.gif') { res.writeHead(200, { 'content-type': 'image/gif' }); return res.end(GIF); }
      if (u.pathname === '/media/dogGif456/200.gif') { res.writeHead(200, { 'content-type': 'image/gif' }); return res.end(GIF); }
      if (u.pathname === '/media/htmlGif/200.gif') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<script>alert(1)</script>'); }
      res.writeHead(404); res.end();
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function guest() {
  const ip = nextIp();
  const c = client(srv.base, ip);
  const r = await c.req('POST', '/api/auth/guest', {});
  assert.strictEqual(r.status, 200);
  const conn = await connect(srv.base, c.cookie, { headers: { 'cf-connecting-ip': ip } });
  sockets.push(conn.s);
  return { c, ip, ...conn, id: r.json.id };
}
async function member(name) {
  const ip = nextIp();
  const c = client(srv.base, ip);
  const r = await c.req('POST', '/api/auth/register', { username: name, password: 'Tq7-' + Math.random().toString(36).slice(2, 10) + '-zv-91x' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const conn = await connect(srv.base, c.cookie, { headers: { 'cf-connecting-ip': ip } });
  sockets.push(conn.s);
  return { c, ip, ...conn, id: r.json.id };
}
async function upload(who, body, scope, target, extra = {}) {
  const res = await fetch(srv.base + '/api/files', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: who.c.cookie, 'cf-connecting-ip': who.ip, 'x-zent-scope': scope, ...(target ? { 'x-zent-target': target } : {}), ...extra },
    body,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
const getFile = (fid, cookie) => fetch(`${srv.base}/files/${fid}`, { headers: cookie ? { cookie } : {} });
async function befriend(a, b) {
  const code = (await b.c.req('GET', '/api/friends/me')).json.friendCode;
  assert.strictEqual((await a.c.req('POST', '/api/friends/add', { code })).status, 201);
}
const pub = 'x'.repeat(86) + 'A=';
async function giveKey(who) {
  const r = await who.c.req('POST', '/api/keys', { pub, wrapped: 'A'.repeat(120), salt: 'A'.repeat(22) + '==', iv: 'A'.repeat(16), iters: 310000 });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
}

test.before(async () => {
  giphy = await startGiphy();
  const g = `http://127.0.0.1:${giphy.address().port}`;
  srv = await boot({
    SHIELD_AUTH_SOFT: '200',
    GIPHY_API_KEY: 'test-giphy-key', GIPHY_API_BASE: g, GIPHY_MEDIA_BASE: g,
    ADMIN_PASSWORD,
    UPLOAD_MAX_MB: '1',
    HISTORY_COMPACT_MS: '50',
  });
});
test.after(async () => { sockets.forEach((s) => s.close()); giphy.close(); await srv.close(); });

/* =================================== edits / deletes =================================== */

test('#public: the author can edit and delete; everyone sees it; other people cannot; history follows', async () => {
  const a = await guest(), b = await guest();
  await sleep(1100);
  const sent = await ack(a.s, 'message:send', { room: 'public', text: 'teh plan' });
  assert.ok(sent.ok);
  const mid = sent.id;

  assert.strictEqual((await ack(b.s, 'message:edit', { room: 'public', id: mid, text: 'hacked' })).ok, false, "B can't edit A's message");
  assert.strictEqual((await ack(b.s, 'message:delete', { room: 'public', id: mid })).ok, false, "B can't delete it either");
  assert.strictEqual((await ack(a.s, 'message:edit', { room: 'public', id: mid, text: '   ' })).ok, false, "can't edit to nothing");
  assert.strictEqual((await ack(a.s, 'message:edit', { room: 'public', id: '../../x', text: 'y' })).ok, false, 'bad id refused');

  await sleep(1100);
  const seen = once(b.s, 'message:edited');
  const ed = await ack(a.s, 'message:edit', { room: 'public', id: mid, text: 'the plan\u200B' });
  assert.ok(ed.ok, JSON.stringify(ed));
  const e = await seen;
  assert.deepStrictEqual([e.room, e.id, e.text, e.uid], ['public', mid, 'the plan', a.me.uid]);
  assert.ok(e.edited);

  const late = await guest(); // someone arriving later gets the edited version
  const h = await ack(late.s, 'history:load', { room: 'public' });
  const m = h.messages.find((x) => x.id === mid);
  assert.strictEqual(m.text, 'the plan');
  assert.ok(m.edited);

  const gone = once(b.s, 'message:deleted');
  assert.ok((await ack(a.s, 'message:delete', { room: 'public', id: mid })).ok);
  assert.deepStrictEqual(await gone, { room: 'public', id: mid, uid: a.me.uid });
  const h2 = await ack(late.s, 'history:load', { room: 'public' });
  assert.ok(!h2.messages.some((x) => x.id === mid), 'deleted from history');
  await sleep(200);
  const file = path.join(path.dirname(process.env.DB_FILE), 'public-history.jsonl');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('teh plan'), 'old text is gone from disk after the edit + delete');
});

test('join-code rooms: edits/deletes are relayed with the real sender stamped on them; outsiders cannot', async () => {
  const a = await guest(), b = await guest(), outsider = await guest();
  const locator = fakeLocator(), auth = fakeAuth();
  const made = await ack(a.s, 'room:create', { name: 'Edits', locator, auth, ttlMs: 60000 });
  await ack(b.s, 'room:join', { locator, auth });
  const key = made.room.key;
  const sent = await ack(a.s, 'message:send', { room: key, ciphertext: 'Y2lwaGVy', iv: 'aXZpdml2aXZpdml2' });

  const ev = once(b.s, 'message:edited');
  assert.ok((await ack(a.s, 'message:edit', { room: key, id: sent.id, ciphertext: 'bmV3', iv: 'aXZpdml2aXZpdml2' })).ok);
  const e = await ev;
  assert.strictEqual(e.uid, a.me.uid, 'stamped by the server, not chosen by the client');
  assert.strictEqual(e.ciphertext, 'bmV3');
  assert.ok(!('text' in e));

  assert.strictEqual((await ack(outsider.s, 'message:edit', { room: key, id: sent.id, ciphertext: 'eA==', iv: 'eA==' })).ok, false);
  assert.strictEqual((await ack(outsider.s, 'message:delete', { room: key, id: sent.id })).ok, false);
  assert.strictEqual((await ack(a.s, 'message:edit', { room: key, id: sent.id, text: 'plaintext!' })).ok, false, 'plaintext refused in a sealed room');

  const del = once(b.s, 'message:deleted');
  assert.ok((await ack(a.s, 'message:delete', { room: key, id: sent.id })).ok);
  assert.strictEqual((await del).uid, a.me.uid);
});

test('friend messages: only the sender can edit/delete; both people (and other devices) hear about it; it sticks', async () => {
  const a = await member('editora'), b = await member('editorb');
  await befriend(a, b);
  await giveKey(a); await giveKey(b);
  await sleep(1100);
  const id = 'msg-' + Date.now().toString(36);
  assert.ok((await ack(a.s, 'dm:send', { to: b.id, id, iv: 'aXZpdml2aXZpdml2', ct: 'b2xk' })).ok);
  assert.strictEqual((await ack(a.s, 'dm:send', { to: b.id, id, iv: 'aXZpdml2aXZpdml2', ct: 'ZHVw' })).ok, false, 'same id twice is refused');

  assert.strictEqual((await ack(b.s, 'dm:edit', { to: a.id, id, iv: 'aXZpdml2aXZpdml2', ct: 'aGFjaw==' })).ok, false, "B can't edit A's message");
  const evB = once(b.s, 'dm:edited');
  const evA = once(a.s, 'dm:edited');
  assert.ok((await ack(a.s, 'dm:edit', { to: b.id, id, iv: 'bmV3aXZuZXdpdm5l', ct: 'bmV3' })).ok);
  const e = await evB;
  assert.deepStrictEqual([e.id, e.f, e.ct, e.iv], [id, a.id, 'bmV3', 'bmV3aXZuZXdpdm5l']);
  await evA;
  const hist = await ack(b.s, 'dm:history', { friend: a.id });
  assert.strictEqual(hist.messages.find((m) => m.id === id).ct, 'bmV3');

  await sleep(1100);
  assert.strictEqual((await ack(b.s, 'dm:delete', { to: a.id, id })).ok, false, "B can't delete it");
  const del = once(b.s, 'dm:deleted');
  assert.ok((await ack(a.s, 'dm:delete', { to: b.id, id })).ok);
  assert.strictEqual((await del).id, id);
  assert.strictEqual((await ack(b.s, 'dm:history', { friend: a.id })).messages.length, 0);
});

/* =================================== files =================================== */

test('#public pictures: members only by default, real images only, served safely, deleted with the message', async () => {
  const g = await guest(), a = await member('picposter'), b = await member('picviewer');
  assert.strictEqual((await upload(g, PNG, 'public')).status, 403, 'guests cannot post pictures in #public by default');
  assert.strictEqual((await upload(a, Buffer.from('<svg onload=alert(1)>'), 'public')).status, 415, 'only real image bytes');
  assert.strictEqual((await upload(a, Buffer.from('<html><script>alert(1)</script>'), 'public', null, { 'content-type': 'image/png' })).status, 415, 'the content-type header is not trusted');
  assert.strictEqual((await upload(a, Buffer.alloc(0), 'public')).status, 400);
  assert.strictEqual((await upload(a, PNG, 'nonsense')).status, 400);

  const up = await upload(a, PNG, 'public');
  assert.strictEqual(up.status, 201);
  assert.match(up.json.id, /^[A-Za-z0-9_-]{22}$/);
  assert.strictEqual(up.json.mime, 'image/png');

  await sleep(1100);
  const got = once(b.s, 'message:receive');
  const sent = await ack(a.s, 'message:send', { room: 'public', att: { t: 'img', id: up.json.id, w: 1, h: 1 } });
  assert.ok(sent.ok, JSON.stringify(sent));
  const m = await got;
  assert.deepStrictEqual(m.att, { t: 'img', id: up.json.id, w: 1, h: 1 });
  assert.strictEqual(m.text, '');
  assert.strictEqual((await ack(a.s, 'message:send', { room: 'public', att: { t: 'img', id: up.json.id } })).ok, false, 'one picture, one message');
  assert.strictEqual((await ack(b.s, 'message:send', { room: 'public', att: { t: 'img', id: 'A'.repeat(22) } })).ok, false, 'unknown picture');
  await sleep(1100);
  const other = await upload(a, PNG, 'public');
  assert.strictEqual((await ack(b.s, 'message:send', { room: 'public', att: { t: 'img', id: other.json.id } })).ok, false, "can't post someone else's upload");
  assert.strictEqual((await ack(a.s, 'message:send', { room: 'public', att: { t: 'zip', id: other.json.id } })).ok, false, 'unknown attachment type');

  const r = await getFile(up.json.id, b.c.cookie);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/png');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(PNG));
  assert.strictEqual((await getFile(up.json.id)).status, 401, 'needs a session');
  assert.strictEqual((await fetch(srv.base + '/files/..%2F..%2Fdb.json', { headers: { cookie: b.c.cookie } })).status, 404, 'no path tricks');

  assert.ok((await ack(a.s, 'message:delete', { room: 'public', id: sent.id })).ok);
  assert.strictEqual((await getFile(up.json.id, b.c.cookie)).status, 404, 'picture deleted with its message');
});

test('private room files: members only, stored as an opaque download, burn with the room', async () => {
  const a = await guest(), b = await guest(), outsider = await guest();
  const locator = fakeLocator(), auth = fakeAuth();
  const made = await ack(a.s, 'room:create', { name: 'Files', locator, auth, ttlMs: 2500 });
  await ack(b.s, 'room:join', { locator, auth });
  const blob = Buffer.from('pretend this is AES-GCM ciphertext ' + Date.now());
  assert.strictEqual((await upload(outsider, blob, 'room', made.room.key)).status, 403, 'not in the room');
  assert.strictEqual((await upload(a, blob, 'room', 'c:ZZZZ')).status, 403, 'no such room');
  const up = await upload(a, blob, 'room', made.room.key);
  assert.strictEqual(up.status, 201);
  const r = await getFile(up.json.id, b.c.cookie);
  assert.strictEqual(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(blob));

  // deleting your message can take its file with it; someone else's file can't be deleted that way
  const up2 = await upload(b, blob, 'room', made.room.key);
  assert.ok((await ack(a.s, 'message:delete', { room: made.room.key, id: 'abcdef123456', files: [up2.json.id] })).ok);
  assert.strictEqual((await getFile(up2.json.id, a.c.cookie)).status, 200, "A can't delete B's file");

  await once(a.s, 'room:expired', 5000);
  await sleep(100);
  assert.strictEqual((await getFile(up.json.id, a.c.cookie)).status, 404, 'files burn with the room');
  assert.strictEqual((await getFile(up2.json.id, a.c.cookie)).status, 404);
});

test('friend chat files: friends only; deleted with the message or when you unfriend; size limit enforced', async () => {
  const a = await member('filea'), b = await member('fileb'), c = await member('filec');
  await befriend(a, b);
  const blob = Buffer.from('ciphertext-ish ' + Date.now());
  assert.strictEqual((await upload(c, blob, 'dm', a.id)).status, 403, 'not friends');
  assert.strictEqual((await upload(a, blob, 'dm', a.id)).status, 403, 'not yourself');
  const big = await upload(a, Buffer.alloc(1024 * 1024 + 10, 1), 'dm', b.id);
  assert.strictEqual(big.status, 413, 'over UPLOAD_MAX_MB');
  assert.match(big.json.error, /1 MB/);

  const one = await upload(a, blob, 'dm', b.id);
  const two = await upload(a, blob, 'dm', b.id);
  assert.strictEqual(one.status, 201);
  await giveKey(a); await giveKey(b);
  const mid = 'file-msg-' + Date.now().toString(36);
  assert.ok((await ack(a.s, 'dm:send', { to: b.id, id: mid, iv: 'aXZpdml2aXZpdml2', ct: 'ZW52ZWxvcGU=' })).ok);
  assert.ok((await ack(a.s, 'dm:delete', { to: b.id, id: mid, files: [one.json.id] })).ok);
  assert.strictEqual((await getFile(one.json.id, b.c.cookie)).status, 404, 'deleted with the message');
  assert.strictEqual((await getFile(two.json.id, b.c.cookie)).status, 200);

  assert.strictEqual((await a.c.req('DELETE', '/api/friends/' + b.id)).status, 200);
  await sleep(150);
  assert.strictEqual((await getFile(two.json.id, a.c.cookie)).status, 404, 'unfriending deletes the shared files');
});

test('the file list on disk holds no secrets: no names, no keys, no message text', async () => {
  const meta = fs.readFileSync(path.join(path.dirname(process.env.DB_FILE), 'files.json'), 'utf8');
  for (const r of JSON.parse(meta)) {
    assert.deepStrictEqual(Object.keys(r).filter((k) => !['id', 'owner', 'kind', 'size', 'ts', 'scope', 'exp', 'mime', 'msg'].includes(k)), []);
  }
  const mode = fs.statSync(path.join(path.dirname(process.env.DB_FILE), 'files')).mode & 0o777;
  assert.strictEqual(mode & 0o077, 0, 'uploads folder is private');
});

/* =================================== GIFs =================================== */

test('GIF search goes through the server; results are cleaned; the media proxy only passes real GIFs', async () => {
  const a = await guest();
  const cfg = await (await fetch(srv.base + '/api/config')).json();
  assert.strictEqual(cfg.gifs, true);

  const s = await a.c.req('GET', '/api/gifs/search?q=cat');
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual(s.json.results.map((g) => g.id), ['catGif123', 'dogGif456'], 'bad ids dropped');
  assert.deepStrictEqual([s.json.results[0].w, s.json.results[0].h], [356, 200]);
  assert.deepStrictEqual([s.json.results[1].w, s.json.results[1].h], [200, 200], 'silly sizes replaced');
  assert.ok(giphyHits.some((u) => u.startsWith('/v1/gifs/search') && u.includes('q=cat')));
  const t = await a.c.req('GET', '/api/gifs/search');
  assert.ok(giphyHits.some((u) => u.startsWith('/v1/gifs/trending')), 'empty search = trending');
  assert.strictEqual(t.status, 200);

  const learned = await fetch(srv.base + '/gif/catGif123.gif', { headers: { cookie: a.c.cookie } });
  assert.strictEqual(learned.status, 200);
  assert.strictEqual(learned.headers.get('content-type'), 'image/gif');
  assert.ok(giphyHits.includes('/learned/catGif123.gif?cid=1'), 'uses the url giphy gave us');
  const pattern = await fetch(srv.base + '/gif/dogGif456.gif', { headers: { cookie: a.c.cookie } });
  assert.strictEqual(pattern.status, 200, 'falls back to the standard url');
  assert.strictEqual((await fetch(srv.base + '/gif/htmlGif.gif', { headers: { cookie: a.c.cookie } })).status, 404, 'non-GIF upstream refused');
  assert.strictEqual((await fetch(srv.base + '/gif/catGif123.gif')).status, 401, 'needs a session');
  assert.strictEqual((await fetch(srv.base + '/gif/..%2Fx.gif', { headers: { cookie: a.c.cookie } })).status, 404);
  assert.strictEqual((await fetch(srv.base + '/api/gifs/search?q=x')).status, 401, 'search needs a session too');

  await sleep(1100);
  assert.ok((await ack(a.s, 'message:send', { room: 'public', att: { t: 'gif', id: 'catGif123', w: 356, h: 200 } })).ok);
  assert.strictEqual((await ack(a.s, 'message:send', { room: 'public', att: { t: 'gif', id: 'https://evil.example/x' } })).ok, false);
});

/* =================================== profiles =================================== */

test('profiles: members only; everything is validated; links must be real web links', async () => {
  const g = await guest(), a = await member('profilea');
  assert.strictEqual((await g.c.req('GET', '/api/profiles/me')).status, 403);
  assert.strictEqual((await g.c.req('PUT', '/api/profiles/me', { bio: 'hi' })).status, 403);

  const bad = async (body, re) => {
    const r = await a.c.req('PUT', '/api/profiles/me', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    if (re) assert.match(r.json.error, re);
  };
  await bad({ accent: 'red' }, /color/);
  await bad({ bg: '#12345' });
  await bad({ links: [{ label: 'x', url: 'javascript:alert(1)' }] }, /link/);
  await bad({ links: [{ label: 'x', url: 'data:text/html,hi' }] });
  await bad({ links: [{ label: 'x', url: 'https://user:pass@example.com' }] });
  await bad({ links: Array.from({ length: 7 }, (_, i) => ({ label: 'l' + i, url: `https://e${i}.example.com` })) }, /6/);
  await bad({ links: 'nope' });
  await bad({ avatar: '../../etc/passwd' });

  const ok = await a.c.req('PUT', '/api/profiles/me', {
    displayName: 'A\u202Ebc ' + 'x'.repeat(50),
    bio: 'line one\n\n\n\nline two\u0000',
    status: 'building stuff',
    pronouns: 'they/them',
    accent: '#FF00AA',
    bg: '#101010',
    links: [{ label: 'GitHub', url: 'github.com/slizsy' }, { label: '', url: 'https://www.example.org/path?q=1' }, { label: '', url: '' }],
    public: true,
    passwordHash: 'smuggled', role: 'admin',
  });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  const p = ok.json.profile;
  assert.strictEqual(Array.from(p.displayName).length, 32, 'display name capped');
  assert.ok(!p.displayName.includes('\u202E'), 'no bidi tricks');
  assert.strictEqual(p.bio, 'line one\n\nline two', 'blank lines squashed, control chars gone');
  assert.strictEqual(p.accent, '#ff00aa');
  assert.deepStrictEqual(p.links, [{ label: 'GitHub', url: 'https://github.com/slizsy' }, { label: 'example.org', url: 'https://www.example.org/path?q=1' }]);
  const db = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  const row = db.users.find((u) => u.username === 'profilea');
  assert.ok(!('passwordHash' in row.profile) && !('role' in row.profile), 'unknown fields are not stored');
});

test('profiles: pictures must be your own fresh profile upload; replacing one deletes the old file', async () => {
  const a = await member('picprof'), b = await member('picthief');
  const pubPic = await upload(a, PNG, 'public');
  assert.strictEqual((await a.c.req('PUT', '/api/profiles/me', { avatar: pubPic.json.id })).status, 400, 'a #public upload is not a profile picture');
  const theirs = await upload(b, PNG, 'profile');
  assert.strictEqual((await a.c.req('PUT', '/api/profiles/me', { avatar: theirs.json.id })).status, 400, "can't use someone else's upload");
  assert.strictEqual((await upload(a, Buffer.from('not an image'), 'profile')).status, 415);

  const first = await upload(a, PNG, 'profile');
  assert.strictEqual((await a.c.req('PUT', '/api/profiles/me', { avatar: first.json.id })).status, 200);
  const r = await fetch(`${srv.base}/files/${first.json.id}`); // profile pictures load without signing in
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/png');

  const second = await upload(a, GIF, 'profile');
  const saved = await a.c.req('PUT', '/api/profiles/me', { avatar: second.json.id });
  assert.strictEqual(saved.json.profile.avatar, `/files/${second.json.id}`);
  assert.strictEqual((await fetch(`${srv.base}/files/${first.json.id}`)).status, 404, 'old picture removed');
  assert.strictEqual((await a.c.req('PUT', '/api/profiles/me', { avatar: null })).json.profile.avatar, null);
  assert.strictEqual((await fetch(`${srv.base}/files/${second.json.id}`)).status, 404);
});

test('profiles: signed-in people see any profile; the internet only sees public pages; no private fields leak', async () => {
  const a = await member('privprof'), b = await member('viewerb'), g = await guest();
  await a.c.req('PUT', '/api/profiles/me', { bio: 'secret-ish bio', public: false });
  const seen = await b.c.req('GET', '/api/profiles/PrivProf');
  assert.strictEqual(seen.status, 200, 'case-insensitive, visible to members');
  assert.strictEqual(seen.json.profile.bio, 'secret-ish bio');
  assert.strictEqual((await g.c.req('GET', '/api/profiles/privprof')).status, 200, 'and to signed-in guests');
  const anon = await fetch(srv.base + '/api/profiles/privprof');
  assert.strictEqual(anon.status, 404, 'hidden from the internet while private');
  assert.strictEqual((await fetch(srv.base + '/api/profiles/nobodyhere')).status, 404, 'same answer as a missing name');

  await a.c.req('PUT', '/api/profiles/me', { public: true });
  const open = await fetch(srv.base + '/api/profiles/privprof');
  assert.strictEqual(open.status, 200);
  const body = JSON.stringify(await open.json());
  for (const leak of ['passwordHash', 'friendCode', 'keys', 'tokenVersion', 'wrapped', a.id]) assert.ok(!body.includes(leak), 'leaked ' + leak);

  const guestLookup = await b.c.req('GET', '/api/profiles/' + g.me.username);
  assert.strictEqual(guestLookup.status, 404);
  assert.strictEqual(guestLookup.json.guest, true);
  const pageRes = await fetch(srv.base + '/u/privprof');
  assert.strictEqual(pageRes.status, 200);
  assert.match(pageRes.headers.get('content-type'), /html/);
});

/* =================================== admin =================================== */

test('admin: password required; stats are counts only; signing out works', async () => {
  const c = client(srv.base, nextIp());
  assert.strictEqual((await c.req('GET', '/api/admin/stats')).status, 401);
  assert.strictEqual((await c.req('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  const ok = await fetch(srv.base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() }, body: JSON.stringify({ password: ADMIN_PASSWORD }) });
  assert.strictEqual(ok.status, 200);
  const raw = ok.headers.getSetCookie().find((x) => x.startsWith('zadmin=')) || '';
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
  assert.match(raw, /Path=\/api\/admin/);
  const cookie = raw.split(';')[0];
  const r = await fetch(srv.base + '/api/admin/stats', { headers: { cookie } });
  assert.strictEqual(r.status, 200);
  const s = await r.json();
  assert.ok(s.people.online >= 1, 'counts people online');
  assert.ok(s.accounts.total >= 5);
  assert.strictEqual(s.days.length, 14);
  assert.ok(s.days.at(-1).pub >= 1 && s.days.at(-1).dm >= 1 && s.days.at(-1).room >= 1, 'messages counted by type today');
  assert.ok(s.stored.files >= 1 && s.stored.fileCap > 0);
  assert.ok(Number.isFinite(s.server.rssMB));
  const text = JSON.stringify(s);
  for (const leak of ['profilea', 'editora', 'teh plan', 'the plan', 'Guest', '10.30.']) assert.ok(!text.includes(leak), 'stats leaked ' + leak);

  // a normal user session cookie is not an admin session
  const g = await guest();
  assert.strictEqual((await fetch(srv.base + '/api/admin/stats', { headers: { cookie: g.c.cookie } })).status, 401);
  const out = await fetch(srv.base + '/api/admin/logout', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.match(out.headers.get('set-cookie'), /zadmin=;/);
  assert.strictEqual((await fetch(srv.base + '/admin')).status, 200);
});

test('admin: guessing gets rate limited', async () => {
  const c = client(srv.base, nextIp());
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await c.req('POST', '/api/admin/login', { password: 'guess' + i });
    if (r.status === 429 || r.status === 428) { limited = true; break; }
  }
  assert.ok(limited, 'repeated wrong passwords get blocked');
});
