// The app.
(() => {
  const { $, h } = Ui;
  const PUBLIC = 'public';
  const P2P = 'p2p';
  const SITE_TITLE = 'ZENT — sealed chat';
  const ROOMS_KEY = 'zent_rooms';

  const state = {
    me: null, // { id, uid, username, role }
    current: PUBLIC,
    rooms: new Map(), // key -> room
    friends: [],
    online: new Set(),
    keys: null, // { priv, pub } once friend messages are unlocked on this device
    unlockResolve: null,
    justAdded: new Set(), // friends I just added myself (so I don't get a second toast)
    history: { enabled: false, days: 0 }, // public-room history settings, as told by the server
    publicMsgs: [], // saved + live public messages, oldest first
    publicSeen: new Set(), // ids already shown (history and live can overlap)
    pendingPublic: [], // live messages that arrived while history was still loading
    historyReady: false,
    hasMore: false,
    typing: new Map(), // key -> Map(uid -> { name, timer })
    ready: false,
    sending: false,
    createdRoom: null,
    cfg: { gifs: false, uploads: { enabled: true, maxBytes: 10 * 1024 * 1024, publicUploads: 'members' } },
    editing: null, // { key, id, att } while you're fixing a message
    uploading: false,
    profile: null, // my own profile (members)
  };

  // owners: message id -> sender uid, so an edit/delete is only applied if it comes from whoever sent it
  const makeRoom = (o) => ({ count: 0, unread: 0, owners: new Map(), ...o });

  /* ---- what goes inside an encrypted message ----
   * plain text stays plain text (so older versions still read normal messages).
   * text + attachment is packed as JSON behind a private-use marker character. */
  const ENV = '\uE000';
  const FILE_ID = /^[A-Za-z0-9_-]{22}$/;
  const GIF_ID = /^[A-Za-z0-9]{1,40}$/;
  const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
  const dimOf = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 && n <= 10000 ? n : 0; };
  function cleanAtt(a) {
    if (!a || typeof a !== 'object') return undefined;
    if (a.t === 'gif' && GIF_ID.test(a.id)) return { t: 'gif', id: a.id, w: dimOf(a.w), h: dimOf(a.h) };
    if (a.t === 'img' && FILE_ID.test(a.id)) return { t: 'img', id: a.id, w: dimOf(a.w), h: dimOf(a.h) };
    if (a.t === 'file' && FILE_ID.test(a.id) && typeof a.key === 'string' && a.key.length === 44 && B64.test(a.key) &&
        typeof a.iv === 'string' && a.iv.length === 16 && B64.test(a.iv)) {
      const mime = typeof a.mime === 'string' && /^[\w.+-]{1,60}\/[\w.+-]{1,60}$/.test(a.mime) ? a.mime : 'application/octet-stream';
      return { t: 'file', id: a.id, key: a.key, iv: a.iv, name: Attach.cleanName(a.name), mime, size: Math.max(0, Math.floor(Number(a.size) || 0)), w: dimOf(a.w), h: dimOf(a.h) };
    }
    return undefined;
  }
  const pack = (text, att) => (att ? ENV + JSON.stringify({ v: 1, text: text || '', att }) : text);
  function unpack(plain) {
    if (typeof plain !== 'string' || plain.charAt(0) !== ENV) return { text: plain, att: undefined };
    try {
      const o = JSON.parse(plain.slice(1));
      return { text: typeof o.text === 'string' ? o.text : '', att: cleanAtt(o.att) };
    } catch {
      return { text: plain.slice(1), att: undefined };
    }
  }

  // Browsers only allow the encryption engine on https pages (and localhost).
  const SECURE = window.isSecureContext !== false && !!(window.crypto && window.crypto.subtle);
  const NEED_HTTPS = 'Private rooms need a secure (https) connection.';
  function needsSecure() {
    if (SECURE) return false;
    Ui.toast(NEED_HTTPS, 'error');
    return true;
  }

  async function showInsecureNote() {
    if (SECURE) return;
    $('insecure-note').classList.remove('is-hidden');
    try {
      const { publicUrl } = await Api.config();
      if (publicUrl) { $('secure-link').href = publicUrl; $('secure-link').classList.remove('is-hidden'); }
    } catch { /* offline */ }
  }

  /** Browsers that block storage throw on access; never let that stop the app. */
  const store = {
    get(area, k) { try { return window[area].getItem(k); } catch { return null; } },
    set(area, k, v) { try { window[area].setItem(k, v); } catch { /* blocked */ } },
    del(area, k) { try { window[area].removeItem(k); } catch { /* blocked */ } },
  };

  /* =====================================================================
   *  settings / look
   * ===================================================================== */
  function applyLook() {
    const root = document.documentElement;
    Themes.apply(Settings.get('theme'));
    root.dataset.motion = Settings.get('motion') ? 'on' : 'off';
    root.dataset.compact = Settings.get('compact') ? '1' : '0';
    root.dataset.blur = Settings.get('blurOnHide') ? '1' : '0';
    root.style.setProperty('--scale', String(Settings.get('fontScale') / 100));
    Ui.setCompact(Settings.get('compact'));
    buildThemeGrid();
  }

  function buildThemeGrid() {
    const grid = $('theme-grid');
    grid.textContent = '';
    const entries = Object.entries(Themes.PRESETS).concat([['custom', Themes.getCustom()]]);
    for (const [name, t] of entries) {
      grid.append(
        h(
          'button',
          {
            class: 'swatch' + (Settings.get('theme') === name ? ' is-active' : ''),
            type: 'button',
            'aria-label': `${t.label || name} theme`,
            vars: { '--sw-bg': t.bg, '--sw-ink': t.ink, '--sw-accent': t.accent, '--sw-hot': t.hot },
            on: { click: () => { Settings.set('theme', name); applyLook(); } },
          },
          h('i'),
          t.label || name
        )
      );
    }
  }

  function bindSettings() {
    const toggle = (id, key) => {
      const el = $(id);
      el.checked = !!Settings.get(key);
      el.addEventListener('change', () => { Settings.set(key, el.checked); if (['motion', 'compact', 'blurOnHide'].includes(key)) applyLook(); });
    };
    toggle('set-sound', 'sound');
    toggle('set-24h', 'hour24');
    toggle('set-compact', 'compact');
    toggle('set-motion', 'motion');
    toggle('set-boot', 'boot');
    toggle('set-remember', 'rememberRooms');
    toggle('set-wipe-close', 'wipeOnClose');
    toggle('set-blur', 'blurOnHide');

    const fs = $('set-fontscale');
    fs.value = String(Settings.get('fontScale'));
    fs.addEventListener('input', () => { Settings.set('fontScale', Number(fs.value)); applyLook(); });

    $('set-remember').addEventListener('change', persistRooms);

    // translation
    const sel = $('set-translate-to');
    for (const [code, name] of Translate.LANGS) sel.append(h('option', { value: code, text: name }));
    sel.value = Settings.get('translateTo');
    sel.addEventListener('change', () => Settings.set('translateTo', sel.value));
    const tr = $('set-translate');
    tr.checked = Settings.get('translate') && Translate.supported();
    tr.addEventListener('change', () => Settings.set('translate', tr.checked));
    if (!Translate.supported()) {
      tr.checked = false;
      tr.disabled = true;
      sel.disabled = true;
      $('translate-note').textContent = 'Not available in this browser (works in recent Chrome and Edge).';
    } else {
      $('translate-note').textContent = 'Runs on your device.';
    }

    // custom theme
    const ct = Themes.getCustom();
    $('ct-bg').value = ct.bg; $('ct-panel').value = ct.panel; $('ct-ink').value = ct.ink;
    $('ct-accent').value = ct.accent; $('ct-hot').value = ct.hot;
    $('ct-radius').value = ct.radius; $('ct-shadow').value = ct.shadow; $('ct-mono').checked = ct.mono;
    const readCustom = () => ({
      bg: $('ct-bg').value, panel: $('ct-panel').value, ink: $('ct-ink').value, accent: $('ct-accent').value, hot: $('ct-hot').value,
      radius: $('ct-radius').value, shadow: $('ct-shadow').value, mono: $('ct-mono').checked,
    });
    const useCustom = () => {
      if (!Themes.saveCustom(readCustom())) return false;
      Settings.set('theme', 'custom');
      applyLook();
      return true;
    };
    for (const id of ['ct-bg', 'ct-panel', 'ct-ink', 'ct-accent', 'ct-hot', 'ct-radius', 'ct-shadow', 'ct-mono']) {
      $(id).addEventListener('input', useCustom); // live preview
      $(id).addEventListener('change', useCustom);
    }
    $('ct-use').addEventListener('click', () => { if (useCustom()) Ui.toast('Custom theme applied.'); });
    $('ct-share').addEventListener('click', async () => {
      const code = Themes.exportCode(Themes.saveCustom(readCustom()));
      Ui.toast((await Ui.copy(code)) ? 'Theme code copied. Send it to a friend.' : code);
    });
    $('ct-import').addEventListener('click', () => {
      const t = Themes.importCode($('ct-code').value);
      if (!t) return Ui.toast("That doesn't look like a theme code.", 'error');
      Themes.saveCustom(t);
      $('ct-bg').value = t.bg; $('ct-panel').value = t.panel; $('ct-ink').value = t.ink;
      $('ct-accent').value = t.accent; $('ct-hot').value = t.hot; $('ct-radius').value = t.radius;
      $('ct-shadow').value = t.shadow; $('ct-mono').checked = t.mono;
      $('ct-code').value = '';
      Settings.set('theme', 'custom');
      applyLook();
      Ui.toast('Theme loaded.');
    });

    $('btn-forget-rooms').addEventListener('click', async () => {
      if (!(await Ui.confirmBox({ title: 'Forget saved rooms?', text: "They'll no longer reopen on this device. You'll need the join code to get back in.", ok: 'Forget' }))) return;
      try { localStorage.removeItem(ROOMS_KEY); } catch { /* ignore */ }
      Ui.toast('Saved rooms forgotten.');
    });
    $('btn-panic').addEventListener('click', async () => {
      if (!(await Ui.confirmBox({ title: 'Wipe everything?', text: 'Signs you out and erases every setting, saved room and key on this device. Public chat history lives on the server and is not affected.', ok: 'Wipe it all' }))) return;
      panic();
    });
    $('btn-logout').addEventListener('click', logout);
    $('btn-logout-all').addEventListener('click', async () => {
      if (!(await Ui.confirmBox({ title: 'Sign out everywhere?', text: 'Every device, including this one.', ok: 'Sign out' }))) return;
      try { await Api.logoutAll(); } catch { /* signed out anyway */ }
      location.reload();
    });
    $('pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      const msg = $('pw-msg');
      msg.classList.add('is-hidden');
      busy(btn, true);
      try {
        const current = $('pw-current').value;
        const next = $('pw-next').value;
        let keys;
        const mine = (await Api.myKeys()).keys;
        if (mine && mine.wrapped) {
          try { keys = await Keys.relock(current, next, mine); } catch { throw new Error('Current password is wrong.'); }
        }
        await Api.changePassword(current, next, keys);
        $('pw-current').value = '';
        $('pw-next').value = '';
        Ui.toast('Password changed. Other devices were signed out.');
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.remove('is-hidden');
      } finally {
        busy(btn, false);
      }
    });
  }

  async function panic() {
    try { await Api.logout(); } catch { /* offline is fine */ }
    Vault.wipe();
    await Keys.forgetAll();
    try { PeerSession.teardown(); } catch { /* not connected */ }
    Net.disconnect();
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('zent_')).forEach((k) => localStorage.removeItem(k));
      sessionStorage.clear();
    } catch { /* storage blocked */ }
    location.replace('/');
  }

  async function logout() {
    try { await Api.logout(); } catch { /* ignore */ }
    Vault.wipe();
    await Keys.forgetAll();
    try { PeerSession.teardown(); } catch { /* ignore */ }
    Net.disconnect();
    try { localStorage.removeItem(ROOMS_KEY); } catch { /* ignore */ }
    location.reload();
  }

  /* =====================================================================
   *  first-load intro
   * ===================================================================== */
  function runBoot() {
    return new Promise((resolve) => {
      if (!Settings.get('boot') || !Settings.get('motion') || store.get('sessionStorage', 'zent_booted') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return resolve();
      store.set('sessionStorage', 'zent_booted', '1');
      const el = $('boot');
      const out = $('boot-text');
      const lines = ['ZENT//SIGNAL  v2', 'gathering entropy ........ ok', 'sealing the room .......... ok', 'private logs .............. none', 'ready.'];
      const text = lines.join('\n');
      el.classList.add('is-on');
      let i = 0;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearInterval(t);
        el.classList.add('is-off');
        setTimeout(() => { el.classList.remove('is-on', 'is-off'); resolve(); }, 450);
      };
      const t = setInterval(() => {
        out.textContent = text.slice(0, ++i);
        if (i >= text.length) setTimeout(done, 260);
      }, 16);
      el.addEventListener('pointerdown', done, { once: true });
      document.addEventListener('keydown', done, { once: true });
    });
  }

  /* =====================================================================
   *  sign in
   * ===================================================================== */
  function showAuth() {
    $('app').classList.add('is-hidden');
    $('auth-screen').classList.remove('is-hidden');
    $('login-username').focus({ preventScroll: true });
  }

  function authError(msg) {
    const box = $('auth-error');
    box.textContent = msg;
    box.classList.remove('is-hidden');
    box.style.animation = 'none';
    void box.offsetWidth;
    box.style.animation = '';
  }

  function busy(btn, on) {
    btn.disabled = on;
    btn.classList.toggle('is-busy', on);
  }

  function switchAuthTab(which) {
    const login = which === 'login';
    $('tab-login').classList.toggle('is-active', login);
    $('tab-register').classList.toggle('is-active', !login);
    $('login-form').classList.toggle('is-hidden', !login);
    $('register-form').classList.toggle('is-hidden', login);
    $('auth-error').classList.add('is-hidden');
  }

  function bindAuth() {
    $('tab-login').addEventListener('click', () => switchAuthTab('login'));
    $('tab-register').addEventListener('click', () => switchAuthTab('register'));

    const submit = (formId, fn) =>
      $(formId).addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type=submit]');
        $('auth-error').classList.add('is-hidden');
        busy(btn, true);
        try {
          enter(await fn());
        } catch (err) {
          authError(err.message);
        } finally {
          busy(btn, false);
        }
      });
    const withKeys = (call, pwId) => async () => {
      const pw = $(pwId).value;
      const me = await call(pw);
      if (SECURE) await setupKeys(me, pw);
      return me;
    };
    submit('login-form', withKeys((pw) => Api.login($('login-username').value.trim(), pw, $('login-remember').checked), 'login-password'));
    submit('register-form', withKeys((pw) => Api.register($('register-username').value.trim(), pw, $('register-remember').checked), 'register-password'));

    $('guest-btn').addEventListener('click', async () => {
      const btn = $('guest-btn');
      busy(btn, true);
      $('auth-error').classList.add('is-hidden');
      try {
        enter(await Api.guest($('login-remember').checked));
      } catch (err) {
        authError(err.message);
      } finally {
        busy(btn, false);
      }
    });

    Api.hooks.start = () => $('pow-overlay').classList.remove('is-hidden');
    Api.hooks.end = () => $('pow-overlay').classList.add('is-hidden');
  }

  /* =====================================================================
   *  entering the app
   * ===================================================================== */
  function enter(me) {
    state.me = { id: me.id, username: me.username, role: me.role, uid: null };
    state.ready = false;
    state.rooms.clear();
    state.rooms.set(PUBLIC, makeRoom({ key: PUBLIC, type: 'public', name: 'public' }));
    state.current = PUBLIC;
    $('login-password').value = '';
    $('register-password').value = '';
    try { sessionStorage.setItem('zent_tab', '1'); } catch { /* ignore */ }

    $('me-name').textContent = me.username;
    $('me-role').textContent = me.role === 'guest' ? 'Guest · 24h' : 'Member';
    $('me-avatar').textContent = me.username.charAt(0);
    $('account-line').textContent = `Signed in as ${me.username}`;
    $('pw-form').classList.toggle('is-hidden', me.role !== 'registered');
    $('btn-logout-all').classList.toggle('is-hidden', me.role !== 'registered');
    $('profile-sec').classList.toggle('is-hidden', me.role !== 'registered');
    setRailAvatar(null);
    showInsecureNote();
    loadConfig();
    if (me.role === 'registered') loadMyProfile();
    if (!state.keys) loadKeys().then(() => updateHeader());

    Ui.swapScreen($('app'), $('auth-screen'));
    renderRooms();
    renderFriends();
    connectSocket();
    loadFriends();
    handleHash();
  }

  /* =====================================================================
   *  socket
   * ===================================================================== */
  function connectSocket() {
    Ui.setSignal('wait');
    Net.connect({
      onConnect() {
        Ui.setSignal('up');
        $('offline-banner').classList.add('is-hidden');
      },
      onDisconnect(reason) {
        Ui.setSignal(reason === 'io server disconnect' ? 'down' : 'wait');
        showBanner(reason === 'io server disconnect' ? 'The server closed your connection.' : 'Connection lost. Trying to reconnect…');
        updateComposer();
      },
      onConnectError(err) {
        if (err && err.message === 'Unauthorized') {
          Ui.toast('Your session ended. Please sign in again.', 'error');
          Net.disconnect();
          showAuth();
        } else {
          Ui.setSignal('down');
          showBanner(err && err.message === 'Too many connections' ? 'Too many connections from your network right now.' : "Can't reach the server. Retrying…");
        }
      },
      onIdle: () => showBanner('You were disconnected for being idle.'),
      onReady: onReady,
      onPresenceJoin: ({ room, username, uid }) => {
        // ignore our own join, which the server announces just before it tells us who we are
        if (!state.me.uid || uid === state.me.uid || !state.rooms.has(room)) return;
        Ui.addSystem(room, `${username} joined`);
      },
      onPresenceLeave: ({ room, username, uid }) => {
        if (uid !== state.me.uid && state.rooms.has(room)) Ui.addSystem(room, `${username} left`);
      },
      onCount: ({ room, count }) => {
        const r = state.rooms.get(room);
        if (!r) return;
        r.count = count;
        if (room === state.current) updateHeader();
        renderRooms();
      },
      onMessage: (m) => enqueue(m),
      onTyping: onTyping,
      onExpired: ({ room, reason }) => handleExpired(room, reason),
      onKicked: ({ room, reason }) => {
        Ui.toast(reason);
        removeRoomLocal(room);
      },
      onDmMessage: (m) => dmEnqueue(m),
      onDmTyping: ({ from, username }) => {
        const f = state.friends.find((x) => x.id === from);
        if (f) onTyping({ room: f.room, username, uid: 'f:' + from });
      },
      onDmCleared: ({ friend }) => {
        const f = state.friends.find((x) => x.id === friend);
        if (f && state.rooms.has(f.room)) removeRoomLocal(f.room);
      },
      onFriendsChanged: onFriendsChanged,
      onFriendPresence: ({ id, online }) => {
        presenceMark.set(id, ++presenceSeq);
        if (online) state.online.add(id); else state.online.delete(id);
        renderFriends();
        const cur = state.rooms.get(state.current);
        if (cur && cur.peerId === id) updateHeader();
      },
      onServerError: ({ message }) => Ui.toast(message, 'error'),
      onEdited: (e) => e && enqueueJob(e.room, () => applyEdit(e)),
      onDeleted: (e) => e && enqueueJob(e.room, () => applyDelete(e)),
      onDmEdited: (e) => e && dmJob(e.c, () => applyDmEdit(e)),
      onDmDeleted: (e) => e && dmJob(e.c, () => applyDmDelete(e)),
    });
  }

  function showBanner(text) {
    $('offline-text').textContent = text;
    $('offline-banner').classList.remove('is-hidden');
  }

  async function onReady(data) {
    state.me.uid = data.uid;
    state.history = data.publicHistory || { enabled: false, days: 0 };
    const first = !state.ready;
    state.ready = true;
    if (first) {
      switchTo(PUBLIC);
      await loadPublicHistory();
      if (!state.publicMsgs.length) {
        Ui.setEmpty(PUBLIC, [
          h('div', {}, h('b', { text: '# public' }), ' is open to everyone.'),
          h('div', { text: state.history.enabled ? 'Messages here are kept for a while.' : 'Messages here are not saved.' }),
        ]);
      }
      await restoreRooms();
      refreshOnline();
      syncDmUnread(); // also covers the friend list arriving before the connection
    } else {
      await rejoinAll();
      await syncPublicGap();
    }
  }

  /* ---- public room history (saved on the server; private chats never are) ---- */
  const toRow = (m) => ({ id: m.id, n: m.n, uid: m.uid, sender: m.sender, text: m.text, ts: m.ts, own: m.uid === state.me.uid, att: m.att, edited: m.edited });

  function renderPublic(keepScroll) {
    const el = Ui.getLog(PUBLIC).el;
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    Ui.renderBatch(PUBLIC, state.publicMsgs.map(toRow), { hour24: Settings.get('hour24'), hasMore: state.hasMore, onMore: loadOlder });
    if (keepScroll) el.scrollTop = prevTop + (el.scrollHeight - prevHeight); // stay on the same message
  }

  async function loadPublicHistory() {
    if (state.history.enabled) {
      const res = await Net.history({ room: PUBLIC, limit: 100 });
      if (res.ok && res.enabled && res.messages.length) {
        state.publicMsgs = res.messages.slice();
        for (const m of res.messages) state.publicSeen.add(m.id);
        state.hasMore = res.hasMore;
        renderPublic(false);
      }
    }
    state.historyReady = true;
    for (const m of state.pendingPublic.splice(0)) await handleMessage(m); // anything that arrived meanwhile
  }

  async function loadOlder(btn) {
    const oldest = state.publicMsgs.find((m) => Number.isFinite(m.n));
    if (!oldest) return;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    const res = await Net.history({ room: PUBLIC, before: oldest.n, limit: 100 });
    if (!res.ok || !res.enabled) {
      btn.disabled = false;
      btn.textContent = 'Load older messages';
      return Ui.toast(res.error || "Couldn't load older messages.", 'error');
    }
    const older = res.messages.filter((m) => !state.publicSeen.has(m.id));
    for (const m of older) state.publicSeen.add(m.id);
    state.publicMsgs = older.concat(state.publicMsgs);
    state.hasMore = res.hasMore;
    renderPublic(true);
  }

  /** After a dropped connection: fetch what we missed in the public room. */
  async function syncPublicGap() {
    if (!state.history.enabled) return;
    const res = await Net.history({ room: PUBLIC, limit: 100 });
    if (!res.ok || !res.enabled) return;
    const fresh = res.messages.filter((m) => !state.publicSeen.has(m.id));
    if (!fresh.length) return;
    for (const m of fresh) {
      state.publicSeen.add(m.id);
      state.publicMsgs.push(m);
      Ui.addMessage(PUBLIC, toRow(m), { hour24: Settings.get('hour24'), animate: false });
    }
    Ui.addSystem(PUBLIC, 'caught up on messages you missed');
  }

  async function rejoinAll() {
    for (const r of Array.from(state.rooms.values())) {
      if (r.type === 'code') {
        const res = await Net.join({ locator: r.key.slice(2), auth: r.auth });
        if (!res.ok) { removeRoomLocal(r.key); continue; }
        r.expiresAt = res.room.expiresAt;
      } else if (r.type === 'dm' && r.loaded) {
        await loadDmHistory(r);
      }
    }
    refreshOnline();
    syncDmUnread();
    renderRooms();
    updateHeader();
  }

  // live online/offline pushes that land while this request is in flight are newer than its answer,
  // so they win (otherwise a friend who just left could look online until the next change)
  let presenceSeq = 0;
  const presenceMark = new Map(); // friend id -> presenceSeq of their latest push
  async function refreshOnline() {
    const start = presenceSeq;
    const res = await Net.friendsOnline();
    if (res && Array.isArray(res.online)) {
      const next = new Set(res.online);
      for (const [fid, at] of presenceMark) if (at > start) { if (state.online.has(fid)) next.add(fid); else next.delete(fid); }
      state.online = next;
      renderFriends();
    }
  }

  /* =====================================================================
   *  rooms
   * ===================================================================== */
  function roomTitle(r) {
    if (r.type === 'dm') return r.peerName;
    if (r.type === 'p2p') return 'direct link';
    return r.name;
  }

  function switchTo(key) {
    const r = state.rooms.get(key);
    if (!r) return;
    if (state.editing && state.editing.key !== key) cancelEdit();
    closePops();
    state.current = key;
    r.unread = 0;
    Ui.showLog(key);
    Ui.setTyping(null);
    updateHeader();
    renderRooms();
    renderFriends();
    updateBadges();
    closeRail();
    if (!matchMedia('(max-width: 820px)').matches) $('composer-input').focus({ preventScroll: true });
  }

  function updateHeader() {
    const r = state.rooms.get(state.current);
    if (!r) return;
    const prefix = r.type === 'dm' ? '@' : r.type === 'p2p' ? '↔' : '#';
    $('room-prefix').textContent = prefix;
    $('room-title').textContent = roomTitle(r);
    $('room-count').textContent = r.type === 'dm' ? (state.online.has(r.peerId) ? 'online' : 'offline') : r.type === 'p2p' ? '' : r.count ? `${r.count} here` : '';
    $('room-share').classList.toggle('is-hidden', r.type !== 'code');
    $('room-leave').classList.toggle('is-hidden', r.type !== 'code');
    const showCode = r.type === 'dm' && r.safety;
    $('safety').classList.toggle('is-hidden', !showCode);
    $('safety').textContent = showCode ? r.safety : '';
    updateExpiryPill();
    updateComposer();

    if (r.type === 'public') {
      Ui.setMode('open', 'OPEN');
    } else if (r.type === 'code') {
      Ui.setMode('sealed', 'SEALED');
    } else if (r.type === 'dm') {
      if (state.keys && r.peerPub) Ui.setMode('sealed', 'SEALED'); else Ui.setMode('wait', 'LOCKED');
    } else {
      Ui.setMode('p2p', 'P2P');
    }
  }

  function updateComposer() {
    const r = state.rooms.get(state.current);
    const input = $('composer-input');
    let enabled = true;
    let ph = 'Say something…';
    let max = 1000;
    if (!r) enabled = false;
    else if (r.type === 'public') ph = state.history.enabled ? 'Message #public · saved' : 'Message #public';
    else if (r.type === 'code') { ph = `Message #${r.name}`; max = 1500; }
    else if (r.type === 'dm') {
      max = 1500;
      if (!state.keys) { enabled = false; ph = 'Messages are locked on this device'; }
      else if (!r.peerPub) { enabled = false; ph = `${r.peerName} hasn't set up messages yet`; }
      else ph = `Message @${r.peerName}`;
    } else if (r.type === 'p2p') { ph = 'Message'; max = 1500; }
    if (!Net.isConnected() && r && r.type !== 'p2p') { enabled = false; ph = 'Offline. Reconnecting…'; }
    input.disabled = !enabled;
    $('send-btn').disabled = !enabled;
    input.placeholder = ph;
    input.maxLength = max;
    const p2p = !!r && r.type === 'p2p';
    $('btn-emoji').disabled = !enabled;
    $('btn-gif').classList.toggle('is-hidden', !state.cfg.gifs || p2p);
    $('btn-gif').disabled = !enabled;
    $('btn-attach').classList.toggle('is-hidden', !state.cfg.uploads.enabled || p2p);
    $('btn-attach').disabled = !enabled || state.uploading;
    $('file-input').accept = r && r.type === 'public' ? 'image/png,image/jpeg,image/gif,image/webp' : '';
    if (!enabled) closePops();
  }

  function renderRooms() {
    const list = $('room-list');
    list.textContent = '';
    const rooms = Array.from(state.rooms.values()).filter((r) => r.type !== 'dm');
    rooms.sort((a, b) => (a.type === 'public' ? -1 : b.type === 'public' ? 1 : (a.expiresAt || 0) - (b.expiresAt || 0)));
    for (const r of rooms) {
      const sub = h('span', { class: 'item-sub', text: subText(r) });
      r._sub = sub;
      list.append(
        h(
          'li',
          { class: 'item' + (r.key === state.current ? ' is-active' : ''), role: 'button', tabindex: '0', on: { click: () => switchTo(r.key), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTo(r.key); } } } },
          h('span', { class: 'item-hash', text: r.type === 'p2p' ? '↔' : '#' }),
          h('span', { class: 'item-main' }, h('span', { class: 'item-name', text: roomTitle(r) }), sub),
          r.unread ? h('span', { class: 'badge', text: r.unread > 99 ? '99+' : String(r.unread) }) : null
        )
      );
    }
    updateBadges();
  }

  function subText(r) {
    if (r.type === 'public') return r.count ? `${r.count} online · open to all` : 'open to all';
    if (r.type === 'p2p') return 'peer to peer';
    const rem = r.expiresAt ? Ui.fmtRemaining(r.expiresAt - Date.now()) : '';
    return `${r.count || 1} here · burns in ${rem}`;
  }

  function updateBadges() {
    const rUnread = Array.from(state.rooms.values()).filter((r) => r.type !== 'dm').reduce((n, r) => n + r.unread, 0);
    const fUnread = Array.from(state.rooms.values()).filter((r) => r.type === 'dm').reduce((n, r) => n + r.unread, 0);
    const set = (id, n) => { $(id).textContent = n > 99 ? '99+' : String(n); $(id).classList.toggle('is-hidden', !n); };
    set('rooms-badge', rUnread);
    set('friends-badge', fUnread);
    const total = rUnread + fUnread;
    document.title = (total ? `(${total}) ` : '') + SITE_TITLE;
  }

  function removeRoomLocal(key) {
    const r = state.rooms.get(key);
    if (!r || r.key === PUBLIC) return;
    state.rooms.delete(key);
    Vault.forget(key);
    Ui.removeLog(key);
    if (r.type === 'code') persistRooms();
    if (state.current === key) switchTo(PUBLIC);
    else { renderRooms(); renderFriends(); }
  }

  async function handleExpired(key, reason) {
    const r = state.rooms.get(key);
    if (!r) return;
    Ui.toast(reason === 'empty' ? `“${r.name}” burned, everyone left.` : `“${r.name}” burned. Time's up.`);
    state.rooms.delete(key);
    Vault.forget(key);
    persistRooms();
    const wasCurrent = state.current === key;
    if (wasCurrent) Ui.addSystem(key, 'This room burned.', true);
    await Ui.burnLog(key);
    if (wasCurrent) switchTo(PUBLIC);
    else { renderRooms(); }
  }

  /* ---- remembering rooms on this device (only if the setting is on) ---- */
  function persistRooms() {
    try {
      if (!Settings.get('rememberRooms')) return localStorage.removeItem(ROOMS_KEY);
      const saved = Array.from(state.rooms.values())
        .filter((r) => r.type === 'code')
        .map((r) => ({ code: r.code, name: r.name, expiresAt: r.expiresAt }));
      if (saved.length) localStorage.setItem(ROOMS_KEY, JSON.stringify(saved));
      else localStorage.removeItem(ROOMS_KEY);
    } catch { /* storage blocked */ }
  }

  async function restoreRooms() {
    if (!Settings.get('rememberRooms')) return;
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(ROOMS_KEY) || '[]'); } catch { saved = []; }
    if (!Array.isArray(saved)) return;
    for (const s of saved.slice(0, 8)) {
      if (!s || typeof s.code !== 'string' || (s.expiresAt && s.expiresAt < Date.now())) continue;
      await joinByCode(s.code, { quiet: true });
    }
    persistRooms();
  }

  /* ---- joining with a code ---- */
  async function joinByCode(codeInput, { quiet = false } = {}) {
    const parsed = Vault.parseJoinCode(codeInput);
    if (!parsed) return { ok: false, error: "That code doesn't look right. It has 16 letters and numbers." };
    const key = `c:${parsed.locator}`;
    if (state.rooms.has(key)) { if (!quiet) switchTo(key); return { ok: true, room: state.rooms.get(key) }; }
    if (!SECURE) return { ok: false, error: NEED_HTTPS };
    let auth;
    try {
      ({ auth } = await Vault.deriveRoom(parsed.locator, parsed.secret));
    } catch {
      return { ok: false, error: "Couldn't open that room here." };
    }
    const res = await Net.join({ locator: parsed.locator, auth });
    if (!res.ok) { Vault.forget(key); return res; }
    const room = makeRoom({ key, type: 'code', name: res.room.name, code: parsed.normalized, auth, expiresAt: res.room.expiresAt, count: res.room.count });
    state.rooms.set(key, room);
    Ui.setEmpty(key, [h('div', {}, h('b', { text: room.name }))]);
    persistRooms();
    renderRooms();
    if (!quiet) switchTo(key);
    return { ok: true, room };
  }

  function bindRooms() {
    // tabs
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

    $('open-create').addEventListener('click', () => { if (!needsSecure()) openCreate(); });
    $('open-join').addEventListener('click', () => { if (needsSecure()) return; $('jn-error').classList.add('is-hidden'); Ui.openModal('dlg-join'); });
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => Ui.closeModal(b.closest('.modal').id)));
    document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m && m.id !== 'dlg-confirm') Ui.closeModal(m.id); }));

    // join form
    $('jn-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('jn-submit');
      busy(btn, true);
      $('jn-error').classList.add('is-hidden');
      try {
        const res = await joinByCode($('jn-code').value);
        if (res.ok) { Ui.closeModal('dlg-join'); $('jn-code').value = ''; }
        else { $('jn-error').textContent = res.error; $('jn-error').classList.remove('is-hidden'); }
      } finally { busy(btn, false); }
    });
    $('jn-code').addEventListener('input', () => { $('jn-error').classList.add('is-hidden'); });

    // create form
    $('cr-ttl').addEventListener('change', () => $('cr-custom').classList.toggle('is-hidden', $('cr-ttl').value !== 'custom'));
    $('cr-form').addEventListener('submit', onCreateSubmit);
    $('cr-copy-code').addEventListener('click', async () => Ui.toast((await Ui.copy(state.createdRoom.code)) ? 'Code copied.' : state.createdRoom.code));
    $('cr-copy-link').addEventListener('click', async () => {
      const link = `${location.origin}/#join=${state.createdRoom.code}`;
      Ui.toast((await Ui.copy(link)) ? 'Invite link copied.' : link);
    });
    $('cr-open').addEventListener('click', () => { Ui.closeModal('dlg-create'); switchTo(state.createdRoom.key); });

    $('room-share').addEventListener('click', () => {
      const r = state.rooms.get(state.current);
      if (r && r.type === 'code') showCreateResult(r, 'Share this room');
    });
    $('room-leave').addEventListener('click', async () => {
      const r = state.rooms.get(state.current);
      if (!r || r.type !== 'code') return;
      if (!(await Ui.confirmBox({ title: `Leave “${r.name}”?`, text: 'You can come back with the join code until the room burns.', ok: 'Leave' }))) return;
      await Net.leave(r.key);
      removeRoomLocal(r.key);
    });
  }

  function openCreate() {
    $('cr-form').classList.remove('is-hidden');
    $('cr-result').classList.add('is-hidden');
    $('cr-title').textContent = 'New room';
    $('cr-error').classList.add('is-hidden');
    Ui.openModal('dlg-create');
  }

  function ttlFromForm() {
    if ($('cr-ttl').value !== 'custom') return Number($('cr-ttl').value);
    const n = Math.max(1, Number($('cr-custom-num').value) || 0);
    return n * Number($('cr-custom-unit').value);
  }

  async function onCreateSubmit(e) {
    e.preventDefault();
    const btn = $('cr-submit');
    const err = (m) => { $('cr-error').textContent = m; $('cr-error').classList.remove('is-hidden'); };
    $('cr-error').classList.add('is-hidden');
    const name = $('cr-name').value.trim();
    if (!name) return err('Give the room a name.');
    const ttlMs = ttlFromForm();
    if (ttlMs < 5 * 60 * 1000) return err('Rooms last at least 5 minutes.');
    if (ttlMs > 7 * 24 * 3600 * 1000) return err('Rooms last at most 7 days.');
    if (!SECURE) return err(NEED_HTTPS);
    busy(btn, true);
    try {
      let res = null, parsed = null, auth = null;
      for (let attempt = 0; attempt < 6; attempt++) { // a locator can (rarely) collide; just roll a new code
        parsed = Vault.parseJoinCode(Vault.generateJoinCode());
        ({ auth } = await Vault.deriveRoom(parsed.locator, parsed.secret));
        res = await Net.create({ name, locator: parsed.locator, auth, ttlMs, burnWhenEmpty: $('cr-burn').checked });
        if (res.ok || res.error !== 'taken') break;
        Vault.forget(`c:${parsed.locator}`);
      }
      if (!res.ok) { Vault.forget(`c:${parsed.locator}`); return err(res.error === 'taken' ? 'Please try again.' : res.error); }
      const key = `c:${parsed.locator}`;
      const room = makeRoom({ key, type: 'code', name: res.room.name, code: parsed.normalized, auth, expiresAt: res.room.expiresAt, count: res.room.count });
      state.rooms.set(key, room);
      Ui.setEmpty(key, [h('div', {}, h('b', { text: room.name }), ' is ready.')]);
      persistRooms();
      renderRooms();
      $('cr-name').value = '';
      showCreateResult(room, 'Room created');
    } catch (e) {
      err((e && e.message) || "Couldn't create the room.");
    } finally {
      busy(btn, false);
    }
  }

  function showCreateResult(room, title) {
    state.createdRoom = room;
    $('cr-title').textContent = title;
    $('cr-code').textContent = room.code;
    $('cr-expires').textContent = `Deletes ${new Date(room.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`;
    $('cr-form').classList.add('is-hidden');
    $('cr-result').classList.remove('is-hidden');
    Ui.openModal('dlg-create');
  }

  /* ---- countdowns (once a second) ---- */
  function updateExpiryPill() {
    const r = state.rooms.get(state.current);
    const pill = $('expiry-pill');
    if (!r || !r.expiresAt) return pill.classList.add('is-hidden');
    const rem = r.expiresAt - Date.now();
    pill.classList.remove('is-hidden');
    pill.classList.toggle('is-urgent', rem < 60000);
    $('expiry-text').textContent = Ui.fmtRemaining(rem);
  }

  function tick() {
    const now = Date.now();
    for (const r of Array.from(state.rooms.values())) {
      if (r.type !== 'code' || !r.expiresAt) continue;
      if (r.expiresAt - now < -6000) { handleExpired(r.key, 'expired'); continue; } // the server normally tells us first
      if (r._sub) r._sub.textContent = subText(r);
    }
    updateExpiryPill();
  }

  /* =====================================================================
   *  friends
   * ===================================================================== */
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('is-active', p.id === `tab-${name}`));
    if (name === 'friends') loadMyCode();
  }

  async function loadMyCode() {
    try {
      const { friendCode, expiresAt } = await Api.friendCode();
      $('friend-code-text').textContent = friendCode;
      $('friend-code-expiry').textContent = expiresAt ? `Resets in ~${Math.max(1, Math.round((expiresAt - Date.now()) / 3600000))}h` : '';
    } catch { /* offline */ }
  }

  async function loadFriends() {
    loadMyCode();
    try {
      const { friends } = await Api.friends();
      state.friends = friends;
      for (const f of friends) {
        const r = state.rooms.get(f.room);
        if (!r) continue;
        r.peerName = f.username;
        if ((f.pub || null) !== r.peerPub) await peerKeyChanged(r, f.pub || null);
      }
    } catch { /* offline */ }
    renderFriends();
    syncDmUnread();
  }

  async function onFriendsChanged() {
    const before = new Set(state.friends.map((f) => f.id));
    await loadFriends();
    const gone = Array.from(before).filter((id) => !state.friends.some((f) => f.id === id));
    for (const id of gone) {
      const r = Array.from(state.rooms.values()).find((x) => x.type === 'dm' && x.peerId === id);
      if (r) removeRoomLocal(r.key);
    }
    const added = state.friends.filter((f) => !before.has(f.id) && !state.justAdded.has(f.id));
    if (added.length) Ui.toast(`${added[0].username} added you as a friend.`);
    if (state.friends.some((f) => !before.has(f.id))) refreshOnline();
  }

  function renderFriends() {
    const list = $('friend-list');
    list.textContent = '';
    $('friends-empty').classList.toggle('is-hidden', state.friends.length > 0);
    for (const f of state.friends) {
      const room = state.rooms.get(f.room);
      const unread = room ? room.unread : 0;
      list.append(
        h(
          'li',
          { class: 'item' + (f.room === state.current ? ' is-active' : ''), role: 'button', tabindex: '0', on: { click: () => openDm(f), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDm(f); } } } },
          h('span', { class: 'dot' + (state.online.has(f.id) ? ' is-on' : ''), title: state.online.has(f.id) ? 'online' : 'offline' }),
          h('span', { class: 'item-main' }, h('span', { class: 'item-name', text: f.username }), h('span', { class: 'item-sub', text: f.role === 'guest' ? 'guest' : state.online.has(f.id) ? 'online' : 'offline' })),
          unread ? h('span', { class: 'badge', text: unread > 99 ? '99+' : String(unread) }) : null,
          h('button', { class: 'item-x', type: 'button', 'aria-label': `Remove ${f.username}`, title: 'Remove friend', on: { click: (e) => { e.stopPropagation(); removeFriend(f); } } }, '✕')
        )
      );
    }
    updateBadges();
  }

  async function removeFriend(f) {
    if (!(await Ui.confirmBox({ title: `Remove ${f.username}?`, text: 'This also deletes your chat history with them.', ok: 'Remove' }))) return;
    try { await Api.removeFriend(f.id); Ui.toast(`${f.username} removed.`); } catch (e) { Ui.toast(e.message, 'error'); }
    await loadFriends();
    const r = state.rooms.get(f.room);
    if (r) removeRoomLocal(r.key);
  }

  function bindFriends() {
    $('add-friend-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('add-friend-input').value.trim();
      if (!code) return;
      try {
        const { friend } = await Api.addFriend(code);
        state.justAdded.add(friend.id);
        $('add-friend-input').value = '';
        Ui.toast(`You and ${friend.username} are friends now.`);
        await loadFriends();
        refreshOnline();
      } catch (err) {
        Ui.toast(err.message, 'error');
      }
    });
    $('copy-friend-code').addEventListener('click', async () => {
      const code = $('friend-code-text').textContent;
      Ui.toast((await Ui.copy(code)) ? 'Friend code copied.' : code);
    });
  }

  /* ---- friend messages: stored encrypted on the server, readable on any of your devices ---- */
  function dmRoomFor(f) {
    let r = state.rooms.get(f.room);
    if (!r) {
      r = makeRoom({ key: f.room, type: 'dm', name: f.username, peerId: f.id, peerName: f.username, peerPub: f.pub || null,
        safety: null, loaded: false, hasMore: false, msgs: [], seen: new Set(), plain: new Map(), lastRead: 0 });
      state.rooms.set(f.room, r);
    }
    return r;
  }

  // Signing in with a password unlocks the account key (or creates it the first time).
  async function setupKeys(me, password) {
    try {
      const { keys } = await Api.myKeys();
      let k;
      if (keys) {
        k = await Keys.unlock(password, keys);
      } else {
        const made = await Keys.create(password);
        await Api.setKeys(made.record);
        k = { priv: made.priv, pub: made.pub };
      }
      await Keys.remember(me.id, k);
      state.keys = k;
    } catch (e) {
      console.warn('message keys:', e.message);
    }
  }

  // Coming back with a saved session: use the key kept on this device.
  async function loadKeys() {
    if (!SECURE) return;
    state.keys = await Keys.recall(state.me.id);
    if (state.keys || state.me.role !== 'guest') return;
    try {
      const made = await Keys.createGuest();
      try {
        await Api.setKeys({ pub: made.pub });
      } catch {
        await Api.resetKeys(); // this browser lost the guest key: start over
        await Api.setKeys({ pub: made.pub });
      }
      await Keys.remember(state.me.id, made);
      state.keys = made;
    } catch { /* stays locked */ }
  }

  function askUnlock() {
    return new Promise((resolve) => {
      $('unlock-error').classList.add('is-hidden');
      $('unlock-password').value = '';
      state.unlockResolve = resolve;
      Ui.openModal('dlg-unlock');
    });
  }

  function bindUnlock() {
    $('dlg-unlock').addEventListener('modal:closed', () => {
      if (state.unlockResolve) { state.unlockResolve(!!state.keys); state.unlockResolve = null; }
    });
    $('unlock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      const fail = (msg) => { $('unlock-error').textContent = msg; $('unlock-error').classList.remove('is-hidden'); };
      busy(btn, true);
      try {
        const pw = $('unlock-password').value;
        const { keys } = await Api.myKeys();
        if (keys) {
          try { state.keys = await Keys.unlock(pw, keys); } catch { return fail('Wrong password.'); }
        } else {
          // older account with no key yet: confirm the password before locking a new key with it
          try { await Api.login(state.me.username, pw, true); } catch (err) { return fail(err.message); }
          const made = await Keys.create(pw);
          await Api.setKeys(made.record);
          state.keys = { priv: made.priv, pub: made.pub };
        }
        await Keys.remember(state.me.id, state.keys);
        Ui.closeModal('dlg-unlock');
      } catch (err) {
        fail(err.message || "Couldn't unlock.");
      } finally {
        busy(btn, false);
      }
    });
  }

  async function openDm(friend) {
    if (needsSecure()) return;
    if (!state.keys && state.me.role === 'registered' && !(await askUnlock())) return;
    if (!state.keys) return Ui.toast("Messages couldn't be set up on this device.", 'error');
    const room = dmRoomFor(friend);
    if ((friend.pub || null) !== room.peerPub || !room.safety) await peerKeyChanged(room, friend.pub || null);
    switchTo(room.key);
    if (!room.loaded) await loadDmHistory(room);
    markDmRead(room);
  }

  // New or changed public key for a friend: recompute the safety code and warn if it changed.
  async function peerKeyChanged(room, pub) {
    room.peerPub = pub;
    room.safety = pub && state.keys ? await Keys.safetyCode(state.keys.pub, pub) : null;
    room.plain.clear();
    if (pub) {
      let pins = {};
      try { pins = JSON.parse(localStorage.getItem('zent_pins') || '{}'); } catch { /* ignore */ }
      if (pins[room.peerId] && pins[room.peerId] !== pub) {
        Ui.addSystem(room.key, `${room.peerName}'s security code changed to ${room.safety}. Compare codes again.`, true);
      }
      pins[room.peerId] = pub;
      try { localStorage.setItem('zent_pins', JSON.stringify(pins)); } catch { /* ignore */ }
    }
    if (room.loaded) { room.loaded = false; room.msgs = []; room.seen.clear(); if (room.key === state.current) await loadDmHistory(room); }
    if (room.key === state.current) updateHeader();
  }

  const dmKey = (room) => (state.keys && room.peerPub ? Keys.convKey(state.keys.priv, state.keys.pub, room.peerPub, room.key) : null);

  async function decryptInto(room, list) {
    const key = await dmKey(room);
    for (const m of list) {
      if (room.plain.has(m.id)) continue;
      const own = m.f === state.me.id;
      let text, att;
      let failed = false;
      try { ({ text, att } = unpack(await Keys.open(key, room.key, m.f, m.id, m.iv, m.ct))); } catch { failed = true; text = 'Could not decrypt this message.'; att = undefined; }
      room.plain.set(m.id, { id: m.id, uid: own ? state.me.uid : 'f:' + room.peerId, sender: own ? state.me.username : room.peerName, text, ts: m.ts, own, failed, edited: m.e || undefined, att });
    }
  }

  function drawDm(room, keepScroll) {
    const el = Ui.getLog(room.key).el;
    const prevHeight = el.scrollHeight;
    const prevTop = el.scrollTop;
    Ui.renderBatch(room.key, room.msgs.map((m) => room.plain.get(m.id)), { hour24: Settings.get('hour24'), hasMore: room.hasMore, onMore: () => loadDmHistory(room, true) });
    if (!room.msgs.length) Ui.setEmpty(room.key, [h('div', {}, h('b', { text: room.peerName }))]);
    if (keepScroll) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
  }

  async function loadDmHistory(room, older = false) {
    const res = await Net.dmHistory({ friend: room.peerId, before: older && room.msgs.length ? room.msgs[0].n : undefined, limit: 50 });
    if (!res.ok) { Ui.toast(res.error || "Couldn't load messages.", 'error'); return; }
    const fresh = res.messages.filter((m) => !room.seen.has(m.id));
    fresh.forEach((m) => room.seen.add(m.id));
    await decryptInto(room, fresh);
    room.msgs = room.msgs.concat(fresh).sort((x, y) => x.n - y.n);
    if (older || !room.loaded) room.hasMore = res.hasMore;
    room.loaded = true;
    drawDm(room, older);
  }

  function markDmRead(room) {
    const last = room.msgs.length ? room.msgs[room.msgs.length - 1].n : 0;
    if (last > room.lastRead) { room.lastRead = last; Net.dmRead({ friend: room.peerId, n: last }); }
    if (room.unread) { room.unread = 0; renderFriends(); }
  }

  async function syncDmUnread() {
    if (!state.friends.length || !Net.isConnected()) return;
    const res = await Net.dmUnread();
    if (!res.ok) return;
    for (const f of state.friends) {
      const n = res.counts[f.id] || 0;
      const room = state.rooms.get(f.room);
      if (room && room.key === state.current && !document.hidden) continue;
      if (n) dmRoomFor(f).unread = n;
      else if (room) room.unread = 0;
    }
    renderFriends();
  }

  const dmQueues = new Map();
  function dmEnqueue(m) {
    const prev = dmQueues.get(m.c) || Promise.resolve();
    dmQueues.set(m.c, prev.then(() => onDmMessage(m)).catch(() => {}));
  }

  async function onDmMessage(m) {
    const peer = m.f === state.me.id ? m.c.slice(3).split(':').find((x) => x !== state.me.id) : m.f;
    const f = state.friends.find((x) => x.id === peer);
    if (!f) return;
    const room = dmRoomFor(f);
    const own = m.f === state.me.id;
    if (!room.loaded) { // chat not open on this device yet: just count it
      if (!own) { room.unread += 1; renderFriends(); if (Settings.get('sound')) playTick(); }
      return;
    }
    if (room.seen.has(m.id)) return;
    room.seen.add(m.id);
    await decryptInto(room, [m]);
    room.msgs.push(m);
    const row = room.plain.get(m.id);
    const nodes = Ui.addMessage(room.key, row, { hour24: Settings.get('hour24') });
    clearTyping(room.key, 'f:' + room.peerId);
    if (own) return;
    const looking = room.key === state.current && !document.hidden;
    if (looking) markDmRead(room);
    else { room.unread += 1; renderFriends(); if (Settings.get('sound')) playTick(); }
    if (!row.failed && row.text && Settings.get('translate')) translateInto(nodes, row.text);
  }

  function dmJob(c, fn) {
    if (typeof c !== 'string') return;
    const prev = dmQueues.get(c) || Promise.resolve();
    dmQueues.set(c, prev.then(fn).catch(() => {}));
  }

  async function applyDmEdit({ c, id, f, iv, ct, e }) {
    const room = state.rooms.get(c);
    if (!room || room.type !== 'dm' || !room.loaded) return;
    const m = room.msgs.find((x) => x.id === id);
    if (!m || m.f !== f) return; // only the person who wrote it
    m.iv = iv; m.ct = ct; m.e = e;
    room.plain.delete(id);
    await decryptInto(room, [m]);
    const row = room.plain.get(id);
    Ui.updateMessage(c, id, { text: row.text });
  }

  function applyDmDelete({ c, id }) {
    const room = state.rooms.get(c);
    if (!room || room.type !== 'dm') return;
    room.msgs = room.msgs.filter((x) => x.id !== id);
    room.plain.delete(id);
    Ui.removeMessage(c, id);
    if (state.editing && state.editing.id === id) cancelEdit();
  }

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));

  /* =====================================================================
   *  messages
   * ===================================================================== */
  const queues = new Map();
  function enqueueJob(room, fn) {
    if (typeof room !== 'string') return;
    const prev = queues.get(room) || Promise.resolve();
    queues.set(room, prev.then(fn).catch(() => {}));
  }
  const enqueue = (msg) => enqueueJob(msg.room, () => handleMessage(msg));

  async function handleMessage(msg) {
    const room = state.rooms.get(msg.room);
    if (!room) return;
    if (msg.room === PUBLIC) {
      if (!state.historyReady) { state.pendingPublic.push(msg); return; } // wait for history so order is right
      if (state.publicSeen.has(msg.id)) return;
      state.publicSeen.add(msg.id);
      state.publicMsgs.push({ id: msg.id, n: msg.n, uid: msg.uid, sender: msg.sender, text: msg.text, ts: msg.ts, att: cleanAtt(msg.att) });
      if (state.publicMsgs.length > 3000) state.publicMsgs.shift();
    }
    room.owners.set(msg.id, msg.uid);
    if (room.owners.size > 3000) room.owners.delete(room.owners.keys().next().value);
    const own = msg.uid === state.me.uid;
    let text = msg.text;
    let att = cleanAtt(msg.att);
    let failed = false;
    if (room.type !== 'public') {
      const plain = await Vault.open(room.key, msg.ciphertext, msg.iv);
      if (plain === null) { failed = true; text = 'Could not decrypt this message.'; att = undefined; }
      else ({ text, att } = unpack(plain));
    }
    const nodes = Ui.addMessage(room.key, { id: msg.id, uid: msg.uid, sender: msg.sender, text, ts: msg.ts, own, failed, att }, { hour24: Settings.get('hour24') });
    clearTyping(room.key, msg.uid);

    if (!own) {
      const looking = room.key === state.current && !document.hidden;
      if (!looking) { room.unread += 1; room.type === 'dm' ? renderFriends() : renderRooms(); }
      if (Settings.get('sound') && !looking) playTick();
      if (!failed && text && Settings.get('translate')) translateInto(nodes, text);
    }
  }

  /* ---- edits and deletes from other people (and my other tabs) ---- */
  async function applyEdit({ room: key, id, uid, text, ciphertext, iv, edited }) {
    const room = state.rooms.get(key);
    if (!room || typeof id !== 'string') return;
    const owner = room.owners.get(id);
    if (owner && owner !== uid) return; // not theirs to change
    if (room.type === 'public') {
      const rec = state.publicMsgs.find((m) => m.id === id);
      if (rec) { if (rec.uid !== uid) return; rec.text = text; rec.edited = edited; }
      else if (!owner && !state.history.enabled) return; // nothing to check it against
      Ui.updateMessage(PUBLIC, id, { text });
    } else {
      if (!owner) return; // sealed rooms: only messages we saw arrive
      const plain = await Vault.open(key, ciphertext, iv);
      if (plain === null) return;
      Ui.updateMessage(key, id, { text: unpack(plain).text });
    }
  }

  function applyDelete({ room: key, id, uid }) {
    const room = state.rooms.get(key);
    if (!room || typeof id !== 'string') return;
    const owner = room.owners.get(id);
    if (owner && owner !== uid) return;
    if (room.type === 'public') {
      const i = state.publicMsgs.findIndex((m) => m.id === id);
      if (i >= 0) { if (state.publicMsgs[i].uid !== uid) return; state.publicMsgs.splice(i, 1); }
      else if (!owner && !state.history.enabled) return;
    } else if (!owner) return;
    room.owners.delete(id);
    Ui.removeMessage(key, id);
    if (state.editing && state.editing.id === id) cancelEdit();
  }

  async function translateInto(nodes, original) {
    const target = Settings.get('translateTo');
    const r = await Translate.run(original, target);
    const label = (from) => Translate.label(from);
    if (r.status === 'ok') {
      showTranslated(nodes, original, r.text, r.from);
    } else if (r.status === 'needs-download') {
      nodes.row.append(
        h('div', { class: 'msg-tr' }, h('span', { text: `${label(r.from)} → ${label(target)}` }),
          h('button', { type: 'button', text: 'Translate (downloads a small language pack)', on: { click: async (e) => {
            e.target.disabled = true;
            const rr = await Translate.run(original, target, { gesture: true });
            e.target.closest('.msg-tr').remove();
            if (rr.status === 'ok') showTranslated(nodes, original, rr.text, rr.from);
            else Ui.toast("Couldn't translate that one.", 'error');
          } } }))
      );
    }
  }

  function showTranslated(nodes, original, translated, from) {
    let shown = true;
    nodes.body.textContent = translated;
    const btn = h('button', { type: 'button', text: 'show original' });
    const bar = h('div', { class: 'msg-tr' }, h('span', { text: `translated from ${Translate.label(from)}` }), btn);
    btn.addEventListener('click', () => {
      shown = !shown;
      nodes.body.textContent = shown ? translated : original;
      btn.textContent = shown ? 'show original' : 'show translation';
    });
    nodes.row.append(bar);
  }

  /* ---- sending ---- */
  async function send() {
    if (state.sending) return;
    if (state.editing) return saveEdit();
    const r = state.rooms.get(state.current);
    const input = $('composer-input');
    const text = input.value.replace(/\s+/g, ' ').trim();
    if (!r || !text) return;
    state.sending = true;
    try {
      if (r.type === 'p2p') {
        await PeerSession.sendMessage(text);
        Ui.addMessage(P2P, { uid: state.me.uid, sender: 'you', text, ts: Date.now(), own: true, plainName: true }, { hour24: Settings.get('hour24') });
        input.value = '';
        return;
      }
      let res;
      if (r.type === 'public') {
        res = await Net.send({ room: PUBLIC, text });
      } else if (r.type === 'dm') {
        const key = await dmKey(r);
        if (!key) return Ui.toast(state.keys ? `${r.peerName} hasn't set up messages yet.` : 'Messages are locked on this device.', 'error');
        const id = newId();
        res = await Net.dmSend({ to: r.peerId, id, ...(await Keys.seal(key, r.key, state.me.id, id, text)) });
      } else {
        if (!Vault.isReady(r.key)) return Ui.toast('This chat is not unlocked yet.', 'error');
        res = await Net.send({ room: r.key, ...(await Vault.seal(r.key, text)) });
      }
      if (res.ok) input.value = '';
      else Ui.toast(res.error || "Couldn't send that.", 'error');
    } catch (e) {
      Ui.toast(e.message || "Couldn't send that.", 'error');
    } finally {
      state.sending = false;
      if (!matchMedia('(max-width: 820px)').matches) input.focus({ preventScroll: true });
    }
  }

  /* =====================================================================
   *  editing + deleting your own messages
   * ===================================================================== */
  function startEdit(key, id) {
    const m = Ui.getMessage(key, id);
    if (!m || !m.own) return;
    if (key !== state.current) switchTo(key);
    closePops();
    state.editing = { key, id, att: m.att };
    markEditing(key, id);
    const input = $('composer-input');
    input.value = m.text || '';
    $('edit-bar').classList.remove('is-hidden');
    input.focus({ preventScroll: true });
    try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* not supported */ }
  }

  function markEditing(key, id) {
    document.querySelectorAll('.msg.is-editing').forEach((r) => r.classList.remove('is-editing'));
    // room keys and message ids are letters/digits/colons/hyphens only, so no escaping needed inside the quotes
    const log = key && document.querySelector(`.log[data-room="${key}"]`);
    const row = log && id && log.querySelector(`.msg[data-id="${id}"]`);
    if (row) row.classList.add('is-editing');
  }

  function cancelEdit() {
    if (!state.editing) return;
    state.editing = null;
    markEditing(null, null);
    $('composer-input').value = '';
    $('edit-bar').classList.add('is-hidden');
  }

  async function saveEdit() {
    const ed = state.editing;
    const r = state.rooms.get(ed.key);
    const m = Ui.getMessage(ed.key, ed.id);
    const text = $('composer-input').value.replace(/\s+/g, ' ').trim();
    if (!r || !m) return cancelEdit();
    if (text === (m.text || '')) return cancelEdit(); // nothing changed
    if (!text && !ed.att) return Ui.toast("A message can't be empty. Delete it instead.", 'error');
    state.sending = true;
    try {
      let res;
      if (r.type === 'public') {
        res = await Net.editMsg({ room: PUBLIC, id: ed.id, text });
      } else if (r.type === 'code') {
        res = await Net.editMsg({ room: r.key, id: ed.id, ...(await Vault.seal(r.key, pack(text, ed.att))) });
      } else if (r.type === 'dm') {
        const key = await dmKey(r);
        if (!key) return Ui.toast('Messages are locked on this device.', 'error');
        res = await Net.dmEdit({ to: r.peerId, id: ed.id, ...(await Keys.seal(key, r.key, state.me.id, ed.id, pack(text, ed.att))) });
      } else return cancelEdit();
      if (res.ok) cancelEdit();
      else Ui.toast(res.error || "Couldn't save that edit.", 'error');
    } catch (e) {
      Ui.toast(e.message || "Couldn't save that edit.", 'error');
    } finally {
      state.sending = false;
    }
  }

  async function deleteMsg(key, id) {
    const r = state.rooms.get(key);
    const m = Ui.getMessage(key, id);
    if (!r || !m || !m.own) return;
    if (!(await Ui.confirmBox({ title: 'Delete this message?', text: r.type === 'code' ? 'It disappears for everyone in the room.' : "It's removed for everyone and deleted from the server.", ok: 'Delete' }))) return;
    const files = m.att && m.att.t === 'file' ? [m.att.id] : [];
    let res;
    if (r.type === 'dm') res = await Net.dmDelete({ to: r.peerId, id, files });
    else res = await Net.deleteMsg({ room: key, id, files });
    if (!res.ok) Ui.toast(res.error || "Couldn't delete that.", 'error');
  }

  /* =====================================================================
   *  attachments: pictures, GIFs, files
   * ===================================================================== */
  const BIG_IMAGE = 15 * 1024 * 1024; // bigger encrypted pictures show as a download instead of loading by themselves

  function mediaBox(att, label) {
    const box = h('div', { class: 'msg-att att-media' + (att.w && att.h ? '' : ' no-size') });
    if (att.w && att.h) { box.style.setProperty('--ar', `${att.w} / ${att.h}`); box.style.setProperty('--w', `${Math.max(att.w, 48)}px`); }
    const img = h('img', { class: 'att-img', alt: label, decoding: 'async', loading: 'lazy' });
    if (att.w && att.h) { img.width = att.w; img.height = att.h; }
    img.addEventListener('error', () => { box.textContent = ''; box.classList.add('is-gone'); box.append(h('span', { text: 'This picture is gone.' })); });
    box.append(img);
    box.addEventListener('click', () => { if (img.src && !box.classList.contains('is-gone')) openMedia(img.src, att); });
    return { box, img };
  }

  function fileCard(att) {
    const btn = h('button', { class: 'btn btn-sm-plain', type: 'button', text: 'Download' });
    const card = h('div', { class: 'msg-att att-file' },
      h('span', { class: 'att-file-ico', 'aria-hidden': 'true', text: (att.name.split('.').pop() || 'file').slice(0, 4).toUpperCase() }),
      h('span', { class: 'att-file-main' }, h('span', { class: 'att-file-name', text: att.name }), h('span', { class: 'att-file-size', text: Ui.fmtSize(att.size) + ' · encrypted' })),
      btn);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Opening…';
      try { await Attach.save(att); btn.textContent = 'Download'; } catch (e) { Ui.toast(e.message || "Couldn't open that file.", 'error'); btn.textContent = e.gone ? 'Gone' : 'Download'; }
      btn.disabled = !!(btn.textContent === 'Gone');
    });
    return card;
  }

  function renderAtt(key, m) {
    const att = m.att;
    if (!att) return null;
    if (att.t === 'gif') { const { box, img } = mediaBox(att, 'GIF'); img.src = `/gif/${att.id}.gif`; box.classList.add('is-gif'); return box; }
    if (att.t === 'img') { const { box, img } = mediaBox(att, 'Picture'); img.src = `/files/${att.id}`; return box; }
    if (att.t !== 'file') return null;
    if (!Attach.isImage(att.mime) || att.size > BIG_IMAGE) return fileCard(att);
    const { box, img } = mediaBox(att, att.name);
    box.classList.add('is-loading');
    Attach.openUrl(att).then((url) => { img.src = url; box.classList.remove('is-loading'); }).catch((e) => {
      box.classList.remove('is-loading');
      box.classList.add('is-gone');
      box.textContent = '';
      box.append(h('span', { text: e.gone ? 'This picture is gone.' : "Couldn't open this picture." }));
    });
    return box;
  }

  let mediaAtt = null;
  function openMedia(src, att) {
    mediaAtt = att;
    $('media-img').src = src;
    $('media-img').alt = att && att.name ? att.name : 'Picture';
    Ui.openModal('dlg-media');
  }

  async function saveMedia() {
    const att = mediaAtt;
    if (!att) return;
    try {
      if (att.t === 'file') return await Attach.save(att);
      const a = h('a', { href: $('media-img').src, download: att.t === 'gif' ? `${att.id}.gif` : 'picture' });
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) { Ui.toast(e.message || "Couldn't save that.", 'error'); }
  }

  function setUploading(on, text) {
    state.uploading = on;
    $('upload-bar').classList.toggle('is-hidden', !on);
    if (text) $('upload-text').textContent = text;
    updateComposer();
  }

  /** sends one file into the room you're looking at (whatever's typed goes along as a caption) */
  async function sendFile(file) {
    const r = state.rooms.get(state.current);
    if (!r || !file || state.uploading) return;
    const up = state.cfg.uploads;
    if (r.type === 'p2p') return Ui.toast("Files can't go over a direct link yet.", 'error');
    if (!up.enabled) return Ui.toast('File sharing is turned off on this server.', 'error');
    if (r.type === 'public') {
      if (up.publicUploads === 'off') return Ui.toast('Pictures are turned off in #public.', 'error');
      if (up.publicUploads === 'members' && state.me.role !== 'registered') return Ui.toast('Make an account to post pictures in #public. Guests can share files in private rooms.', 'error');
      if (!Attach.isImage(file.type)) return Ui.toast('Only pictures can go in #public. Share other files in a private room or with a friend.', 'error');
    }
    if (r.type === 'dm' && !(await dmKey(r))) return Ui.toast(state.keys ? `${r.peerName} hasn't set up messages yet.` : 'Messages are locked on this device.', 'error');
    if (r.type === 'code' && !Vault.isReady(r.key)) return Ui.toast('This chat is not unlocked yet.', 'error');
    if (file.size > up.maxBytes * 3) return Ui.toast(`Files can be up to ${Ui.fmtSize(up.maxBytes)}.`, 'error');
    if (state.editing) cancelEdit();

    const input = $('composer-input');
    const caption = input.value.replace(/\s+/g, ' ').trim();
    setUploading(true, `Uploading ${Attach.cleanName(file.name)}…`);
    try {
      const prep = Attach.isImage(file.type) ? await Attach.prepImage(file) : { blob: file, w: 0, h: 0, mime: file.type || 'application/octet-stream' };
      if (prep.blob.size > up.maxBytes) throw new Error(`That's ${Ui.fmtSize(prep.blob.size)}. Files can be up to ${Ui.fmtSize(up.maxBytes)}.`);
      let res;
      if (r.type === 'public') {
        const u = await Attach.upload(prep.blob, 'public');
        res = await Net.send({ room: PUBLIC, text: caption, att: { t: 'img', id: u.id, w: prep.w, h: prep.h } });
      } else {
        const enc = await Attach.encrypt(await Attach.bytesOf(prep.blob));
        const u = await Attach.upload(enc.data, r.type === 'dm' ? 'dm' : 'room', r.type === 'dm' ? r.peerId : r.key);
        const att = { t: 'file', id: u.id, key: enc.key, iv: enc.iv, name: Attach.cleanName(file.name), mime: prep.mime || 'application/octet-stream', size: prep.blob.size, w: prep.w, h: prep.h };
        if (r.type === 'dm') {
          const key = await dmKey(r);
          const id = newId();
          res = await Net.dmSend({ to: r.peerId, id, ...(await Keys.seal(key, r.key, state.me.id, id, pack(caption, att))) });
        } else {
          res = await Net.send({ room: r.key, ...(await Vault.seal(r.key, pack(caption, att))) });
        }
      }
      if (!res.ok) throw new Error(res.error || "Couldn't send that.");
      if (caption && input.value.replace(/\s+/g, ' ').trim() === caption) input.value = '';
    } catch (e) {
      Ui.toast(e.message || "Couldn't send that file.", 'error');
    } finally {
      setUploading(false);
    }
  }

  async function sendGif(g) {
    const r = state.rooms.get(state.current);
    if (!r || r.type === 'p2p') return;
    closePops();
    const att = { t: 'gif', id: g.id, w: g.w, h: g.h };
    try {
      let res;
      if (r.type === 'public') res = await Net.send({ room: PUBLIC, att });
      else if (r.type === 'code') res = await Net.send({ room: r.key, ...(await Vault.seal(r.key, pack('', att))) });
      else {
        const key = await dmKey(r);
        if (!key) return Ui.toast('Messages are locked on this device.', 'error');
        const id = newId();
        res = await Net.dmSend({ to: r.peerId, id, ...(await Keys.seal(key, r.key, state.me.id, id, pack('', att))) });
      }
      if (!res.ok) Ui.toast(res.error || "Couldn't send that GIF.", 'error');
    } catch (e) { Ui.toast(e.message || "Couldn't send that GIF.", 'error'); }
  }

  /* ---- pickers ---- */
  function closePops() {
    for (const [pop, btn] of [['emoji-pop', 'btn-emoji'], ['gif-pop', 'btn-gif']]) {
      $(pop).classList.add('is-hidden');
      $(btn).setAttribute('aria-expanded', 'false');
    }
  }
  function togglePop(pop, btn, onOpen) {
    const opening = $(pop).classList.contains('is-hidden');
    closePops();
    if (!opening) return;
    $(pop).classList.remove('is-hidden');
    $(btn).setAttribute('aria-expanded', 'true');
    if (onOpen) onOpen();
  }

  function insertAtCursor(text) {
    const input = $('composer-input');
    const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : input.value.length;
    if (input.value.length - (end - start) + text.length > input.maxLength) return;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const pos = start + text.length;
    try { input.setSelectionRange(pos, pos); } catch { /* fine */ }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  let gifTimer = null, gifSeq = 0;
  async function loadGifs(q) {
    const grid = $('gif-grid');
    const seq = ++gifSeq;
    grid.textContent = '';
    grid.append(h('p', { class: 'gif-note', text: 'Loading…' }));
    let res;
    try { res = await Api.gifSearch(q); } catch (e) { if (seq === gifSeq) { grid.textContent = ''; grid.append(h('p', { class: 'gif-note', text: e.message })); } return; }
    if (seq !== gifSeq) return; // a newer search already started
    grid.textContent = '';
    if (!res.results.length) grid.append(h('p', { class: 'gif-note', text: q ? `No GIFs for “${q}”.` : 'Nothing here right now.' }));
    for (const g of res.results) {
      const b = h('button', { type: 'button', class: 'gif-pick', title: g.title || 'GIF', 'aria-label': g.title || 'GIF', on: { click: () => sendGif(g) } });
      if (g.w && g.h) b.style.setProperty('--ar', `${g.w} / ${g.h}`);
      b.append(h('img', { src: `/gif/${g.id}.gif`, alt: '', loading: 'lazy', decoding: 'async' }));
      grid.append(b);
    }
  }

  function bindTools() {
    Ui.hooks.action = (key, id, what) => (what === 'edit' ? startEdit(key, id) : deleteMsg(key, id));
    Ui.hooks.name = (m) => openProfile(m.own ? state.me.username : m.sender);
    Ui.hooks.att = renderAtt;

    $('edit-cancel').addEventListener('click', cancelEdit);
    $('media-save').addEventListener('click', saveMedia);
    $('dlg-media').addEventListener('modal:closed', () => { $('media-img').removeAttribute('src'); mediaAtt = null; });

    let emojiBuilt = false;
    $('btn-emoji').addEventListener('click', () => togglePop('emoji-pop', 'btn-emoji', () => {
      if (!emojiBuilt) { Emoji.build($('emoji-pop'), (e) => insertAtCursor(e)); emojiBuilt = true; }
    }));
    $('btn-gif').addEventListener('click', () => togglePop('gif-pop', 'btn-gif', () => {
      $('gif-search').value = '';
      loadGifs('');
      setTimeout(() => $('gif-search').focus({ preventScroll: true }), 30);
    }));
    $('gif-search').addEventListener('input', () => {
      clearTimeout(gifTimer);
      gifTimer = setTimeout(() => loadGifs($('gif-search').value.trim()), 380);
    });
    $('btn-attach').addEventListener('click', () => { closePops(); $('file-input').value = ''; $('file-input').click(); });
    $('file-input').addEventListener('change', () => { const f = $('file-input').files && $('file-input').files[0]; if (f) sendFile(f); });

    // paste a screenshot straight into the message box
    $('composer-input').addEventListener('paste', (e) => {
      const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
      if (f && !$('btn-attach').disabled && !$('btn-attach').classList.contains('is-hidden')) { e.preventDefault(); sendFile(f); }
    });
    // drag a file onto the chat
    const stage = document.querySelector('.stage');
    stage.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); stage.classList.add('is-drop'); } });
    stage.addEventListener('dragleave', (e) => { if (e.target === stage || !stage.contains(e.relatedTarget)) stage.classList.remove('is-drop'); });
    stage.addEventListener('drop', (e) => {
      stage.classList.remove('is-drop');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      if ($('composer-input').disabled) return Ui.toast("You can't send here right now.", 'error');
      sendFile(f);
    });

    // close pickers when you click somewhere else
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.pop, #btn-emoji, #btn-gif')) return;
      closePops();
    });

    // up arrow in an empty box = fix your last message; Esc = stop editing
    $('composer-input').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' && !e.target.value && !state.editing) {
        const m = Ui.lastOwn(state.current);
        if (m) { e.preventDefault(); startEdit(state.current, m.id); }
      } else if (e.key === 'Escape' && state.editing) {
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
      }
    });
  }

  async function loadConfig() {
    try {
      const c = await Api.config();
      state.cfg = { gifs: !!c.gifs, uploads: { ...state.cfg.uploads, ...(c.uploads || {}) } };
      Attach.setConfig(state.cfg.uploads);
    } catch { /* offline: keep the defaults */ }
    updateComposer();
  }

  /* =====================================================================
   *  profiles
   * ===================================================================== */
  const okLink = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const sinceText = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(ym || ''); return m ? `Member since ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };

  function avatarInto(el, url, name) {
    el.textContent = '';
    if (url) el.append(h('img', { src: url, alt: '', decoding: 'async' }));
    else el.textContent = String(name || '?').charAt(0);
  }

  function setRailAvatar(url) {
    avatarInto($('me-avatar'), url, state.me ? state.me.username : '?');
    $('me-avatar').classList.toggle('has-img', !!url);
  }

  async function openProfile(name) {
    if (!name) return;
    const card = document.querySelector('.pf-card');
    card.classList.remove('is-guest');
    card.style.removeProperty('--pf-accent');
    card.style.removeProperty('--pf-bg');
    $('pf-banner').textContent = '';
    avatarInto($('pf-avatar'), null, name);
    $('pf-name').textContent = name;
    $('pf-handle').textContent = '';
    $('pf-status').classList.add('is-hidden');
    $('pf-bio').textContent = 'Loading…';
    $('pf-links').textContent = '';
    $('pf-meta').textContent = '';
    $('pf-page').classList.add('is-hidden');
    Ui.openModal('dlg-profile');
    let p;
    try {
      ({ profile: p } = await Api.profile(name));
    } catch (e) {
      card.classList.add('is-guest');
      $('pf-bio').textContent = e.message || "Couldn't load that profile.";
      return;
    }
    if (p.accent) card.style.setProperty('--pf-accent', p.accent);
    if (p.bg) card.style.setProperty('--pf-bg', p.bg);
    card.style.setProperty('--pf-ink', Themes.inkOn ? Themes.inkOn(p.bg || '#161513') : '#fff');
    card.style.setProperty('--pf-accent-ink', Themes.inkOn ? Themes.inkOn(p.accent || '#e2b45c') : '#000');
    if (p.banner) $('pf-banner').append(h('img', { src: p.banner, alt: '', decoding: 'async' }));
    avatarInto($('pf-avatar'), p.avatar, p.username);
    $('pf-name').textContent = p.displayName || p.username;
    $('pf-handle').textContent = '@' + p.username + (p.pronouns ? `   ${p.pronouns}` : '');
    if (p.status) { $('pf-status').textContent = p.status; $('pf-status').classList.remove('is-hidden'); }
    $('pf-bio').textContent = p.bio || '';
    for (const l of p.links || []) {
      if (okLink(l.url)) $('pf-links').append(h('a', { class: 'pf-link', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: l.label }));
    }
    $('pf-meta').textContent = sinceText(p.memberSince);
    $('pf-page').href = '/u/' + encodeURIComponent(p.username);
    $('pf-page').classList.remove('is-hidden');
  }

  /* ---- my profile editor (Settings > Profile) ---- */
  const draft = { avatar: null, banner: null };
  let picFor = 'avatar';

  function linkRow(l = { label: '', url: '' }) {
    const row = h('div', { class: 'prof-link' },
      h('input', { type: 'text', class: 'prof-link-label', maxlength: '24', placeholder: 'Label', 'aria-label': 'Link label', value: l.label }),
      h('input', { type: 'text', class: 'prof-link-url', maxlength: '300', placeholder: 'https://…', 'aria-label': 'Link address', value: l.url, inputmode: 'url', autocapitalize: 'none', spellcheck: 'false' }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove link', text: '✕', on: { click: () => { row.remove(); linkAddState(); } } }));
    return row;
  }
  const linkAddState = () => { $('prof-link-add').disabled = $('prof-links').children.length >= 6; };

  function fillEditor(p) {
    state.profile = p;
    draft.avatar = p.avatarId || null;
    draft.banner = p.bannerId || null;
    $('prof-display').value = p.displayName || '';
    $('prof-status').value = p.status || '';
    $('prof-pronouns').value = p.pronouns || '';
    $('prof-bio').value = p.bio || '';
    $('prof-bio-count').textContent = `${Array.from($('prof-bio').value).length} / 300`;
    $('prof-accent').value = p.accent || '#e2b45c';
    $('prof-bg').value = p.bg || '#161513';
    $('prof-public').checked = !!p.public;
    $('prof-links').textContent = '';
    for (const l of p.links || []) $('prof-links').append(linkRow(l));
    linkAddState();
    previewPics(p.avatar, p.banner);
    $('prof-view').href = '/u/' + encodeURIComponent(p.username);
    setRailAvatar(p.avatar);
  }

  function previewPics(avatarUrl, bannerUrl) {
    avatarInto($('prof-avatar-prev'), avatarUrl, state.me.username);
    $('prof-banner-prev').textContent = '';
    if (bannerUrl) $('prof-banner-prev').append(h('img', { src: bannerUrl, alt: '' }));
    $('prof-banner-prev').style.setProperty('--pf-bg', $('prof-bg').value);
    $('prof-banner-prev').style.setProperty('--pf-accent', $('prof-accent').value);
    $('prof-avatar-rm').classList.toggle('is-hidden', !draft.avatar);
    $('prof-banner-rm').classList.toggle('is-hidden', !draft.banner);
  }

  async function loadMyProfile() {
    try { fillEditor((await Api.myProfile()).profile); } catch { /* offline */ }
  }

  function bindProfile() {
    $('prof-bio').addEventListener('input', () => { $('prof-bio-count').textContent = `${Array.from($('prof-bio').value).length} / 300`; });
    for (const id of ['prof-accent', 'prof-bg']) $(id).addEventListener('input', () => previewPics(draft.avatar && `/files/${draft.avatar}`, draft.banner && `/files/${draft.banner}`));
    $('prof-link-add').addEventListener('click', () => { if ($('prof-links').children.length < 6) { const r = linkRow(); $('prof-links').append(r); r.querySelector('input').focus(); } linkAddState(); });
    $('prof-avatar-btn').addEventListener('click', () => { picFor = 'avatar'; $('prof-file').value = ''; $('prof-file').click(); });
    $('prof-banner-btn').addEventListener('click', () => { picFor = 'banner'; $('prof-file').value = ''; $('prof-file').click(); });
    $('prof-avatar-rm').addEventListener('click', () => { draft.avatar = null; previewPics(null, draft.banner && `/files/${draft.banner}`); });
    $('prof-banner-rm').addEventListener('click', () => { draft.banner = null; previewPics(draft.avatar && `/files/${draft.avatar}`, null); });
    $('prof-file').addEventListener('change', async () => {
      const f = $('prof-file').files && $('prof-file').files[0];
      if (!f) return;
      if (!Attach.isImage(f.type)) return Ui.toast('Use a PNG, JPEG, GIF or WebP picture.', 'error');
      const which = picFor;
      const btn = $(which === 'avatar' ? 'prof-avatar-btn' : 'prof-banner-btn');
      btn.disabled = true;
      try {
        const prep = await Attach.prepImage(f, { maxSide: which === 'avatar' ? 512 : 1500 });
        if (prep.blob.size > 4 * 1024 * 1024) throw new Error('Profile pictures can be up to 4 MB.');
        const up = await Attach.upload(prep.blob, 'profile');
        draft[which] = up.id;
        previewPics(draft.avatar && `/files/${draft.avatar}`, draft.banner && `/files/${draft.banner}`);
        Ui.toast('Looks good. Press Save profile to keep it.');
      } catch (e) {
        Ui.toast(e.message || "Couldn't upload that picture.", 'error');
      } finally {
        btn.disabled = false;
      }
    });
    $('prof-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      const msg = $('prof-msg');
      msg.classList.add('is-hidden');
      busy(btn, true);
      try {
        const links = Array.from($('prof-links').children).map((r) => ({ label: r.querySelector('.prof-link-label').value, url: r.querySelector('.prof-link-url').value }));
        const { profile } = await Api.saveProfile({
          displayName: $('prof-display').value, status: $('prof-status').value, pronouns: $('prof-pronouns').value, bio: $('prof-bio').value,
          accent: $('prof-accent').value, bg: $('prof-bg').value, public: $('prof-public').checked, links, avatar: draft.avatar, banner: draft.banner,
        });
        fillEditor(profile);
        Ui.toast('Profile saved.');
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.remove('is-hidden');
      } finally {
        busy(btn, false);
      }
    });
    // tap your own name/picture in the corner to see your profile
    document.querySelector('.rail-foot .me').addEventListener('click', () => { if (state.me) openProfile(state.me.username); });
  }

  /* ---- typing indicator ---- */
  let lastTypingSent = 0;
  function onTyping({ room, username, uid }) {
    if (uid === state.me.uid) return;
    let m = state.typing.get(room);
    if (!m) state.typing.set(room, (m = new Map()));
    if (m.has(uid)) clearTimeout(m.get(uid).timer);
    m.set(uid, { name: username, timer: setTimeout(() => clearTyping(room, uid), 3200) });
    refreshTyping();
  }
  function clearTyping(room, uid) {
    const m = state.typing.get(room);
    if (m && m.has(uid)) { clearTimeout(m.get(uid).timer); m.delete(uid); refreshTyping(); }
  }
  function refreshTyping() {
    const m = state.typing.get(state.current);
    const names = m ? Array.from(m.values()).map((x) => x.name) : [];
    Ui.setTyping(names.length === 0 ? null : names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : 'several people are typing');
  }

  function bindComposer() {
    $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    $('composer-input').addEventListener('input', () => {
      const now = Date.now();
      const r = state.rooms.get(state.current);
      if (r && r.type !== 'p2p' && now - lastTypingSent > 1500) { lastTypingSent = now; if (r.type === 'dm') Net.dmTyping(r.peerId); else Net.typing(state.current); }
    });
    $('jump-btn').addEventListener('click', () => Ui.scrollToEnd(state.current));
    $('reconnect-btn').addEventListener('click', () => { showBanner('Reconnecting…'); Ui.setSignal('wait'); Net.reconnect(); });
  }

  /* =====================================================================
   *  link tab (peer to peer)
   * ===================================================================== */
  function showP2pPanel(which) {
    ['idle', 'waiting', 'connected'].forEach((p) => $(`p2p-${p}`).classList.toggle('is-hidden', p !== which));
  }

  const peerId = (raw) => { const m = String(raw).match(/p2p-([A-Za-z0-9-]+)/); return m ? m[1] : (String(raw).trim() || null); };

  function bindLink() {
    PeerSession.on('status', (status, err) => {
      if (status === 'secure') {
        showP2pPanel('connected');
        if (!state.rooms.has(P2P)) {
          state.rooms.set(P2P, makeRoom({ key: P2P, type: 'p2p', name: 'direct link', count: 2 }));
          Ui.addSystem(P2P, 'Connected. Peer to peer. The server cannot see this conversation.');
        }
        renderRooms();
        showTab('rooms');
        switchTo(P2P);
      } else if (status === 'closed') {
        if (state.rooms.has(P2P)) { Ui.toast('The direct chat ended.'); endP2p(); }
        showP2pPanel('idle');
      } else if (status === 'error') {
        Ui.toast((err && err.message) || 'Could not connect.', 'error');
        showP2pPanel('idle');
      }
    });
    PeerSession.on('message', (text) => {
      Ui.addMessage(P2P, { uid: 'p2p-peer', sender: 'them', text: text === null ? 'Could not decrypt this message.' : text, ts: Date.now(), failed: text === null, plainName: true }, { hour24: Settings.get('hour24') });
      const r = state.rooms.get(P2P);
      if (r && state.current !== P2P) { r.unread += 1; renderRooms(); }
      if (Settings.get('sound') && (state.current !== P2P || document.hidden)) playTick();
    });

    $('p2p-host-btn').addEventListener('click', async () => {
      if (needsSecure()) return;
      try {
        const { link } = await PeerSession.host();
        $('p2p-link-text').value = link;
        showP2pPanel('waiting');
      } catch (e) { Ui.toast('Could not start a link: ' + (e.message || 'unknown error'), 'error'); }
    });
    $('p2p-copy-link').addEventListener('click', async () => Ui.toast((await Ui.copy($('p2p-link-text').value)) ? 'Link copied.' : 'Select the link and copy it.'));
    $('p2p-join-btn').addEventListener('click', async () => {
      if (needsSecure()) return;
      const id = peerId($('p2p-join-input').value);
      if (!id) return Ui.toast("That link or code doesn't look right.", 'error');
      try { await PeerSession.join(id); } catch (e) { Ui.toast('Could not connect: ' + (e.message || 'unknown error'), 'error'); }
    });
    $('p2p-cancel-btn').addEventListener('click', () => { PeerSession.teardown(); showP2pPanel('idle'); });
    $('p2p-leave-btn').addEventListener('click', () => { PeerSession.teardown(); endP2p(); showP2pPanel('idle'); });
  }

  function endP2p() {
    state.rooms.delete(P2P);
    Ui.removeLog(P2P);
    $('p2p-link-text').value = '';
    $('p2p-join-input').value = '';
    if (state.current === P2P) switchTo(PUBLIC); else renderRooms();
  }

  /* =====================================================================
   *  links like  /#join=CODE  and  /#p2p-ID
   * ===================================================================== */
  function handleHash() {
    const hash = location.hash;
    if (!hash) return;
    history.replaceState(null, '', location.pathname + location.search); // keep codes out of the address bar/history
    const code = Vault.parseJoinCode(hash);
    if (/join=/.test(hash) && code) {
      $('jn-code').value = code.normalized;
      $('jn-error').classList.add('is-hidden');
      Ui.openModal('dlg-join');
      Ui.toast('Someone sent you a room invite. Press Join to enter.');
    } else if (/p2p-/.test(hash)) {
      $('p2p-join-input').value = hash.replace(/^#/, '');
      showTab('link');
      openRail();
      Ui.toast('Press Connect to open the direct link.');
    }
  }

  /* =====================================================================
   *  chrome: rail, drawer, shortcuts, tab visibility
   * ===================================================================== */
  function openRail() { $('rail').classList.add('is-open'); $('app').classList.add('rail-open'); }
  function closeRail() { $('rail').classList.remove('is-open'); $('app').classList.remove('rail-open'); }
  function openSettings() { $('settings').classList.add('is-open'); $('settings').setAttribute('aria-hidden', 'false'); closeRail(); $('settings-close').focus({ preventScroll: true }); }
  function closeSettings() { $('settings').classList.remove('is-open'); $('settings').setAttribute('aria-hidden', 'true'); }

  function bindChrome() {
    $('rail-open').addEventListener('click', openRail);
    $('rail-close').addEventListener('click', closeRail);
    $('scrim').addEventListener('click', closeRail);
    $('open-settings').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', closeSettings);

    document.addEventListener('pointerdown', (e) => {
      const s = $('settings');
      if (s.classList.contains('is-open') && !s.contains(e.target) && !$('open-settings').contains(e.target) && !e.target.closest('.modal')) closeSettings();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('emoji-pop').classList.contains('is-hidden') || !$('gif-pop').classList.contains('is-hidden')) { closePops(); return; }
        const m = Ui.topModal();
        if (m && m !== 'dlg-confirm') Ui.closeModal(m);
        else if ($('settings').classList.contains('is-open')) closeSettings();
        else closeRail();
      } else if (e.key === '/' && !$('app').classList.contains('is-hidden') && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !$('composer-input').disabled) {
        e.preventDefault();
        $('composer-input').focus();
      }
    });

    // keep the connection alive while you're actually using the page
    let lastAct = 0;
    for (const ev of ['keydown', 'pointerdown']) {
      addEventListener(ev, () => { const n = Date.now(); if (n - lastAct > 60000) { lastAct = n; Net.activity(); } }, { passive: true });
    }

    const away = () => document.documentElement.classList.toggle('is-away', document.hidden || !document.hasFocus());
    document.addEventListener('visibilitychange', () => {
      away();
      if (!document.hidden) { const r = state.rooms.get(state.current); if (r && r.unread) { r.unread = 0; renderRooms(); renderFriends(); } }
    });
    addEventListener('blur', away);
    addEventListener('focus', away);
  }

  let audioCtx = null;
  function playTick() {
    if (!Settings.get('sound')) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(440, t + 0.07);
      g.gain.setValueAtTime(0.04, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.09);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.1);
    } catch { /* audio not available */ }
  }

  /* =====================================================================
   *  start
   * ===================================================================== */
  async function maybeSignOutOnClose() {
    // sessionStorage lives exactly as long as this tab, so a missing flag means a fresh tab.
    let fresh = false;
    try { fresh = !sessionStorage.getItem('zent_tab'); } catch { /* ignore */ }
    if (Settings.get('wipeOnClose') && fresh) {
      try { await Api.logout(); } catch { /* ignore */ }
      try { localStorage.removeItem(ROOMS_KEY); } catch { /* ignore */ }
    }
    try { sessionStorage.setItem('zent_tab', '1'); } catch { /* ignore */ }
  }

  async function start() {
    applyLook();
    bindSettings();
    bindAuth();
    bindRooms();
    bindFriends();
    bindUnlock();
    bindComposer();
    bindLink();
    bindTools();
    bindProfile();
    bindChrome();
    setInterval(tick, 1000);

    try {
      await maybeSignOutOnClose();
      await runBoot();
    } catch { /* the intro and tab cleanup are optional; carry on */ }
    try {
      enter(await Api.me());
    } catch {
      showAuth();
    }
  }

  start();
})();
