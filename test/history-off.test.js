// A separate process: the server booted with public history switched OFF.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { boot, client, connect, ack, sleep } = require('./helpers');

let srv;
test.before(async () => { srv = await boot({ PUBLIC_HISTORY: '0' }); });
test.after(async () => { await srv.close(); });

test('with PUBLIC_HISTORY=0 nothing is saved, nothing is served, and clients are told', async () => {
  const c = client(srv.base, '10.77.1.1');
  await c.req('POST', '/api/auth/guest', {});
  const { s, me } = await connect(srv.base, c.cookie, { headers: { 'cf-connecting-ip': '10.77.1.1' } });
  assert.strictEqual(me.publicHistory.enabled, false);
  await ack(s, 'message:send', { room: 'public', text: 'should-not-be-saved' });
  await sleep(200);
  const h = await ack(s, 'history:load', { room: 'public' });
  assert.deepStrictEqual([h.ok, h.enabled, h.messages.length], [true, false, 0]);
  const dir = path.dirname(process.env.DB_FILE);
  assert.ok(!fs.existsSync(path.join(dir, 'public-history.jsonl')), 'no history file was even created');
  s.close();
});
