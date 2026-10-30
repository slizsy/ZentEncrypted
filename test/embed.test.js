const test = require('node:test');
const assert = require('node:assert');
const { boot, client } = require('./helpers');

// Own file (and server) so these sign-ins don't eat into the shield budget of server-auth.test.js.
let srv;
test.before(async () => { srv = await boot({ PUBLIC_URL: 'https://chat.example.org' }); });
test.after(async () => { await srv.close(); });

test('embedded sign-in (inside Fablehop) gets a Partitioned SameSite=None cookie; normal sign-in is unchanged', async () => {
  const normal = await client(srv.base, '10.0.1.3').req('POST', '/api/auth/guest', {});
  assert.match(normal.setCookie, /SameSite=Lax/i);
  assert.ok(!/Partitioned/i.test(normal.setCookie), normal.setCookie);

  const c = client(srv.base, '10.0.1.4');
  const framed = await c.req('POST', '/api/auth/guest', {}, { 'x-zent-embed': '1' });
  assert.match(framed.setCookie, /SameSite=None/i);
  assert.match(framed.setCookie, /;\s*Secure/i);
  assert.match(framed.setCookie, /Partitioned/i);
  assert.strictEqual((await c.req('GET', '/api/auth/me', null, { 'x-zent-embed': '1' })).json.role, 'guest');

  const out = await c.req('POST', '/api/auth/logout', {}, { 'x-zent-embed': '1' });
  assert.strictEqual(out.json.ok, true);
  assert.match(out.setCookie, /Partitioned/i);
});
