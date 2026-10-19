const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/crypto.js'), 'utf8');
// each call = an isolated "browser" with its own key store
const load = () => new Function(SRC + '\n;return Vault;')();

test('join codes: format, parsing, rejection of junk', () => {
  const V = load();
  const code = V.generateJoinCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  const p = V.parseJoinCode(code.toLowerCase().replace(/-/g, ' '));
  assert.strictEqual(p.normalized, code);
  assert.strictEqual(p.locator, code.slice(0, 4));
  assert.ok(V.parseJoinCode(`https://zentencrypted.org/#join=${code}`));
  assert.strictEqual(V.parseJoinCode('too-short'), null);
  assert.strictEqual(V.parseJoinCode('0000-1111-OOOO-IIII'), null); // ambiguous chars not in alphabet
  assert.strictEqual(V.parseJoinCode(null), null);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(V.generateJoinCode());
  assert.strictEqual(seen.size, 200, 'codes must not repeat');
});

test('two browsers with the same code derive the same auth + a working key; a wrong code does not', async () => {
  const A = load(), B = load(), C = load();
  const code = A.generateJoinCode();
  const p = A.parseJoinCode(code);
  const a = await A.deriveRoom(p.locator, p.secret);
  const b = await B.deriveRoom(p.locator, p.secret);
  assert.strictEqual(a.auth, b.auth);
  assert.match(a.auth, /^[0-9a-f]{64}$/);

  const sealed = await A.seal(a.roomKey, 'hello from alice ✓ ünïcode');
  assert.strictEqual(await B.open(b.roomKey, sealed.ciphertext, sealed.iv), 'hello from alice ✓ ünïcode');

  const wrong = A.parseJoinCode(A.generateJoinCode());
  const w = await C.deriveRoom(p.locator, wrong.secret);
  assert.notStrictEqual(w.auth, a.auth);
  assert.strictEqual(await C.open(w.roomKey, sealed.ciphertext, sealed.iv), null);
});

test('the auth half does not reveal the key half', async () => {
  const V = load();
  const p = V.parseJoinCode(V.generateJoinCode());
  const { auth, roomKey } = await V.deriveRoom(p.locator, p.secret);
  // If auth were used as the key, a server holding auth could decrypt. It must not.
  const sealed = await V.seal(roomKey, 'secret');
  const raw = Buffer.from(auth, 'hex');
  const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  await assert.rejects(
    crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(sealed.iv, 'base64'), additionalData: new TextEncoder().encode(roomKey) }, k, Buffer.from(sealed.ciphertext, 'base64'))
  );
});

test('ciphertext cannot be replayed into a different room (AAD binding)', async () => {
  const V = load();
  const p = V.parseJoinCode(V.generateJoinCode());
  const { roomKey } = await V.deriveRoom(p.locator, p.secret);
  const s = await V.seal(roomKey, 'x');
  assert.strictEqual(await V.open(roomKey, s.ciphertext, s.iv), 'x');
  assert.strictEqual(await V.open('c:ZZZZ', s.ciphertext, s.iv), null);
});

test('wipe() forgets every key', async () => {
  const V = load();
  const p = V.parseJoinCode(V.generateJoinCode());
  const { roomKey } = await V.deriveRoom(p.locator, p.secret);
  assert.ok(V.isReady(roomKey));
  V.wipe();
  assert.strictEqual(V.isReady(roomKey), false);
});
