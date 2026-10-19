const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawnSync } = require('child_process');

const day = 86400000;
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zent-purge-'));
  const f = path.join(dir, 'public-history.jsonl');
  const rows = [
    { n: 1, id: 'a', ts: Date.now() - 50 * day, sender: 'Alice', uid: 'u1', text: 'old hello' },
    { n: 2, id: 'b', ts: Date.now() - 2 * day, sender: 'Bob', uid: 'u2', text: 'recent SPAM link' },
    { n: 3, id: 'c', ts: Date.now() - 1 * day, sender: 'alice', uid: 'u1', text: 'recent hello' },
    { n: 4, id: 'd', ts: Date.now(), sender: 'Cara', uid: 'u3', text: 'fine' },
  ];
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, f, env: { ...process.env, DB_FILE: path.join(dir, 'db.json'), PORT: '1' } };
}
const run = (env, ...args) => spawnSync('node', [path.join(__dirname, '../scripts/purge-public.js'), ...args], { env, encoding: 'utf8', cwd: path.join(__dirname, '..') });
const left = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).text);

test('--dry-run reports but changes nothing', () => {
  const { f, env } = setup();
  const r = run(env, '--user', 'alice', '--dry-run');
  assert.match(r.stdout, /2 of 4 saved messages would be deleted/);
  assert.strictEqual(left(f).length, 4);
});

test('--user removes every message from that name (case-insensitive) and keeps the rest', () => {
  const { f, env } = setup();
  const r = run(env, '--user', 'ALICE');
  assert.match(r.stdout, /Deleted 2 of 4/);
  assert.deepStrictEqual(left(f), ['recent SPAM link', 'fine']);
});

test('--match, --older-than and --all work', () => {
  let s = setup();
  run(s.env, '--match', 'spam');
  assert.deepStrictEqual(left(s.f), ['old hello', 'recent hello', 'fine']);
  s = setup();
  run(s.env, '--older-than', '30');
  assert.deepStrictEqual(left(s.f), ['recent SPAM link', 'recent hello', 'fine']);
  s = setup();
  const r = run(s.env, '--all');
  assert.match(r.stdout, /Deleted 4 of 4/);
  assert.strictEqual(fs.readFileSync(s.f, 'utf8'), '');
});

test('bad or missing options are refused with help, and nothing is touched', () => {
  const { f, env } = setup();
  for (const args of [[], ['--all', '--user', 'x'], ['--older-than', 'abc'], ['--user']]) {
    const r = run(env, ...args);
    assert.notStrictEqual(r.status, 0, JSON.stringify(args));
    assert.match(r.stderr, /Usage|Pick exactly one|needs/);
  }
  assert.strictEqual(left(f).length, 4);
});

test('refuses to run while the chat server is up (unless --force)', async () => {
  const { f, env } = setup();
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const e = { ...env, PORT: String(srv.address().port) };
  const r = await new Promise((resolve) => {
    const { spawn } = require('child_process');
    const c = spawn('node', [path.join(__dirname, '../scripts/purge-public.js'), '--all'], { env: e, cwd: path.join(__dirname, '..') });
    let err = ''; c.stderr.on('data', (d) => (err += d)); c.on('close', (code) => resolve({ code, err }));
  });
  srv.close();
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /server is running/);
  assert.strictEqual(left(f).length, 4, 'nothing was deleted');
});
