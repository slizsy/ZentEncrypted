const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { sha256Block, zeroBits, solve } = require('../public/js/pow-worker.js');
const shield = require('../src/shield');

test('worker SHA-256 matches Node for many random inputs', () => {
  const out = new Int32Array(8);
  for (let i = 0; i < 2000; i++) {
    const n = crypto.randomBytes(12).toString('hex');
    const msg = `${n}:${Math.floor(Math.random() * 1e9)}`;
    const bytes = Buffer.from(msg);
    sha256Block(bytes, bytes.length, out);
    const mine = Buffer.alloc(32);
    for (let k = 0; k < 8; k++) mine.writeUInt32BE(out[k] >>> 0, k * 4);
    assert.strictEqual(mine.toString('hex'), crypto.createHash('sha256').update(msg).digest('hex'), msg);
  }
});

test('zero-bit counting agrees with the server', () => {
  const out = new Int32Array(8);
  for (let i = 0; i < 500; i++) {
    const bytes = Buffer.from(`x:${i}`);
    sha256Block(bytes, bytes.length, out);
    const h = crypto.createHash('sha256').update(`x:${i}`).digest();
    assert.strictEqual(zeroBits(out), shield.leadingZeroBits(h));
  }
});

test('a solved proof is accepted by the server verifier exactly once', () => {
  const key = '203.0.113.9';
  const ch = shield._issue(14, key);
  const counter = solve(ch.n, ch.difficulty, 0, 1);
  const proof = `${ch.token}|${counter}`;
  assert.strictEqual(shield._verify(proof, 14, key), true);
  assert.strictEqual(shield._verify(proof, 14, key), false, 'replay must fail');
});

test('proof is rejected for a different network, a wrong counter, or too-low difficulty', () => {
  const key = '203.0.113.10';
  const ch = shield._issue(14, key);
  const counter = solve(ch.n, ch.difficulty, 0, 1);
  assert.strictEqual(shield._verify(`${ch.token}|${counter}`, 14, '198.51.100.7'), false);
  assert.strictEqual(shield._verify(`${ch.token}|${counter + 1}`, 14, key), false);
  const easy = shield._issue(10, key);
  assert.strictEqual(shield._verify(`${easy.token}|${solve(easy.n, 10, 0, 1)}`, 14, key), false);
  assert.strictEqual(shield._verify('garbage', 14, key), false);
});

test('difficulty 18 solves in a sane time', () => {
  const t = Date.now();
  solve('abcdef0123456789abcdef01', 18, 0, 1);
  assert.ok(Date.now() - t < 15000, 'too slow: ' + (Date.now() - t) + 'ms');
});
