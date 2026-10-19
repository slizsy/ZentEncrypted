// Rendering helpers. User text only ever goes through textContent.
const Ui = (() => {
  const $ = (id) => document.getElementById(id);

  /** tiny hyperscript: h('div', {class:'x', on:{click:fn}}, 'text', child) */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'vars') for (const [name, val] of Object.entries(v)) el.style.setProperty(name, val);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  const motionOn = () => document.documentElement.dataset.motion !== 'off';

  /* ---------------- toasts ---------------- */
  function toast(message, kind = 'info', ms = 3800) {
    const host = $('toasts');
    const t = h('div', { class: 'toast' + (kind === 'error' ? ' is-error' : ''), role: 'status', text: message });
    host.append(t);
    while (host.children.length > 4) host.firstChild.remove();
    setTimeout(() => {
      t.classList.add('is-out');
      setTimeout(() => t.remove(), motionOn() ? 260 : 0);
    }, ms);
  }

  /* ---------------- modals ---------------- */
  const openModals = [];
  function openModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.add('is-open');
    if (!openModals.includes(id)) openModals.push(id);
    const first = m.querySelector('input:not([type=checkbox]):not(.is-hidden), button:not([data-close])');
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
  }
  function closeModal(id) {
    const m = $(id);
    const i = openModals.indexOf(id);
    if (i >= 0) openModals.splice(i, 1);
    if (m && m.classList.contains('is-open')) {
      m.classList.remove('is-open');
      m.dispatchEvent(new CustomEvent('modal:closed'));
    }
  }
  const topModal = () => openModals[openModals.length - 1] || null;

  /** In-app replacement for window.confirm. Resolves true/false. */
  function confirmBox({ title = 'Are you sure?', text = '', ok = 'Do it', danger = true }) {
    return new Promise((resolve) => {
      $('cf-title').textContent = title;
      $('cf-text').textContent = text;
      const okBtn = $('cf-ok');
      okBtn.textContent = ok;
      okBtn.classList.toggle('btn-danger', danger);
      okBtn.classList.toggle('btn-solid', !danger);
      const done = (v) => {
        okBtn.removeEventListener('click', yes);
        $('cf-cancel').removeEventListener('click', no);
        $('dlg-confirm').removeEventListener('click', backdrop);
        closeModal('dlg-confirm');
        resolve(v);
      };
      const yes = () => done(true);
      const no = () => done(false);
      const backdrop = (e) => { if (e.target.id === 'dlg-confirm') done(false); };
      okBtn.addEventListener('click', yes);
      $('cf-cancel').addEventListener('click', no);
      $('dlg-confirm').addEventListener('click', backdrop);
      openModal('dlg-confirm');
      $('cf-cancel').focus();
    });
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = h('textarea', { 'aria-hidden': 'true' });
      ta.value = text;
      ta.style.position = 'fixed'; // (individual properties are CSP-safe; cssText is not)
      ta.style.opacity = '0';
      ta.style.left = '-999px';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* blocked */ }
      ta.remove();
      return ok;
    }
  }

  /* ---------------- small formatters ---------------- */
  function hueOf(str) {
    let x = 7;
    for (const ch of String(str)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
    return x % 360;
  }

  function fmtTime(ts, hour24) {
    return new Date(ts).toLocaleTimeString([], { hour: hour24 ? '2-digit' : 'numeric', minute: '2-digit', hour12: !hour24 });
  }

  function fmtRemaining(ms) {
    if (ms <= 0) return '00:00:00';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return d > 0 ? `${d}d ${p(hh)}h` : `${p(hh)}:${p(mm)}:${p(ss)}`;
  }

  /* ---------------- message logs (one per room) ---------------- */
  const logs = new Map(); // key -> { el, lastUid, lastTs, stick, empty, byId }
  const MAX_ROWS = 400;
  // main.js plugs these in: what the edit/delete buttons do, what a name click does, how attachments draw
  const hooks = { action: null, name: null, att: null };

  function getLog(key) {
    let L = logs.get(key);
    if (L) return L;
    const el = h('div', { class: 'log', 'data-room': key });
    L = { el, lastUid: null, lastTs: 0, stick: true, empty: null, byId: new Map() };
    // phones have no hover: tapping your own message shows its edit/delete buttons
    el.addEventListener('click', (e) => {
      if (e.target.closest('button, a, img, video, input')) return;
      const row = e.target.closest('.msg.has-actions');
      el.querySelectorAll('.msg.is-picked').forEach((r) => { if (r !== row) r.classList.remove('is-picked'); });
      if (row) row.classList.toggle('is-picked');
    });
    el.addEventListener('scroll', () => {
      L.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
      if (L.stick && el.classList.contains('is-visible')) $('jump-btn').classList.add('is-hidden');
    });
    $('stream').append(el);
    logs.set(key, L);
    return L;
  }

  function showLog(key) {
    for (const [k, L] of logs) L.el.classList.toggle('is-visible', k === key);
    const L = getLog(key);
    L.el.classList.add('is-visible');
    L.el.scrollTop = L.el.scrollHeight;
    L.stick = true;
    $('jump-btn').classList.add('is-hidden');
  }

  function dropEmpty(L) {
    if (L.empty) { L.empty.remove(); L.empty = null; }
  }

  function setEmpty(key, nodes) {
    const L = getLog(key);
    if (L.el.querySelector('.msg')) return;
    dropEmpty(L);
    L.empty = h('div', { class: 'log-empty' }, nodes);
    L.el.append(L.empty);
  }

  function pushRow(L, row, forceStick) {
    dropEmpty(L);
    L.el.append(row);
    while (L.el.children.length > MAX_ROWS) L.el.firstChild.remove();
    const visible = L.el.classList.contains('is-visible');
    if (forceStick || L.stick) L.el.scrollTop = L.el.scrollHeight;
    else if (visible) $('jump-btn').classList.remove('is-hidden');
  }

  /**
   * Adds a message. Returns { row, body } so callers can attach a translation.
   * Consecutive messages from the same person within 2 minutes are merged.
   * m: { id?, uid, sender, text, ts, own?, failed?, edited?, att?, plainName? }
   */
  function addMessage(key, m, { hour24 = false, animate = true } = {}) {
    const L = getLog(key);
    const cont = L.lastUid === m.uid && m.ts - L.lastTs < 120000 && !m.own === !L.lastOwn;
    L.lastUid = m.uid; L.lastTs = m.ts; L.lastOwn = !!m.own;
    const body = h('div', { class: 'msg-body' + (m.text ? '' : ' is-empty'), text: m.text || '' });
    const name = m.own ? 'you' : m.sender;
    const who = m.plainName || !hooks.name
      ? h('span', { class: 'msg-who', text: name })
      : h('button', { class: 'msg-who', type: 'button', text: name, title: 'View profile', on: { click: () => hooks.name(m) } });
    const canAct = !!(m.own && m.id && !m.failed && hooks.action);
    const row = h(
      'div',
      {
        class: 'msg' + (m.own ? ' is-own' : '') + (cont ? ' is-cont' : '') + (m.failed ? ' is-failed' : '') + (m.edited ? ' is-edited' : '') + (canAct ? ' has-actions' : '') + (animate ? '' : ' no-anim'),
        vars: { '--h': String(hueOf(m.uid || m.sender)) },
        'data-id': m.id || null,
      },
      h('time', { class: 'msg-time', datetime: new Date(m.ts).toISOString(), text: fmtTime(m.ts, hour24) }),
      who,
      body
    );
    let att = null;
    if (m.att && hooks.att) {
      try { att = hooks.att(key, m); } catch { att = null; }
      if (att) row.append(att);
    }
    if (canAct) {
      const act = (what) => (e) => { e.stopPropagation(); row.classList.remove('is-picked'); hooks.action(key, m.id, what); };
      row.append(h('div', { class: 'msg-act', role: 'group', 'aria-label': 'Message actions' },
        m.text !== undefined && !(m.att && m.att.t === 'gif') ? h('button', { type: 'button', text: 'Edit', on: { click: act('edit') } }) : null,
        h('button', { type: 'button', class: 'is-danger', text: 'Delete', on: { click: act('delete') } })));
    }
    if (m.id) L.byId.set(m.id, { row, body, m });
    pushRow(L, row, !!m.own);
    return { row, body, att };
  }

  const findMsg = (key, id) => { const L = logs.get(key); return (L && L.byId.get(id)) || null; };
  const getMessage = (key, id) => { const f = findMsg(key, id); return f ? f.m : null; };

  /** swaps the text of a message that's already on screen (after an edit) */
  function updateMessage(key, id, { text, edited = true }) {
    const f = findMsg(key, id);
    if (!f || !f.row.isConnected) return false;
    f.m.text = text;
    f.m.edited = edited;
    f.body.textContent = text || '';
    f.body.classList.toggle('is-empty', !text);
    f.row.classList.toggle('is-edited', !!edited);
    f.row.querySelectorAll('.msg-tr').forEach((n) => n.remove()); // an old translation no longer matches
    return true;
  }

  /** takes a message off the screen (after a delete) without breaking the name grouping */
  function removeMessage(key, id) {
    const L = logs.get(key);
    const f = L && L.byId.get(id);
    if (!f) return false;
    L.byId.delete(id);
    const row = f.row;
    if (!row.isConnected) return true;
    const next = row.nextElementSibling;
    if (!row.classList.contains('is-cont') && next && next.classList.contains('msg') && next.classList.contains('is-cont')) next.classList.remove('is-cont');
    const wasLast = !next || !next.classList.contains('msg');
    row.remove();
    if (wasLast) L.lastUid = null; // so the next message shows a name again
    return true;
  }

  /** your newest message in a log that can still be edited (for the up-arrow shortcut) */
  function lastOwn(key) {
    const L = logs.get(key);
    if (!L) return null;
    const rows = L.el.querySelectorAll('.msg.has-actions');
    for (let i = rows.length - 1; i >= 0; i--) {
      const f = L.byId.get(rows[i].dataset.id);
      if (f && f.m.own && !(f.m.att && f.m.att.t === 'gif')) return f.m;
    }
    return null;
  }

  /** Re-draws a whole log from a list (used for saved history). Optional "Load older" button on top. */
  function renderBatch(key, msgs, { hour24 = false, hasMore = false, onMore = null } = {}) {
    const L = getLog(key);
    L.el.textContent = '';
    L.empty = null; L.lastUid = null; L.lastTs = 0; L.lastOwn = false; L.byId.clear();
    if (hasMore && onMore) {
      const btn = h('button', { class: 'log-more', type: 'button', text: 'Load older messages' });
      btn.addEventListener('click', () => onMore(btn));
      L.el.append(btn);
    }
    for (const m of msgs) addMessage(key, m, { hour24, animate: false });
  }

  function addSystem(key, text, warn = false) {
    const L = getLog(key);
    L.lastUid = null;
    pushRow(L, h('div', { class: 'sys' + (warn ? ' is-warn' : ''), text }), false);
  }

  function setCompact(on) {
    for (const L of logs.values()) L.el.classList.toggle('is-compact', on);
  }

  function burnLog(key) {
    const L = logs.get(key);
    if (!L) return Promise.resolve();
    L.el.classList.add('is-burning');
    return new Promise((r) => setTimeout(() => { removeLog(key); r(); }, motionOn() ? 1150 : 0));
  }

  function removeLog(key) {
    const L = logs.get(key);
    if (L) { L.el.remove(); logs.delete(key); }
  }

  function clearAllLogs() {
    for (const L of logs.values()) L.el.remove();
    logs.clear();
  }

  function scrollToEnd(key) {
    const L = logs.get(key);
    if (L) { L.el.scrollTop = L.el.scrollHeight; L.stick = true; }
    $('jump-btn').classList.add('is-hidden');
  }

  /* ---------------- header / strip ---------------- */
  function setMode(mode, stampText) {
    const stamp = $('mode-stamp');
    if (stamp.textContent === stampText) return;
    stamp.textContent = stampText;
    stamp.className = 'stamp stamp-' + (mode === 'open' ? 'open' : mode === 'wait' ? 'wait' : 'sealed');
    void stamp.offsetWidth;
    stamp.classList.add('is-flip');
  }

  function setSignal(state) {
    $('signal').dataset.state = state;
    $('signal').setAttribute('aria-label', state === 'up' ? 'Connected' : state === 'wait' ? 'Reconnecting' : 'Offline');
  }

  function setTyping(text) {
    $('typing').classList.toggle('is-hidden', !text);
    $('typing-text').textContent = text || '';
  }

  function swapScreen(show, hide) {
    if (!motionOn()) {
      hide.classList.add('is-hidden');
      show.classList.remove('is-hidden');
      return;
    }
    hide.classList.add('screen-leave');
    setTimeout(() => {
      hide.classList.add('is-hidden');
      hide.classList.remove('screen-leave');
      show.classList.remove('is-hidden');
      show.classList.add('screen-enter');
      setTimeout(() => show.classList.remove('screen-enter'), 450);
    }, 190);
  }

  function fmtSize(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  }

  return {
    $, h, toast, openModal, closeModal, topModal, confirmBox, copy, hueOf, fmtTime, fmtRemaining, fmtSize,
    getLog, showLog, setEmpty, addMessage, updateMessage, removeMessage, getMessage, lastOwn, renderBatch, addSystem, setCompact, burnLog, removeLog, clearAllLogs, scrollToEnd,
    setMode, setSignal, setTyping, swapScreen, motionOn, hooks,
  };
})();
