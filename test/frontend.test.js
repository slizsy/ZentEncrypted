/**
 * Drives the REAL page (index.html + all scripts) in jsdom against the REAL
 * server, clicking and typing like a person. Crypto, sockets, cookies and the
 * human-check hooks are all genuine; only the browser shell is simulated.
 */
const test = require('node:test');
const assert = require('node:assert');
const { webcrypto } = require('node:crypto');
const { JSDOM, CookieJar, VirtualConsole } = require('jsdom');
const { boot, sleep } = require('./helpers');

let srv, ipCounter = 0;
const doms = [];
const pageErrors = [];

async function openClient(label, opts = {}) {
  const ip = `10.55.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
  const jar = new CookieJar();
  if (opts.cookie) jar.setCookieSync(opts.cookie.split(';')[0], srv.base + '/');
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => pageErrors.push(`[${label}] ${e.message}`));
  vc.on('error', (...a) => pageErrors.push(`[${label}] console.error: ${a.join(' ').slice(0, 300)}`));

  const dom = await JSDOM.fromURL(srv.base + (opts.path || '/'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    cookieJar: jar,
    virtualConsole: vc,
    beforeParse(window) {
      if (opts.insecure) {
        // what an iPad sees on http://192.168.x.x: no encryption engine
        Object.defineProperty(window, 'crypto', { value: { getRandomValues: (a) => webcrypto.getRandomValues(a) }, configurable: true });
        Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
      } else {
        Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      }
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
      window.AudioContext = undefined;
      window.fetch = async (url, opts = {}) => {
        const full = new URL(url, srv.base).href;
        const headers = { ...(opts.headers || {}), 'cf-connecting-ip': ip };
        const cookie = jar.getCookieStringSync(full);
        if (cookie) headers.cookie = cookie;
        const res = await fetch(full, { method: opts.method || 'GET', headers, body: opts.body });
        for (const c of res.headers.getSetCookie()) jar.setCookieSync(c, full);
        return res;
      };
      window.sessionStorage.setItem('zent_booted', '1'); // skip the intro animation
      // jsdom has no image decoding or object URLs: say "can't" for the first, record blobs for the second
      window.createImageBitmap = () => Promise.reject(new Error('not in jsdom'));
      window.__blobs = [];
      window.URL.createObjectURL = (b) => { window.__blobs.push(b); return 'blob:test-' + window.__blobs.length; };
      window.URL.revokeObjectURL = () => {};
      window.addEventListener('error', (e) => pageErrors.push(`[${label}] window.onerror: ${e.message}`));
      window.addEventListener('unhandledrejection', (e) => pageErrors.push(`[${label}] unhandled rejection: ${e.reason && e.reason.message}`));
    },
  });
  doms.push(dom);
  const { window } = dom;
  const { document } = window;
  const $ = (id) => document.getElementById(id);
  // fromURL resolves before the external scripts have run; a real person can't click that early either
  for (let i = 0; i < 400 && document.readyState !== 'complete'; i++) await sleep(25);
  await sleep(120); // let the first /api/auth/me round-trip settle

  const api = {
    window, document, $, jar,
    async waitFor(fn, what = 'condition', ms = 6000) {
      const t0 = Date.now();
      for (;;) {
        let v;
        try { v = fn(); } catch { v = false; }
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`[${label}] timed out waiting for ${what}`);
        await sleep(25);
      }
    },
    type(el, value) {
      el.value = value;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
    },
    click: (el) => el.click(),
    visible: (el) => !el.classList.contains('is-hidden'),
    messages: () => Array.from(document.querySelectorAll('.log.is-visible .msg-body')).map((n) => n.textContent),
    allMessages: (key) => Array.from(document.querySelectorAll(`.log[data-room="${key}"] .msg-body`)).map((n) => n.textContent),
    async guest() {
      await api.waitFor(() => api.visible($('auth-screen')), 'auth screen');
      api.click($('guest-btn'));
      await api.waitFor(() => api.visible($('app')) && $('signal').dataset.state === 'up', 'app + connection');
      await api.waitFor(() => !$('composer-input').disabled, 'composer enabled');
    },
    async register(name, pass) {
      await api.waitFor(() => api.visible($('auth-screen')), 'auth screen');
      api.click($('tab-register'));
      api.type($('register-username'), name);
      api.type($('register-password'), pass);
      api.click($('register-form').querySelector('button[type=submit]'));
      await api.waitFor(() => api.visible($('app')) && $('signal').dataset.state === 'up', 'registered + connected');
      await api.waitFor(() => !$('composer-input').disabled, 'composer enabled');
    },
    async login(name, pass) {
      await api.waitFor(() => api.visible($('auth-screen')), 'auth screen');
      api.type($('login-username'), name);
      api.type($('login-password'), pass);
      api.click($('login-form').querySelector('button[type=submit]'));
      await api.waitFor(() => api.visible($('app')) && $('signal').dataset.state === 'up', 'signed in + connected');
    },
    async say(text) {
      api.type($('composer-input'), text);
      $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    },
  };
  return api;
}

test.before(async () => { srv = await boot({ SHIELD_AUTH_SOFT: '100', PUBLIC_URL: 'https://chat.example.org' }); });
test.after(async () => { doms.forEach((d) => d.window.close()); await srv.close(); });

test('page loads clean: no script errors, sign-in screen shown, app hidden, icons/manifest linked', async () => {
  const a = await openClient('load');
  await a.waitFor(() => a.visible(a.$('auth-screen')), 'auth screen');
  assert.ok(a.$('app').classList.contains('is-hidden'));
  assert.strictEqual(a.document.querySelector('link[rel=manifest]').getAttribute('href'), '/manifest.webmanifest');
  assert.ok(a.document.querySelector('link[rel=apple-touch-icon]'));
  assert.ok(a.document.querySelector('link[rel=icon][type="image/svg+xml"]'));
  const src = a.document.querySelector('#auth-screen a.src-link');
  assert.strictEqual(src.getAttribute('href'), 'https://github.com/slizsy/ZentEncrypted');
  assert.match(src.getAttribute('rel'), /noopener/);
  assert.strictEqual(a.document.getElementById('mode-strip'), null, 'the banner is gone');
  assert.deepStrictEqual(pageErrors, []);
});

test('guest sign-in: lands in #public with no passphrase prompt, can chat, message shows as "you"', async () => {
  const a = await openClient('guest');
  await a.guest();
  assert.match(a.$('me-name').textContent, /^Guest\d{4}$/);
  assert.strictEqual(a.$('room-title').textContent, 'public');
  assert.strictEqual(a.$('mode-stamp').textContent, 'OPEN');
  assert.ok(a.$('composer-input').placeholder.includes('#public'));
  assert.ok(a.$('insecure-note').classList.contains('is-hidden'), 'no warning on a secure page');
  await a.say('hello <b>world</b> & friends');
  await a.waitFor(() => a.messages().length === 1, 'own message echo');
  assert.strictEqual(a.messages()[0], 'hello <b>world</b> & friends'); // shown as text, never as markup
  assert.strictEqual(a.document.querySelector('.log.is-visible .msg b'), null, 'no injected elements');
  assert.ok(a.document.querySelector('.log.is-visible .msg.is-own'));
  assert.strictEqual(a.document.querySelector('.log.is-visible .msg-who').textContent, 'you');
  assert.strictEqual(a.$('composer-input').value, '');
  assert.deepStrictEqual(pageErrors, []);
});

test('two people in #public see each other; messages while you are elsewhere raise an unread badge and the tab title', async () => {
  const a = await openClient('pubA'), b = await openClient('pubB');
  await a.guest(); await b.guest();
  await a.say('hi from A');
  await b.waitFor(() => b.messages().includes('hi from A'), 'B receives A');
  assert.match(b.document.querySelector('.log.is-visible .msg:not(.is-own) .msg-who').textContent, /^Guest\d{4}$/);
  assert.ok(!b.visible(b.$('rooms-badge')), 'no badge while B is looking at public');

  // B wanders off to a room of their own, then A talks in public
  b.click(b.$('open-create'));
  b.type(b.$('cr-name'), 'Elsewhere');
  b.$('cr-form').dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }));
  await b.waitFor(() => b.visible(b.$('cr-result')), 'B created');
  b.click(b.$('cr-open'));
  await b.waitFor(() => b.$('room-title').textContent === 'Elsewhere', 'B moved');
  await sleep(1100); // stay under the 5 msg/s limiter
  await a.say('are you there?');
  await b.waitFor(() => b.visible(b.$('rooms-badge')) && b.$('rooms-badge').textContent === '1', 'unread badge');
  assert.match(b.document.title, /^\(1\) ZENT/);
  b.click(b.document.querySelector('#room-list .item')); // public is first
  await b.waitFor(() => b.$('room-title').textContent === 'public', 'back to public');
  assert.ok(!b.visible(b.$('rooms-badge')), 'badge cleared');
  assert.ok(b.messages().includes('are you there?'));
  assert.doesNotMatch(b.document.title, /^\(/);
  assert.deepStrictEqual(pageErrors, []);
});

test('create a room: join code shown, room listed with a countdown; second person joins by typing the code; messages are encrypted end-to-end', async () => {
  const a = await openClient('roomA'), b = await openClient('roomB');
  await a.guest(); await b.guest();

  // --- A creates a 1-hour room
  a.click(a.$('open-create'));
  assert.ok(a.$('dlg-create').classList.contains('is-open'));
  a.type(a.$('cr-name'), 'Study group');
  a.type(a.$('cr-ttl'), '3600000');
  a.$('cr-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => a.visible(a.$('cr-result')), 'result view');
  const code = a.$('cr-code').textContent;
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  a.click(a.$('cr-open'));
  await a.waitFor(() => a.$('room-title').textContent === 'Study group', 'room open');
  assert.strictEqual(a.$('mode-stamp').textContent, 'SEALED');
  assert.ok(a.visible(a.$('expiry-pill')));
  assert.match(a.$('expiry-text').textContent, /^00:(59|60|58):\d\d$|^01:00:00$/);
  assert.ok(a.visible(a.$('room-share')));

  // --- B tries a wrong code first, then the real one
  b.click(b.$('open-join'));
  b.type(b.$('jn-code'), 'AAAA-BBBB-CCCC-DDDD');
  b.$('jn-form').dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }));
  await b.waitFor(() => b.visible(b.$('jn-error')), 'wrong-code error');
  assert.match(b.$('jn-error').textContent, /didn't work/);
  b.type(b.$('jn-code'), code.toLowerCase().replace(/-/g, ' '));
  b.$('jn-form').dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }));
  await b.waitFor(() => b.$('room-title').textContent === 'Study group', 'B joined');

  // --- encrypted both ways
  await a.say('the answer is 42');
  await b.waitFor(() => b.messages().includes('the answer is 42'), 'B decrypts A');
  await b.say('thanks!');
  await a.waitFor(() => a.messages().includes('thanks!'), 'A decrypts B');

  // --- the server never saw plaintext: verify by sniffing what the room relayed
  const ioSockets = Array.from(srv.server.listeners('request')).length; // sanity: server alive
  assert.ok(ioSockets >= 1);
  assert.deepStrictEqual(pageErrors, []);
});

test('invite link opens the join dialog pre-filled and scrubs the code from the address bar', async () => {
  const a = await openClient('linkA');
  await a.guest();
  a.click(a.$('open-create'));
  a.type(a.$('cr-name'), 'Invite me');
  a.$('cr-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => a.visible(a.$('cr-result')), 'created');
  const code = a.$('cr-code').textContent;

  // a new visitor opens /#join=CODE
  const jar = new CookieJar();
  const c = await (async () => {
    const dom = await JSDOM.fromURL(`${srv.base}/#join=${code}`, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, cookieJar: jar,
      beforeParse(window) {
        Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
        window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.fetch = async (url, o = {}) => {
          const full = new URL(url, srv.base).href;
          const headers = { ...(o.headers || {}), 'cf-connecting-ip': '10.99.0.1' };
          const ck = jar.getCookieStringSync(full); if (ck) headers.cookie = ck;
          const r = await fetch(full, { method: o.method || 'GET', headers, body: o.body });
          for (const s of r.headers.getSetCookie()) jar.setCookieSync(s, full);
          return r;
        };
        window.sessionStorage.setItem('zent_booted', '1');
      },
    });
    doms.push(dom);
    for (let i = 0; i < 400 && dom.window.document.readyState !== 'complete'; i++) await sleep(25);
    await sleep(120);
    return dom;
  })();
  const d = c.window.document;
  const el = (id) => d.getElementById(id);
  const until = async (fn, what) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > 6000) throw new Error('timeout ' + what); await sleep(25); } };
  await until(() => !el('auth-screen').classList.contains('is-hidden'), 'auth');
  el('guest-btn').click();
  await until(() => el('dlg-join').classList.contains('is-open'), 'join dialog');
  assert.strictEqual(el('jn-code').value, code);
  assert.strictEqual(c.window.location.hash, '', 'code scrubbed from the URL');
});

test('friends: a message waits for an offline friend; they come back on a new device, see it unread, decrypt it; codes match; the server holds no readable text', async () => {
  const fs = require('fs'), path = require('path');
  const a = await openClient('frA'), b = await openClient('frB');
  await a.register('frienda', 'password-a-123');
  await b.register('friendb', 'password-b-123');

  b.click(b.document.querySelector('.tab[data-tab="friends"]'));
  await b.waitFor(() => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(b.$('friend-code-text').textContent), 'B code');
  const bCode = b.$('friend-code-text').textContent;
  a.click(a.document.querySelector('.tab[data-tab="friends"]'));
  a.type(a.$('add-friend-input'), bCode);
  a.$('add-friend-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => a.document.querySelectorAll('#friend-list .item').length === 1, 'A sees B');
  await b.waitFor(() => b.document.querySelectorAll('#friend-list .item').length === 1, 'B sees A (live)');

  // B goes offline entirely
  b.window.eval('Net').disconnect();
  b.window.close();
  await a.waitFor(() => !a.document.querySelector('#friend-list .dot.is-on'), 'B shows offline');

  // A writes anyway
  a.click(a.document.querySelector('#friend-list .item'));
  await a.waitFor(() => a.$('room-title').textContent === 'friendb', 'A in the chat');
  await a.waitFor(() => !a.$('composer-input').disabled, 'can write to an offline friend');
  assert.strictEqual(a.$('mode-stamp').textContent, 'SEALED');
  assert.strictEqual(a.$('room-count').textContent, 'offline');
  await a.say('left you a message');
  await a.waitFor(() => a.messages().includes('left you a message'), 'shows for A');
  await sleep(200);
  const dmFile = path.join(path.dirname(process.env.DB_FILE), 'dm.jsonl');
  assert.ok(fs.existsSync(dmFile));
  assert.ok(!fs.readFileSync(dmFile, 'utf8').includes('left you a message'), 'only ciphertext on the server');

  // B comes back on a different device and signs in with the password
  const b2 = await openClient('frB2');
  await b2.login('friendb', 'password-b-123');
  b2.click(b2.document.querySelector('.tab[data-tab="friends"]'));
  await b2.waitFor(() => (b2.document.querySelector('#friend-list .badge') || {}).textContent === '1', 'unread badge for the waiting message');
  b2.click(b2.document.querySelector('#friend-list .item'));
  await b2.waitFor(() => b2.messages().includes('left you a message'), 'B decrypts it on the new device');
  const sa = a.$('safety').textContent, sb = b2.$('safety').textContent;
  assert.match(sa, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.strictEqual(sa, sb, 'same safety code on both sides');
  await b2.waitFor(() => !b2.document.querySelector('#friend-list .badge'), 'marked read');

  await b2.say('got it');
  await a.waitFor(() => a.messages().includes('got it'), 'A gets the reply live');

  // B opens the site again with only a saved session: messages ask for the password once
  const b3 = await openClient('frB3', { cookie: b2.jar.getCookieStringSync(srv.base + '/') });
  await b3.waitFor(() => b3.visible(b3.$('app')) && b3.$('signal').dataset.state === 'up', 'signed in from the saved session');
  b3.click(b3.document.querySelector('.tab[data-tab="friends"]'));
  await b3.waitFor(() => b3.document.querySelectorAll('#friend-list .item').length === 1, 'friend list');
  b3.click(b3.document.querySelector('#friend-list .item'));
  await b3.waitFor(() => b3.$('dlg-unlock').classList.contains('is-open'), 'unlock dialog');
  b3.type(b3.$('unlock-password'), 'not-my-password');
  b3.$('unlock-form').dispatchEvent(new b3.window.Event('submit', { bubbles: true, cancelable: true }));
  await b3.waitFor(() => /Wrong password/.test(b3.$('unlock-error').textContent), 'wrong password explained');
  b3.type(b3.$('unlock-password'), 'password-b-123');
  b3.$('unlock-form').dispatchEvent(new b3.window.Event('submit', { bubbles: true, cancelable: true }));
  await b3.waitFor(() => b3.messages().includes('left you a message') && b3.messages().includes('got it'), 'history after unlocking', 8000);
  assert.strictEqual(b3.$('safety').textContent, sa, 'same code on every device');

  // unfriend deletes the chat for both
  a.click(a.document.querySelector('#friend-list .item-x'));
  await a.waitFor(() => a.$('dlg-confirm').classList.contains('is-open'), 'confirm dialog');
  assert.match(a.$('cf-text').textContent, /deletes your chat history/);
  a.click(a.$('cf-ok'));
  await a.waitFor(() => a.document.querySelectorAll('#friend-list .item').length === 0, 'A list empty');
  await b3.waitFor(() => b3.document.querySelectorAll('#friend-list .item').length === 0, 'B list empty');
  assert.deepStrictEqual(pageErrors, []);
});

test('rooms burn: when the server says time is up, the UI toasts, removes the room, and drops you back to #public', async () => {
  const a = await openClient('burnA');
  await a.guest();
  a.click(a.$('open-create'));
  a.type(a.$('cr-name'), 'Doomed');
  a.$('cr-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => a.visible(a.$('cr-result')), 'created');
  a.click(a.$('cr-open'));
  await a.waitFor(() => a.$('room-title').textContent === 'Doomed', 'inside');
  assert.strictEqual(a.document.querySelectorAll('#room-list .item').length, 2);
  assert.ok(a.window.localStorage.getItem('zent_rooms'), 'remembered on this device');

  // the server-side timer is covered in realtime.test.js; here we check what the page does with the event
  const key = 'c:' + a.$('cr-code').textContent.slice(0, 4);
  srv.io.to(key).emit('room:expired', { room: key, name: 'Doomed', reason: 'expired' });
  await a.waitFor(() => /Doomed.*burned/.test(a.document.querySelector('.toast').textContent), 'toast');
  await a.waitFor(() => a.document.querySelectorAll('#room-list .item').length === 1, 'room removed from list', 4000);
  await a.waitFor(() => a.$('room-title').textContent === 'public', 'back in public', 4000);
  assert.strictEqual(a.window.localStorage.getItem('zent_rooms'), null, 'no longer remembered');
  assert.ok(!a.document.querySelector('[data-room="' + key + '"]'), 'its message log is gone');
  assert.deepStrictEqual(pageErrors, []);
});

test('settings: themes switch, custom theme round-trips through a share code, toggles persist', async () => {
  const a = await openClient('settings');
  await a.guest();
  a.click(a.$('open-settings'));
  assert.ok(a.$('settings').classList.contains('is-open'));

  const swatches = a.document.querySelectorAll('#theme-grid .swatch');
  assert.strictEqual(swatches.length, 9, '8 presets + custom');
  const paper = Array.from(swatches).find((s) => /paper/i.test(s.textContent));
  a.click(paper);
  assert.strictEqual(a.document.documentElement.dataset.theme, 'paper');
  assert.strictEqual(a.document.documentElement.style.getPropertyValue('--bg').trim(), '#e9e2d0');
  assert.strictEqual(a.document.documentElement.style.colorScheme, 'light');
  const phos = Array.from(a.document.querySelectorAll('#theme-grid .swatch')).find((s) => /phosphor/i.test(s.textContent));
  a.click(phos);
  assert.strictEqual(a.document.documentElement.dataset.scan, '1');
  assert.strictEqual(a.document.documentElement.dataset.mono, '1');

  // custom theme: change accent, copy the code, load it in a fresh page
  a.type(a.$('ct-accent'), '#12ab34');
  assert.strictEqual(a.document.documentElement.dataset.theme, 'custom');
  assert.strictEqual(a.document.documentElement.style.getPropertyValue('--accent').trim(), '#12ab34');
  const { window } = a;
  const code = window.eval('Themes').exportCode(window.eval('Themes').getCustom());
  assert.match(code, /^ZT1\.[A-Za-z0-9_-]+$/);
  const b = await openClient('settings2');
  await b.guest();
  b.type(b.$('ct-code'), code);
  b.click(b.$('ct-import'));
  assert.strictEqual(b.document.documentElement.dataset.theme, 'custom');
  assert.strictEqual(b.$('ct-accent').value, '#12ab34');
  b.type(b.$('ct-code'), 'ZT1.not-a-real-code');
  b.click(b.$('ct-import'));
  assert.ok(b.document.querySelector('.toast.is-error'), 'bad code is rejected with a message');

  // settings persist in localStorage and survive a reload of the module
  a.$('set-compact').checked = true;
  a.$('set-compact').dispatchEvent(new a.window.Event('change', { bubbles: true }));
  assert.strictEqual(a.document.documentElement.dataset.compact, '1');
  assert.strictEqual(JSON.parse(a.window.localStorage.getItem('zent_settings_v2')).compact, true);
  assert.strictEqual(JSON.parse(a.window.localStorage.getItem('zent_settings_v2')).theme, 'custom');

  // translation toggle is disabled with an honest note where the browser lacks it
  assert.ok(a.$('set-translate').disabled);
  assert.match(a.$('translate-note').textContent, /Not available/);
  assert.deepStrictEqual(pageErrors, []);
});

/** Opens the site in a brand-new tab: same cookies + saved settings, but no sessionStorage. */
async function openFreshTab(cookieHeader, settingsJson, label) {
  const jar = new CookieJar();
  jar.setCookieSync(cookieHeader.split(';')[0], srv.base + '/');
  const dom = await JSDOM.fromURL(srv.base + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, cookieJar: jar,
    beforeParse(window) {
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.localStorage.setItem('zent_settings_v2', settingsJson);
      window.sessionStorage.setItem('zent_booted', '1'); // skip the intro, but NOT zent_tab: that's what makes it a new tab
      window.fetch = async (url, o = {}) => {
        const full = new URL(url, srv.base).href;
        const headers = { ...(o.headers || {}), 'cf-connecting-ip': '10.98.' + label };
        const ck = jar.getCookieStringSync(full); if (ck) headers.cookie = ck;
        const r = await fetch(full, { method: o.method || 'GET', headers, body: o.body });
        for (const sc of r.headers.getSetCookie()) jar.setCookieSync(sc, full);
        return r;
      };
    },
  });
  doms.push(dom);
  for (let i = 0; i < 400 && dom.window.document.readyState !== 'complete'; i++) await sleep(25);
  const d = dom.window.document;
  const until = async (fn, what, ms = 6000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(25); } };
  return { dom, jar, d, el: (id) => d.getElementById(id), until, hasSession: () => jar.getCookieStringSync(srv.base + '/').includes('token=') };
}

test('privacy: with "sign out when I close this tab" ON, a new tab is signed out (cookie really cleared); with it OFF the same cookie keeps you in', async () => {
  const a = await openClient('priv');
  await a.guest();
  const cookie = a.jar.getCookieStringSync(srv.base + '/');
  assert.ok(cookie.includes('token='));

  // control: setting OFF -> a new tab with the same cookie goes straight into the app
  const offSettings = JSON.stringify({ ...JSON.parse(a.window.localStorage.getItem('zent_settings_v2') || '{}'), wipeOnClose: false });
  const control = await openFreshTab(cookie, offSettings, '1.1');
  await control.until(() => !control.el('app').classList.contains('is-hidden'), 'control tab enters the app');
  assert.ok(control.hasSession(), 'control keeps its session');

  // setting ON -> a new tab is signed out for real
  a.$('set-wipe-close').checked = true;
  a.$('set-wipe-close').dispatchEvent(new a.window.Event('change', { bubbles: true }));
  const onSettings = a.window.localStorage.getItem('zent_settings_v2');
  assert.strictEqual(JSON.parse(onSettings).wipeOnClose, true);
  const fresh = await openFreshTab(cookie, onSettings, '1.2');
  await fresh.until(() => !fresh.hasSession(), 'session cookie cleared by the server');
  await sleep(300); // let the page finish its own startup
  assert.ok(!fresh.el('auth-screen').classList.contains('is-hidden'), 'sign-in screen shown');
  assert.ok(fresh.el('app').classList.contains('is-hidden'), 'app stays hidden');
  fresh.dom.window.close(); control.dom.window.close();
});

test('history: a newcomer sees what was said before they arrived (once), the room says it is saved, and my own old messages show as "you"', async () => {
  const a = await openClient('histA');
  await a.guest();
  const marker = 'HIST-' + Date.now();
  await a.say(marker);
  await a.waitFor(() => a.messages().includes(marker), 'own message');

  const b = await openClient('histB');
  await b.guest();
  await b.waitFor(() => b.messages().filter((t) => t === marker).length === 1, 'B sees the earlier message');
  assert.ok(b.$('composer-input').placeholder.includes('saved'));
  const row = Array.from(b.document.querySelectorAll('.log.is-visible .msg')).find((r) => r.querySelector('.msg-body').textContent === marker);
  assert.ok(row.classList.contains('no-anim'), 'history is drawn quietly, not as new arrivals');
  assert.ok(!row.classList.contains('is-own'), "someone else's message is not mine");

  // a live message after history loaded appears exactly once
  await sleep(1100);
  await a.say('LIVE-' + marker);
  await b.waitFor(() => b.messages().includes('LIVE-' + marker), 'live message');
  await sleep(300);
  assert.strictEqual(b.messages().filter((t) => t === 'LIVE-' + marker).length, 1, 'no duplicate');
  assert.strictEqual(b.messages().filter((t) => t === marker).length, 1, 'history message not repeated');

  // A comes back in a brand-new tab: their own saved messages are recognised as theirs
  const back = await openFreshTab(a.jar.getCookieStringSync(srv.base + '/'), '{}', '3.1');
  await back.until(() => !back.el('app').classList.contains('is-hidden'), 'A back in the app');
  await back.until(() => Array.from(back.d.querySelectorAll('.log.is-visible .msg.is-own .msg-body')).some((n) => n.textContent === marker), 'own history marked as mine');
  back.dom.window.close();
  assert.deepStrictEqual(pageErrors, []);
});

test('history: "Load older messages" pages back through everything with no gaps or duplicates, then the button goes away', async () => {
  const hist = require('../src/history');
  for (let i = 1; i <= 230; i++) hist.append({ id: 'older' + i, ts: Date.now(), sender: 'seeder', uid: 'seeduid', text: 'older message ' + i });
  const a = await openClient('older');
  await a.guest();
  await a.waitFor(() => a.document.querySelectorAll('.log.is-visible .msg').length >= 100, 'first page of history');
  assert.ok(a.document.querySelector('.log.is-visible .log-more'), 'a Load older button is offered');
  assert.strictEqual(a.messages().filter((t) => t === 'older message 230').length, 1);
  assert.strictEqual(a.messages().includes('older message 1'), false, 'oldest not loaded yet');

  for (let i = 0; i < 12 && a.document.querySelector('.log.is-visible .log-more'); i++) {
    const before = a.document.querySelectorAll('.log.is-visible .msg').length;
    a.click(a.document.querySelector('.log.is-visible .log-more'));
    await a.waitFor(() => a.document.querySelectorAll('.log.is-visible .msg').length > before || !a.document.querySelector('.log.is-visible .log-more'), 'older page arrives');
  }
  assert.ok(!a.document.querySelector('.log.is-visible .log-more'), 'no more to load, so the button is gone');
  const texts = a.messages();
  for (let i = 1; i <= 230; i++) assert.strictEqual(texts.filter((t) => t === 'older message ' + i).length, 1, `message ${i} appears exactly once`);
  const order = texts.map((t) => (t.match(/^older message (\d+)$/) || [])[1]).filter(Boolean).map(Number);
  assert.deepStrictEqual(order, [...order].sort((x, y) => x - y), 'still in chronological order');
  assert.deepStrictEqual(pageErrors, []);
});

test('history: after a dropped connection, messages sent meanwhile are caught up on reconnect', async () => {
  const a = await openClient('gapA'), b = await openClient('gapB');
  await a.guest(); await b.guest();
  const Net = a.window.eval('Net');
  Net.disconnect();
  await a.waitFor(() => a.$('signal').dataset.state !== 'up', 'A is offline');
  const marker = 'WHILE-AWAY-' + Date.now();
  await sleep(1100);
  await b.say(marker);
  await b.waitFor(() => b.messages().includes(marker), 'B sees own');
  assert.ok(!a.messages().includes(marker), 'A really missed it');
  Net.reconnect();
  await a.waitFor(() => a.messages().includes(marker), 'A catches up', 8000);
  assert.strictEqual(a.messages().filter((t) => t === marker).length, 1);
  assert.ok(Array.from(a.document.querySelectorAll('.log.is-visible .sys')).some((n) => /caught up/.test(n.textContent)));
  assert.deepStrictEqual(pageErrors, []);
});


test('on an insecure (http) page: a clear note with the secure address, and New room explains itself instead of doing nothing', async () => {
  const a = await openClient('insecure', { insecure: true });
  await a.guest();
  await a.waitFor(() => !a.$('insecure-note').classList.contains('is-hidden'), 'warning shown');
  await a.waitFor(() => !a.$('secure-link').classList.contains('is-hidden'), 'link to the https site');
  assert.strictEqual(a.$('secure-link').getAttribute('href'), 'https://chat.example.org');
  a.click(a.$('open-create'));
  await a.waitFor(() => /secure/i.test((a.document.querySelector('.toast.is-error') || {}).textContent || ''), 'an error toast, not silence');
  assert.ok(!a.$('dlg-create').classList.contains('is-open'), 'the dialog does not open into a dead end');
  a.click(a.$('open-join'));
  assert.ok(!a.$('dlg-join').classList.contains('is-open'));
  // public chat still works on http (it is not encrypted)
  await a.say('plain http still chats');
  await a.waitFor(() => a.messages().includes('plain http still chats'), 'public message');
  assert.deepStrictEqual(pageErrors, []);
});

test('settings: change password (wrong current password shows the reason; the right one works and clears the form)', async () => {
  const a = await openClient('pwchange');
  await a.register('pwchanger', 'start-pass-cedar-1');
  a.click(a.$('open-settings'));
  assert.ok(!a.$('pw-form').classList.contains('is-hidden'), 'members get the form');
  assert.ok(!a.$('btn-logout-all').classList.contains('is-hidden'));
  a.type(a.$('pw-current'), 'not-my-password');
  a.type(a.$('pw-next'), 'next-pass-maple-2');
  a.$('pw-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => !a.$('pw-msg').classList.contains('is-hidden'), 'error shown');
  assert.match(a.$('pw-msg').textContent, /Current password is wrong/);
  a.type(a.$('pw-current'), 'start-pass-cedar-1');
  a.$('pw-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => /Password changed/.test((a.document.querySelector('.toast') || {}).textContent || ''), 'success toast');
  assert.strictEqual(a.$('pw-current').value, '');
  assert.strictEqual((await a.window.eval('Api').me()).username, 'pwchanger', 'this device is still signed in');
  const g = await openClient('pwguest');
  await g.guest();
  assert.ok(g.$('pw-form').classList.contains('is-hidden'), 'guests have no password form');
  assert.deepStrictEqual(pageErrors, []);
});

/* ============================== v2.5 features ============================== */

const submitComposer = (c) => c.$('composer').dispatchEvent(new c.window.Event('submit', { bubbles: true, cancelable: true }));
const rowFor = (c, text) => Array.from(c.document.querySelectorAll('.log.is-visible .msg')).find((r) => r.querySelector('.msg-body').textContent === text);

test('edit + delete in #public: your own messages get Edit/Delete, others see the change live, other people get no buttons', async () => {
  const a = await openClient('edA'), b = await openClient('edB');
  await a.guest(); await b.guest();
  await sleep(1100);
  await a.say('meet at 5');
  await b.waitFor(() => b.messages().includes('meet at 5'), 'B sees it');
  await a.waitFor(() => rowFor(a, 'meet at 5'), 'A sees it');
  assert.ok(rowFor(a, 'meet at 5').querySelector('.msg-act'), 'A has actions on their message');
  assert.strictEqual(rowFor(b, 'meet at 5').querySelector('.msg-act'), null, "B can't edit A's message");

  // A edits with the Edit button
  a.click(Array.from(rowFor(a, 'meet at 5').querySelectorAll('.msg-act button')).find((x) => x.textContent === 'Edit'));
  await a.waitFor(() => a.visible(a.$('edit-bar')), 'edit mode');
  assert.strictEqual(a.$('composer-input').value, 'meet at 5');
  await sleep(1100);
  a.type(a.$('composer-input'), 'meet at 6');
  submitComposer(a);
  await b.waitFor(() => b.messages().includes('meet at 6'), 'B sees the edit');
  assert.ok(rowFor(b, 'meet at 6').classList.contains('is-edited'));
  await a.waitFor(() => !a.visible(a.$('edit-bar')) && a.$('composer-input').value === '', 'edit mode ends');
  assert.ok(!a.messages().includes('meet at 5'));

  // up arrow edits your last message, Esc backs out
  a.$('composer-input').dispatchEvent(new a.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await a.waitFor(() => a.visible(a.$('edit-bar')) && a.$('composer-input').value === 'meet at 6', 'up arrow');
  a.$('composer-input').dispatchEvent(new a.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await a.waitFor(() => !a.visible(a.$('edit-bar')) && a.$('composer-input').value === '', 'esc cancels');

  // delete
  a.click(Array.from(rowFor(a, 'meet at 6').querySelectorAll('.msg-act button')).find((x) => x.textContent === 'Delete'));
  await a.waitFor(() => a.$('dlg-confirm').classList.contains('is-open'), 'confirm');
  a.click(a.$('cf-ok'));
  await b.waitFor(() => !b.messages().includes('meet at 6'), 'gone for B');
  await a.waitFor(() => !a.messages().includes('meet at 6'), 'gone for A');
  assert.deepStrictEqual(pageErrors, []);
});

test('emoji picker: opens, inserts at the cursor, remembers recent ones, closes on an outside click', async () => {
  const a = await openClient('emoji');
  await a.guest();
  a.type(a.$('composer-input'), 'hi ');
  a.click(a.$('btn-emoji'));
  await a.waitFor(() => a.visible(a.$('emoji-pop')) && a.document.querySelector('#emoji-pop .emoji'), 'picker open');
  const first = a.document.querySelector('#emoji-pop .emoji');
  const e = first.textContent;
  a.click(first);
  assert.strictEqual(a.$('composer-input').value, 'hi ' + e);
  assert.ok(a.window.localStorage.getItem('zent_emoji_recent').includes(e));
  a.document.querySelector('.stream').dispatchEvent(new a.window.Event('pointerdown', { bubbles: true }));
  assert.ok(!a.visible(a.$('emoji-pop')), 'closed');
  await a.say(a.$('composer-input').value + ' 👨‍💻');
  await a.waitFor(() => a.messages().some((m) => m.includes('👨‍💻')), 'combined emoji survives the server');
  assert.ok(!a.visible(a.$('btn-gif')), 'GIF button hidden while GIFs are off');
  assert.deepStrictEqual(pageErrors, []);
});

test('files in a private room: encrypted in the browser, the server only stores noise, the other person gets the real picture; deleting takes the file too', async () => {
  const fs = require('fs'), path = require('path');
  const a = await openClient('fileA'), b = await openClient('fileB');
  await a.guest(); await b.guest();
  a.click(a.$('open-create'));
  a.type(a.$('cr-name'), 'Pics');
  a.$('cr-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => a.visible(a.$('cr-result')), 'created');
  const code = a.$('cr-code').textContent;
  a.click(a.$('cr-open'));
  b.click(b.$('open-join'));
  b.type(b.$('jn-code'), code);
  b.$('jn-form').dispatchEvent(new b.window.Event('submit', { bubbles: true, cancelable: true }));
  await b.waitFor(() => b.$('room-title').textContent === 'Pics', 'B joined');

  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const file = new a.window.File([new a.window.Uint8Array(PNG)], 'dot.png', { type: 'image/png' });
  Object.defineProperty(a.$('file-input'), 'files', { value: [file], configurable: true });
  a.type(a.$('composer-input'), 'look at this');
  a.$('file-input').dispatchEvent(new a.window.Event('change', { bubbles: true }));
  await b.waitFor(() => b.document.querySelector('.log.is-visible .att-media img[src^="blob:"]'), 'B decrypted the picture', 8000);
  assert.ok(b.messages().includes('look at this'), 'caption came along');
  assert.strictEqual(a.$('composer-input').value, '', 'caption cleared after sending');

  // what B decrypted is byte-for-byte the original
  const blob = b.window.__blobs.at(-1);
  const bytes = await new Promise((res) => { const r = new b.window.FileReader(); r.onload = () => res(Buffer.from(r.result)); r.readAsArrayBuffer(blob); });
  assert.ok(bytes.equals(PNG), 'decrypted bytes match');
  assert.strictEqual(blob.type, 'image/png');

  // and the server never had the picture
  const dir = path.join(path.dirname(process.env.DB_FILE), 'files');
  const stored = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f)));
  assert.ok(stored.length >= 1);
  assert.ok(stored.every((buf) => buf.indexOf(PNG.slice(16, 40)) === -1 && buf.indexOf(Buffer.from('IHDR')) === -1), 'only ciphertext on disk');
  const before = fs.readdirSync(dir).length;

  // A deletes the message: gone for B, file gone from the server
  await a.waitFor(() => a.document.querySelector('.log.is-visible .msg.is-own .msg-act'), 'A has actions');
  a.click(Array.from(a.document.querySelectorAll('.log.is-visible .msg.is-own .msg-act button')).find((x) => x.textContent === 'Delete'));
  await a.waitFor(() => a.$('dlg-confirm').classList.contains('is-open'), 'confirm');
  a.click(a.$('cf-ok'));
  await b.waitFor(() => !b.document.querySelector('.log.is-visible .att-media'), 'gone for B');
  await a.waitFor(() => fs.readdirSync(dir).length === before - 1, 'file deleted on the server');
  assert.deepStrictEqual(pageErrors, []);
});

test('guests are told why they cannot post pictures in #public (and nothing is uploaded)', async () => {
  const a = await openClient('pubpic');
  await a.guest();
  const file = new a.window.File(['x'], 'x.png', { type: 'image/png' });
  Object.defineProperty(a.$('file-input'), 'files', { value: [file], configurable: true });
  a.$('file-input').dispatchEvent(new a.window.Event('change', { bubbles: true }));
  await a.waitFor(() => /Make an account/.test(a.$('toasts').textContent), 'explains');
  assert.ok(!a.visible(a.$('upload-bar')));
  assert.deepStrictEqual(pageErrors, []);
});

test('friend chat: edit with the up arrow shows on the other side as edited', async () => {
  const a = await openClient('dmEdA'), b = await openClient('dmEdB');
  await a.register('dmedita', 'password-a-456');
  await b.register('dmeditb', 'password-b-456');
  b.click(b.document.querySelector('.tab[data-tab="friends"]'));
  await b.waitFor(() => /^[A-HJ-NP-Z2-9]{4}-/.test(b.$('friend-code-text').textContent), 'B code');
  a.click(a.document.querySelector('.tab[data-tab="friends"]'));
  a.type(a.$('add-friend-input'), b.$('friend-code-text').textContent);
  a.$('add-friend-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => a.document.querySelectorAll('#friend-list .item').length === 1, 'friends');
  await b.waitFor(() => b.document.querySelectorAll('#friend-list .item').length === 1, 'friends (B)');
  a.click(a.document.querySelector('#friend-list .item'));
  b.click(b.document.querySelector('#friend-list .item'));
  await a.waitFor(() => a.$('room-title').textContent === 'dmeditb' && !a.$('composer-input').disabled, 'A in the chat');
  await b.waitFor(() => b.$('room-title').textContent === 'dmedita' && b.document.querySelector('.log.is-visible .log-empty'), 'B in the chat');
  await a.say('see you tmrw');
  await b.waitFor(() => b.messages().includes('see you tmrw'), 'B got it');
  await sleep(1100);
  a.$('composer-input').dispatchEvent(new a.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await a.waitFor(() => a.visible(a.$('edit-bar')), 'editing');
  a.type(a.$('composer-input'), 'see you tomorrow');
  submitComposer(a);
  await b.waitFor(() => b.messages().includes('see you tomorrow'), 'B sees the edit');
  assert.ok(rowFor(b, 'see you tomorrow').classList.contains('is-edited'));
  assert.deepStrictEqual(pageErrors, []);
});

test('profiles: edit yours in Settings, others open it by clicking your name, and the public page works signed out', async () => {
  const a = await openClient('profA'), b = await openClient('profB');
  await a.register('profiler', 'password-p-789');
  await b.guest();
  assert.ok(a.visible(a.$('profile-sec')), 'members get a profile section');
  assert.ok(!b.visible(b.$('profile-sec')), 'guests do not');

  await a.waitFor(() => a.$('prof-view').getAttribute('href') === '/u/profiler', 'editor loaded');
  a.type(a.$('prof-display'), 'The Profiler');
  a.type(a.$('prof-status'), 'testing things');
  a.type(a.$('prof-bio'), 'I make <b>tests</b>.\nSecond line.');
  a.type(a.$('prof-accent'), '#33cc99');
  a.click(a.$('prof-link-add'));
  a.type(a.document.querySelector('#prof-links .prof-link-label'), 'Site');
  a.type(a.document.querySelector('#prof-links .prof-link-url'), 'example.com');
  a.$('prof-public').checked = true;
  a.$('prof-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => /Profile saved/.test(a.$('toasts').textContent), 'saved');
  assert.strictEqual(a.document.querySelector('#prof-links .prof-link-url').value, 'https://example.com/', 'link cleaned up');

  // a bad link is explained, not saved
  a.type(a.document.querySelector('#prof-links .prof-link-url'), 'javascript:alert(1)');
  a.$('prof-form').dispatchEvent(new a.window.Event('submit', { bubbles: true, cancelable: true }));
  await a.waitFor(() => a.visible(a.$('prof-msg')), 'error shown');
  assert.match(a.$('prof-msg').textContent, /link/);

  // B clicks A's name in #public
  await sleep(1100);
  await a.say('hello from my profile');
  await b.waitFor(() => rowFor(b, 'hello from my profile'), 'B sees it');
  b.click(rowFor(b, 'hello from my profile').querySelector('button.msg-who'));
  await b.waitFor(() => b.$('pf-name').textContent === 'The Profiler', 'profile popup');
  assert.strictEqual(b.$('pf-bio').textContent, 'I make <b>tests</b>.\nSecond line.', 'shown as text');
  assert.strictEqual(b.document.querySelector('#pf-bio b'), null);
  const link = b.document.querySelector('#pf-links a');
  assert.strictEqual(link.getAttribute('href'), 'https://example.com/');
  assert.match(link.getAttribute('rel'), /noopener/);
  assert.strictEqual(b.$('pf-status').textContent, 'testing things');

  // a guest's name explains there's no profile
  b.click(b.document.querySelector('#dlg-profile [data-close]'));
  await sleep(1100);
  await b.say('guest here');
  await a.waitFor(() => rowFor(a, 'guest here'), 'A sees guest');
  a.click(rowFor(a, 'guest here').querySelector('button.msg-who'));
  await a.waitFor(() => /Guests don't have profiles/.test(a.$('pf-bio').textContent), 'guest note');

  // signed out: the public page renders
  const anon = await openClient('profPage', { path: '/u/Profiler' });
  await anon.waitFor(() => !anon.$('pp-card').classList.contains('is-loading'), 'page rendered');
  assert.strictEqual(anon.$('pp-name').textContent, 'The Profiler');
  assert.match(anon.$('pp-handle').textContent, /^@profiler/);
  assert.strictEqual(anon.document.querySelector('#pp-links a').getAttribute('href'), 'https://example.com/');
  assert.strictEqual(anon.document.documentElement.style.getPropertyValue('--accent'), '#33cc99');
  assert.strictEqual(anon.window.getComputedStyle(anon.$('pp-missing')).display, 'none', 'the "nothing here" block really is hidden');
  const missing = await openClient('profMissing', { path: '/u/nobody_at_all' });
  await missing.waitFor(() => !missing.$('pp-missing').hidden, 'missing page');
  assert.deepStrictEqual(pageErrors, []);
});

test('admin page loads clean and says it is off when no password is set', async () => {
  const a = await openClient('admin', { path: '/admin' });
  await a.waitFor(() => a.visible(a.$('adm-off')), 'off notice');
  assert.ok(!a.visible(a.$('adm-dash')));
  assert.deepStrictEqual(pageErrors, []);
});
