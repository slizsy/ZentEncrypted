const os = require('os'), path = require('path'), fs = require('fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zent-hist-'));
process.env.DB_FILE = path.join(dir, 'db.json');           // keep the shared instance out of the project's data/
const test = require('node:test');
const assert = require('node:assert');
const { create } = require('../src/history');

const tmp = (name = 'h.jsonl') => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zent-h-')), name);
const mk = (i, over = {}) => ({ id: 'id' + i, ts: Date.now() + i, sender: 'user' + (i % 3), uid: 'u' + (i % 3), text: 'message ' + i, ...over });
const flush = () => new Promise((r) => setTimeout(r, 60)); // let the write stream drain

test('appends survive a restart, in order, with continuing sequence numbers', async () => {
  const f = tmp();
  const a = create({ file: f, noSweep: true });
  for (let i = 1; i <= 5; i++) a.append(mk(i));
  a.close(); await flush();
  const b = create({ file: f, noSweep: true });
  const { messages } = b.page();
  assert.deepStrictEqual(messages.map((m) => m.text), [1, 2, 3, 4, 5].map((i) => 'message ' + i));
  const next = b.append(mk(6));
  assert.strictEqual(next.n, 6, 'sequence continues instead of restarting at 1');
  b.close();
});

test('stores only what it should: no IPs, no extra fields smuggled in', async () => {
  const f = tmp();
  const a = create({ file: f, noSweep: true });
  a.append({ ...mk(1), ip: '203.0.113.9', cookie: 'secret', ciphertext: 'zzz' });
  a.close(); await flush();
  const line = JSON.parse(fs.readFileSync(f, 'utf8').trim());
  assert.deepStrictEqual(Object.keys(line).sort(), ['id', 'n', 'sender', 'text', 'ts', 'uid']);
});

test('a half-written last line (power cut) and junk lines are skipped, not fatal, and get cleaned up', async () => {
  const f = tmp();
  fs.writeFileSync(f, [JSON.stringify({ n: 1, id: 'a', ts: 1, sender: 's', uid: 'u', text: 'ok one' }), 'not json at all', JSON.stringify({ n: 2, id: 'b', ts: 2, sender: 's' }), JSON.stringify({ n: 3, id: 'c', ts: 3, sender: 's', uid: 'u', text: 'ok two' }), '{"n":4,"id":"d","ts":4,"sen'].join('\n'));
  const a = create({ file: f, noSweep: true });
  assert.deepStrictEqual(a.page().messages.map((m) => m.text), ['ok one', 'ok two']);
  a.close(); await flush();
  assert.ok(!fs.readFileSync(f, 'utf8').includes('not json'), 'file was rewritten clean');
});

test('paging: newest first page, then older pages, hasMore is accurate, limit is clamped to 100', () => {
  const a = create({ file: tmp(), noSweep: true });
  for (let i = 1; i <= 250; i++) a.append(mk(i));
  const p1 = a.page({ limit: 100 });
  assert.strictEqual(p1.messages.length, 100);
  assert.strictEqual(p1.messages[0].text, 'message 151'); assert.strictEqual(p1.messages.at(-1).text, 'message 250');
  assert.strictEqual(p1.hasMore, true);
  const p2 = a.page({ before: p1.messages[0].n, limit: 100 });
  assert.strictEqual(p2.messages[0].text, 'message 51'); assert.strictEqual(p2.messages.at(-1).text, 'message 150');
  const p3 = a.page({ before: p2.messages[0].n, limit: 100 });
  assert.strictEqual(p3.messages.length, 50); assert.strictEqual(p3.hasMore, false);
  assert.strictEqual(a.page({ limit: 99999 }).messages.length, 100);
  assert.strictEqual(a.page({ limit: -5 }).messages.length, 1);
  assert.strictEqual(a.page({ before: 'abc', limit: 3 }).messages.length, 3, 'garbage cursor falls back to newest');
  assert.strictEqual(a.page({ before: 1, limit: 10 }).messages.length, 0);
  a.close();
});

test('retention: messages older than the window are dropped on startup and on the file', async () => {
  const f = tmp();
  const day = 86400000;
  fs.writeFileSync(f, [
    { n: 1, id: 'a', ts: Date.now() - 40 * day, sender: 's', uid: 'u', text: 'ancient' },
    { n: 2, id: 'b', ts: Date.now() - 5 * day, sender: 's', uid: 'u', text: 'recent' },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n');
  const a = create({ file: f, days: 30, noSweep: true });
  assert.deepStrictEqual(a.page().messages.map((m) => m.text), ['recent']);
  a.close(); await flush();
  assert.ok(!fs.readFileSync(f, 'utf8').includes('ancient'));
  const keep = create({ file: f, days: 0, noSweep: true }); // 0 = keep forever
  assert.strictEqual(keep.size(), 1); keep.close();
});

test('size cap: the oldest messages are dropped, the newest are kept, and the file shrinks too', async () => {
  const f = tmp();
  const a = create({ file: f, max: 100, noSweep: true });
  for (let i = 1; i <= 300; i++) a.append(mk(i));
  assert.ok(a.size() <= 105, 'size ' + a.size());
  assert.strictEqual(a.page({ limit: 1 }).messages[0].text, 'message 300');
  a.close(); await flush();
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.ok(lines.length <= 220, 'file lines ' + lines.length);
  const b = create({ file: f, max: 100, noSweep: true });
  assert.strictEqual(b.size(), 100); b.close();
});

test('purge removes matching messages, persists, and later appends still land in the new file', async () => {
  const f = tmp();
  const a = create({ file: f, noSweep: true });
  for (let i = 1; i <= 9; i++) a.append(mk(i));
  const removed = a.purge((m) => m.sender === 'user0');
  assert.strictEqual(removed, 3);
  a.append(mk(10, { sender: 'newbie' }));
  a.close(); await flush();
  const b = create({ file: f, noSweep: true });
  const names = b.page().messages.map((m) => m.sender);
  assert.ok(!names.includes('user0')); assert.ok(names.includes('newbie'));
  assert.strictEqual(b.size(), 7); b.close();
});

test('disabled mode: nothing is read, written, or created', () => {
  const f = tmp();
  const a = create({ file: f, enabled: false, noSweep: true });
  assert.strictEqual(a.append(mk(1)), null);
  assert.strictEqual(a.page().messages.length, 0);
  assert.strictEqual(a.info().enabled, false);
  assert.ok(!fs.existsSync(f));
});

test('an unusable location (parent is a regular file) does not crash the app, and history still works in memory', async () => {
  const blocker = tmp('iam-a-file');
  fs.writeFileSync(blocker, 'x');
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  let a;
  try {
    a = create({ file: path.join(blocker, 'sub', 'h.jsonl'), noSweep: true });
    assert.doesNotThrow(() => a.append(mk(1)));
  } finally { console.error = orig; }
  assert.strictEqual(a.page().messages.length, 1, 'still served from memory');
  assert.ok(errs.some((e) => e.includes('[history]')), 'a warning was logged for the owner');
  a.close();
});

test('edit: only the author can change a message; the change survives a restart and the old text is gone from disk', async () => {
  const f = tmp();
  const a = create({ file: f, noSweep: true, compactMs: 30 });
  a.append(mk(1, { text: 'typo hree', uid: 'alice' }));
  a.append(mk(2, { uid: 'bob' }));
  assert.strictEqual(a.edit('id1', 'bob', 'hijacked'), null, "someone else can't edit it");
  assert.strictEqual(a.edit('nope', 'alice', 'x'), null, 'missing message');
  assert.strictEqual(a.edit('id1', 'alice', ''), null, "can't edit a text message down to nothing");
  const r = a.edit('id1', 'alice', 'typo here');
  assert.strictEqual(r.text, 'typo here');
  assert.ok(Number.isFinite(r.edited));
  await new Promise((res) => setTimeout(res, 120)); // let the compaction run
  assert.ok(!fs.readFileSync(f, 'utf8').includes('hree'), 'old wording is really gone from the file');
  a.close(); await flush();
  const b = create({ file: f, noSweep: true });
  const m = b.page().messages.find((x) => x.id === 'id1');
  assert.strictEqual(m.text, 'typo here');
  assert.ok(m.edited);
  b.close();
});

test('delete: author only; gone after restart, from the file too, and the drop handler hears about it', async () => {
  const f = tmp();
  const a = create({ file: f, noSweep: true, compactMs: 0 });
  for (let i = 1; i <= 3; i++) a.append(mk(i, { uid: 'alice', text: 'secret ' + i }));
  assert.strictEqual(a.remove('id2', 'mallory'), null);
  const gone = a.remove('id2', 'alice');
  assert.strictEqual(gone.text, 'secret 2');
  assert.strictEqual(a.remove('id2', 'alice'), null, 'deleting twice is a no-op');
  assert.deepStrictEqual(a.page().messages.map((m) => m.id), ['id1', 'id3']);
  assert.ok(!fs.readFileSync(f, 'utf8').includes('secret 2'));
  a.close(); await flush();
  const b = create({ file: f, noSweep: true });
  assert.deepStrictEqual(b.page().messages.map((m) => m.id), ['id1', 'id3']);
  assert.strictEqual(b.append(mk(9)).n, 4, 'numbering keeps going');
  b.close();
});

test('edits and deletes written just before a crash are replayed from the op lines', async () => {
  const f = tmp();
  fs.writeFileSync(f, [
    JSON.stringify({ n: 1, id: 'a', ts: Date.now(), sender: 's', uid: 'u', text: 'first' }),
    JSON.stringify({ n: 2, id: 'b', ts: Date.now(), sender: 's', uid: 'u', text: 'second' }),
    JSON.stringify({ op: 'e', id: 'a', text: 'first (fixed)', edited: 123 }),
    JSON.stringify({ op: 'd', id: 'b' }),
    JSON.stringify({ op: 'e', id: 'ghost', text: 'nothing to edit' }),
  ].join('\n') + '\n');
  const h = create({ file: f, noSweep: true });
  assert.deepStrictEqual(h.page().messages.map((m) => [m.id, m.text, m.edited]), [['a', 'first (fixed)', 123]]);
  assert.ok(!fs.readFileSync(f, 'utf8').includes('"op"'), 'op lines get squashed on load');
  h.close();
});

test('pictures: attachment-only messages are valid, and pruned/purged messages are handed to the drop handler', async () => {
  const f = tmp();
  const dropped = [];
  const h = create({ file: f, noSweep: true, max: 100, onDrop: (list) => dropped.push(...list.map((m) => m.id)) });
  h.append(mk(1, { text: '', att: { t: 'img', id: 'x'.repeat(22), w: 10, h: 10 } }));
  for (let i = 2; i <= 106; i++) h.append(mk(i));
  assert.ok(dropped.includes('id1'), 'trimmed by the size cap and reported');
  h.purge((m) => m.id === 'id50');
  assert.ok(dropped.includes('id50'), 'purged and reported');
  h.close(); await flush();
  const again = create({ file: f, noSweep: true, max: 100 });
  assert.ok(!again.get('id1'));
  again.close();
});
