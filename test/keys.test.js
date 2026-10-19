const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/keys.js'), 'utf8');
const load = () => new Function(SRC + '\n;return Keys;')(); // a fresh "browser" each time

test('account key: locked with the password; right password unlocks, wrong one fails; record has only safe fields', async () => {
  const K = load();
  const { record } = await K.create('correct horse battery');
  assert.deepStrictEqual(Object.keys(record).sort(), ['iters', 'iv', 'pub', 'salt', 'wrapped']);
  assert.ok(record.iters >= 300000);
  assert.strictEqual(atob(record.pub).length, 65, 'raw P-256 public key');
  const u = await K.unlock('correct horse battery', record);
  assert.strictEqual(u.pub, record.pub);
  await assert.rejects(K.unlock('wrong password', record));
});

test('changing password re-locks the same key: new password works, old one no longer does', async () => {
  const K = load();
  const { record, pub } = await K.create('old-password-1');
  const relocked = { pub, ...(await K.relock('old-password-1', 'new-password-2', record)) };
  await K.unlock('new-password-2', relocked);
  await assert.rejects(K.unlock('old-password-1', relocked));
  await assert.rejects(K.relock('not-the-password', 'x-x-x-x-x', record), 'relock needs the current password');
});

test('two friends (on any device) derive the same key; messages open both ways, including guest <-> account', async () => {
  const alice = load(), bob = load();
  const a = await alice.create('alice-pass-123');
  const aOnPhone = await load().unlock('alice-pass-123', a.record); // Alice's other device
  const b = await bob.createGuest();
  const conv = 'dm:aaaa:bbbb';
  const kA = await alice.convKey(a.priv, a.pub, b.pub, conv);
  const kB = await bob.convKey(b.priv, b.pub, a.pub, conv);
  const sealed = await alice.seal(kA, conv, 'alice', 'msg-1', 'hello bob ✓');
  assert.strictEqual(await bob.open(kB, conv, 'alice', 'msg-1', sealed.iv, sealed.ct), 'hello bob ✓');
  const reply = await bob.seal(kB, conv, 'bob', 'msg-2', 'hi');
  const kPhone = await load().convKey(aOnPhone.priv, aOnPhone.pub, b.pub, conv);
  assert.strictEqual(await load().open(kPhone, conv, 'bob', 'msg-2', reply.iv, reply.ct), 'hi', "Alice's other device reads it too");
});

test('a message is bound to its conversation, sender and id; tampering is detected', async () => {
  const K = load();
  const a = await K.create('pass-a-12345'), b = await K.createGuest();
  const conv = 'dm:x:y';
  const k = await K.convKey(a.priv, a.pub, b.pub, conv);
  const s = await K.seal(k, conv, 'a', 'id-1', 'secret');
  await assert.rejects(K.open(k, conv, 'a', 'id-2', s.iv, s.ct), 'replayed under another id');
  await assert.rejects(K.open(k, conv, 'b', 'id-1', s.iv, s.ct), 'claimed by the other sender');
  const kOther = await K.convKey(a.priv, a.pub, b.pub, 'dm:x:z');
  await assert.rejects(K.open(kOther, 'dm:x:z', 'a', 'id-1', s.iv, s.ct), 'moved to another conversation');
  const bytes = Uint8Array.from(atob(s.ct), (c) => c.charCodeAt(0)); bytes[0] ^= 1;
  await assert.rejects(K.open(k, conv, 'a', 'id-1', s.iv, btoa(String.fromCharCode(...bytes))), 'flipped bit');
});

test('safety codes: identical on both sides, stable, and different if a server swaps in its own key', async () => {
  const K = load();
  const a = await K.create('pass-a-12345'), b = await K.createGuest(), mallory = await K.createGuest();
  const onA = await K.safetyCode(a.pub, b.pub), onB = await K.safetyCode(b.pub, a.pub);
  assert.match(onA, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.strictEqual(onA, onB);
  assert.strictEqual(await K.safetyCode(a.pub, b.pub), onA, 'stable');
  // man in the middle: each side is handed Mallory's key instead of the real one
  assert.notStrictEqual(await K.safetyCode(a.pub, mallory.pub), await K.safetyCode(b.pub, mallory.pub));
  assert.notStrictEqual(await K.safetyCode(a.pub, mallory.pub), onA);
});

test('keys are remembered for this browser and forgotten on sign-out (memory fallback when IndexedDB is missing)', async () => {
  const K = load();
  const g = await K.createGuest();
  assert.strictEqual(await K.recall('u1'), null);
  await K.remember('u1', g);
  assert.strictEqual((await K.recall('u1')).pub, g.pub);
  await K.forgetAll();
  assert.strictEqual(await K.recall('u1'), null);
});

test('a malformed or fake public key from the server is rejected, never used', async () => {
  const K = load();
  const a = await K.create('pass-a-12345');
  for (const bad of [btoa(String.fromCharCode(...new Uint8Array(65))), 'AAAA', btoa('not a key at all, just text padding it out to length')]) {
    await assert.rejects(K.convKey(a.priv, a.pub, bad, 'dm:x:y'));
  }
});
