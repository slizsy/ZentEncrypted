const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { create } = require('../src/dmstore');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zent-dm-')), 'dm.jsonl');
const flush = () => new Promise((r) => setTimeout(r, 60));
const msg = (c, f, i) => ({ c, f, id: 'm' + i, iv: 'aXZpdml2aXZpdml2', ct: 'Y3QtJyArIGk=' + i });

test('messages persist per conversation, in order, and sequence numbers continue after restart', async () => {
  const f = tmp();
  const a = create({ file: f, noSweep: true });
  a.append(msg('dm:a:b', 'a', 1)); a.append(msg('dm:a:c', 'a', 2)); a.append(msg('dm:a:b', 'b', 3));
  a.close(); await flush();
  const b = create({ file: f, noSweep: true });
  assert.deepStrictEqual(b.page('dm:a:b').messages.map((m) => m.id), ['m1', 'm3']);
  assert.deepStrictEqual(b.page('dm:a:c').messages.map((m) => m.id), ['m2']);
  assert.strictEqual(b.append(msg('dm:a:b', 'a', 4)).n, 4);
  b.close();
});

test('unread counts only the other person\'s messages after my read marker; markers survive restart and never go backwards', async () => {
  const f = tmp();
  const s = create({ file: f, noSweep: true });
  const m1 = s.append(msg('dm:a:b', 'a', 1));
  s.append(msg('dm:a:b', 'a', 2));
  s.append(msg('dm:a:b', 'b', 3)); // b's own message doesn't count for b
  assert.strictEqual(s.unread('b', 'dm:a:b'), 2);
  assert.strictEqual(s.unread('a', 'dm:a:b'), 1);
  assert.strictEqual(s.markRead('b', 'dm:a:b', m1.n), true);
  assert.strictEqual(s.unread('b', 'dm:a:b'), 1);
  assert.strictEqual(s.markRead('b', 'dm:a:b', 0), false, 'cannot move backwards');
  assert.strictEqual(s.markRead('b', 'dm:a:b', 999), true, 'clamped to the newest message');
  assert.strictEqual(s.unread('b', 'dm:a:b'), 0);
  s.close(); await flush();
  const t = create({ file: f, noSweep: true });
  assert.strictEqual(t.unread('b', 'dm:a:b'), 0);
  assert.strictEqual(t.unread('a', 'dm:a:b'), 1);
  t.close();
});

test('deleting a conversation removes messages and read markers, and stays deleted after restart', async () => {
  const f = tmp();
  const s = create({ file: f, noSweep: true });
  s.append(msg('dm:a:b', 'a', 1)); s.markRead('b', 'dm:a:b', 1); s.append(msg('dm:a:c', 'a', 2));
  assert.strictEqual(s.deleteConv('dm:a:b'), true);
  assert.strictEqual(s.page('dm:a:b').messages.length, 0);
  s.close(); await flush();
  const t = create({ file: f, noSweep: true });
  assert.strictEqual(t.page('dm:a:b').messages.length, 0);
  assert.strictEqual(t.page('dm:a:c').messages.length, 1);
  assert.deepStrictEqual(t.conversations(), ['dm:a:c']);
  t.close();
});

test('paging: newest first page, older by cursor, limit clamped', () => {
  const s = create({ file: tmp(), noSweep: true });
  for (let i = 1; i <= 120; i++) s.append(msg('dm:a:b', 'a', i));
  const p1 = s.page('dm:a:b', { limit: 50 });
  assert.strictEqual(p1.messages[0].id, 'm71'); assert.strictEqual(p1.hasMore, true);
  const p2 = s.page('dm:a:b', { before: p1.messages[0].n, limit: 1000 });
  assert.strictEqual(p2.messages.length, 70); assert.strictEqual(p2.hasMore, false);
  assert.strictEqual(s.page('nope').messages.length, 0);
  s.close();
});

test('retention and the size cap drop the oldest; junk lines are skipped and cleaned', async () => {
  const f = tmp();
  fs.writeFileSync(f, [
    JSON.stringify({ t: 'm', n: 1, c: 'dm:a:b', id: 'old', f: 'a', ts: Date.now() - 40 * 86400000, iv: 'x', ct: 'y' }),
    'garbage{',
    JSON.stringify({ t: 'm', n: 2, c: 'dm:a:b', id: 'new', f: 'a', ts: Date.now(), iv: 'x', ct: 'y' }),
    JSON.stringify({ t: 'm', n: 3, c: 'dm:a:b' }),
  ].join('\n') + '\n');
  const s = create({ file: f, days: 30, noSweep: true });
  assert.deepStrictEqual(s.page('dm:a:b').messages.map((m) => m.id), ['new']);
  s.close(); await flush();
  assert.ok(!fs.readFileSync(f, 'utf8').includes('garbage'));
  const capped = create({ file: tmp(), max: 1000, noSweep: true });
  for (let i = 1; i <= 1200; i++) capped.append(msg(i % 2 ? 'dm:a:b' : 'dm:a:c', 'a', i));
  assert.ok(capped.size() <= 1050, 'size ' + capped.size());
  assert.strictEqual(capped.page('dm:a:b', { limit: 1 }).messages[0].id, 'm1199', 'newest kept');
  capped.close();
});

test('edit + delete: sender only, survive restart, old ciphertext squashed out of the file', async () => {
  const f = tmp();
  const s = create({ file: f, noSweep: true, compactMs: 20 });
  s.append(msg('dm:a:b', 'a', 1));
  s.append(msg('dm:a:b', 'b', 2));
  s.append(msg('dm:a:b', 'a', 3));
  assert.ok(s.has('dm:a:b', 'm1'));
  assert.strictEqual(s.edit('dm:a:b', 'm1', 'b', 'bmV3aXZuZXdpdm5ldw==', 'bmV3'), null, 'not your message');
  const e = s.edit('dm:a:b', 'm1', 'a', 'bmV3aXZuZXdpdm5l', 'RURJVEVE');
  assert.strictEqual(e.ct, 'RURJVEVE');
  assert.ok(e.e);
  assert.strictEqual(s.remove('dm:a:b', 'm2', 'a'), null, "can't delete theirs");
  assert.ok(s.remove('dm:a:b', 'm3', 'a'));
  assert.strictEqual(s.size(), 2);
  await new Promise((r) => setTimeout(r, 100));
  const body = fs.readFileSync(f, 'utf8');
  assert.ok(!body.includes('Y3QtJyArIGk=1'), 'old ciphertext of the edited message is gone');
  assert.ok(!body.includes('Y3QtJyArIGk=3'), 'deleted message is gone');
  s.close(); await flush();
  const t = create({ file: f, noSweep: true });
  assert.deepStrictEqual(t.page('dm:a:b').messages.map((m) => [m.id, m.ct]), [['m1', 'RURJVEVE'], ['m2', 'Y3QtJyArIGk=2']]);
  assert.strictEqual(t.unread('b', 'dm:a:b'), 1, 'unread counts follow the deletion');
  t.close();
});

test('unfriending squashes the deleted conversation out of the file soon after', async () => {
  const f = tmp();
  const s = create({ file: f, noSweep: true, compactMs: 20 });
  s.append(msg('dm:a:b', 'a', 1));
  s.deleteConv('dm:a:b');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.readFileSync(f, 'utf8').includes('Y3Qt'), 'no ciphertext left behind');
  s.close();
});
