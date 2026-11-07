// staff panel: uses your normal account; each role only sees the tabs it can use
(() => {
  const $ = (id) => document.getElementById(id);
  try { Themes.apply(Settings.get('theme')); } catch { /* default look */ }

  const ROLE = { owner: 'Owner', admin: 'Admin', mod: 'Moderator', member: 'Member', guest: 'Guest' };
  const LVL = { guest: 0, member: 1, mod: 2, admin: 3, owner: 4 };
  const REASON = { spam: 'Spam', harassment: 'Harassment', nsfw: 'Sexual or graphic', illegal: 'Illegal', other: 'Other' };
  let me = null;
  let current = null;

  /* ---------- small helpers ---------- */
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    return node;
  }
  function toast(text, bad) {
    const t = el('div', { class: 'toast' + (bad ? ' is-error' : ''), role: 'status', text });
    $('toasts').append(t);
    setTimeout(() => t.remove(), 3800);
  }
  const n = (x) => (Number.isFinite(x) ? x.toLocaleString() : '0');
  const pl = (x, one, many) => `${n(x)} ${x === 1 ? one : many}`;
  const ago = (t) => {
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(t).toLocaleDateString();
  };
  const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const size = (b) => (b < 1048576 ? `${Math.round(b / 1024)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
  const call = (path, method, body) => Api.call('/api/staff' + path, method, body);
  const ask = (q) => window.confirm(q);

  /* ---------- tabs ---------- */
  function showTab(name) {
    current = name;
    document.querySelectorAll('.adm-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    document.querySelectorAll('.adm-pane').forEach((p) => p.classList.toggle('is-hidden', p.id !== 'tab-' + name));
    ({ overview: loadOverview, reports: loadReports, people: loadPeople, settings: loadSettings, audit: loadAudit })[name]();
  }

  /* ---------- overview ---------- */
  function kv(target, rows) {
    target.textContent = '';
    for (const [k, v] of rows) target.append(el('dt', { text: k }), el('dd', { text: v }));
  }
  function chart(days) {
    const c = $('adm-chart'), x = $('adm-chart-x');
    c.textContent = ''; x.textContent = '';
    const max = Math.max(1, ...days.map((d) => d.pub + d.room + d.dm));
    days.forEach((d, i) => {
      const total = d.pub + d.room + d.dm;
      const col = el('div', { class: 'bar', title: `${d.date}: ${total} messages (${d.pub} public, ${d.room} rooms, ${d.dm} friends), ${d.signups} new accounts, peak ${d.peak} online` });
      for (const [k, v] of [['dm', d.dm], ['room', d.room], ['pub', d.pub]]) { const seg = el('i', { class: 'seg seg-' + k }); seg.style.height = `${(v / max) * 100}%`; col.append(seg); }
      col.append(el('span', { class: 'bar-n', text: total ? n(total) : '' }));
      c.append(col);
      x.append(el('span', { text: i === days.length - 1 ? 'today' : i % 2 ? '' : d.date.slice(5).replace('-', '/') }));
    });
  }
  async function loadOverview() {
    let s;
    try { s = await call('/overview'); } catch (e) { return toast(e.message, true); }
    const today = s.days[s.days.length - 1] || { pub: 0, room: 0, dm: 0 };
    $('s-online').textContent = n(s.people.online);
    $('s-online-sub').textContent = `${pl(s.people.members, 'member', 'members')}, ${pl(s.people.guests, 'guest', 'guests')}. Peak today ${n(s.people.peakToday)}`;
    $('s-msgs').textContent = n(today.pub + today.room + today.dm);
    $('s-msgs-sub').textContent = `${n(today.pub)} public, ${n(today.room)} rooms, ${n(today.dm)} friends`;
    $('s-accounts').textContent = n(s.accounts.total);
    $('s-accounts-sub').textContent = `+${n(s.accounts.today)} today, +${n(s.accounts.week)} this week`;
    const m = s.moderation;
    $('s-mod').textContent = n(m.openReports);
    $('s-mod-sub').textContent = `${pl(m.banned, 'banned account', 'banned accounts')}, ${n(m.muted)} muted, ${pl(m.staff, 'staff member', 'staff')}`;
    chart(s.days);
    const st = s.stored || {};
    kv($('adm-stored'), [['Public messages saved', n(st.publicMessages)], ['Friend messages saved (encrypted)', n(st.friendMessages)], ['Files', `${n(st.files)} (${size(st.fileBytes || 0)})`]]);
    const pct = st.fileCap ? Math.min(100, ((st.fileBytes || 0) / st.fileCap) * 100) : 0;
    $('adm-disk-bar').style.width = pct.toFixed(1) + '%';
    $('adm-disk-bar').classList.toggle('is-hot', pct > 85);
    $('adm-files-line').textContent = `File space: ${size(st.fileBytes || 0)} of ${size(st.fileCap || 0)} used (${pct.toFixed(1)}%)`;
    const sv = s.server;
    kv($('adm-server'), [
      ['App version', s.version], ['App running for', dur(s.uptimeSec)], ['Machine up for', dur(sv.systemUptimeSec)],
      ['CPU temperature', sv.cpuTempC == null ? 'n/a' : `${sv.cpuTempC} °C`], ['Load (1, 5, 15 min)', `${sv.load.join(', ')} on ${pl(sv.cpus, 'core', 'cores')}`],
      ['Memory free', `${n(sv.memFreeMB)} of ${n(sv.memTotalMB)} MB`], ['App memory', `${n(sv.rssMB)} MB`],
      ['Disk free', sv.disk ? `${sv.disk.freeGB} of ${sv.disk.totalGB} GB` : 'n/a'], ['Node', sv.node],
    ]);
  }

  /* ---------- reports ---------- */
  let repStatus = 'open';
  async function loadReports() {
    const list = $('rep-list');
    list.textContent = '';
    let reports;
    try { ({ reports } = await call('/reports?status=' + repStatus)); } catch (e) { return toast(e.message, true); }
    if (!reports.length) list.append(el('p', { class: 'empty-note', text: repStatus === 'open' ? 'No open reports. Nice.' : 'Nothing resolved yet.' }));
    for (const r of reports) list.append(reportCard(r));
    refreshCounts();
  }
  function reportCard(r) {
    const card = el('article', { class: 'card' });
    const where = r.kind === 'public' ? '#public' : r.kind === 'room' ? 'private room' : r.kind === 'dm' ? 'friend chat' : 'profile';
    card.append(el('header', { class: 'card-head' },
      el('span', { class: 'chip chip-' + r.reason, text: REASON[r.reason] || r.reason }),
      el('b', { text: r.target ? r.target.username : '?' }),
      el('span', { class: 'muted', text: `reported by ${r.by.username}, ${ago(r.at)}, in ${where}` })));
    if (r.message && r.message.text) {
      card.append(el('blockquote', { class: 'quote', text: r.message.text }));
      if (r.message.shared) card.append(el('p', { class: 'muted small', text: 'From an encrypted chat. The reporter chose to share this text; the server never saw the original.' }));
    } else if (r.message && r.message.att) card.append(el('p', { class: 'muted small', text: '(a picture or GIF)' }));
    else if (r.kind === 'room' || r.kind === 'dm') card.append(el('p', { class: 'muted small', text: 'From an encrypted chat. The reporter did not share the text.' }));
    if (r.note) card.append(el('p', { class: 'note-line' }, el('span', { class: 'muted', text: 'Note: ' }), r.note));
    if (r.status !== 'open') {
      card.append(el('p', { class: 'muted small', text: `${r.status === 'actioned' ? 'Handled' : 'Dismissed'} by ${r.resolvedBy}, ${ago(r.resolvedAt)}${r.resolution ? '. ' + r.resolution : ''}` }));
      return card;
    }
    const acts = el('div', { class: 'btn-row' });
    const resolve = async (outcome, note) => { try { await call(`/reports/${r.id}/resolve`, 'POST', { outcome, note }); loadReports(); } catch (e) { toast(e.message, true); } };
    if (r.kind === 'public' && r.message && r.message.id && r.canAct) {
      acts.append(el('button', { class: 'btn btn-sm', type: 'button', text: 'Remove message', onclick: async () => {
        try { await call(`/public/${encodeURIComponent(r.message.id)}/delete`, 'POST'); toast('Message removed.'); resolve('actioned', 'message removed'); }
        catch (e) { toast(e.message, true); }
      } }));
    }
    if (r.target && r.target.id && r.canAct) {
      acts.append(el('button', { class: 'btn btn-sm', type: 'button', text: 'Mute 1h', onclick: async () => {
        try { await call(`/users/${encodeURIComponent(r.target.id)}/mute`, 'POST', { minutes: 60 }); toast(`${r.target.username} muted for an hour.`); resolve('actioned', 'muted 1h'); }
        catch (e) { toast(e.message, true); }
      } }));
      if (me.can.ban) acts.append(el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'Ban', onclick: async () => {
        if (!ask(`Ban ${r.target.username}?`)) return;
        try { await call(`/users/${encodeURIComponent(r.target.id)}/ban`, 'POST', { reason: REASON[r.reason] || '' }); toast(`${r.target.username} banned.`); resolve('actioned', 'banned'); }
        catch (e) { toast(e.message, true); }
      } }));
    }
    if (!r.canAct && r.target) acts.append(el('span', { class: 'muted small', text: "You can't act on this person (same or higher role). You can still close the report." }));
    acts.append(el('button', { class: 'btn btn-sm', type: 'button', text: 'Mark handled', onclick: () => resolve('actioned') }));
    acts.append(el('button', { class: 'btn btn-sm', type: 'button', text: 'Dismiss', onclick: () => resolve('dismissed') }));
    card.append(acts);
    return card;
  }

  /* ---------- people ---------- */
  let pplFilter = '';
  let pplTimer = null;
  async function loadPeople() {
    const q = $('ppl-q').value.trim();
    let data;
    try { data = await call(`/users?q=${encodeURIComponent(q)}&filter=${pplFilter}`); } catch (e) { return toast(e.message, true); }
    const body = $('ppl-rows');
    body.textContent = '';
    if (!data.users.length) body.append(el('tr', {}, el('td', { colspan: '5', class: 'muted', text: 'Nobody matches.' })));
    for (const u of data.users) body.append(personRow(u));
    if (me.can.ban) loadNetbans();
  }
  function status(u) {
    const bits = [];
    if (u.banned) bits.push(el('span', { class: 'chip chip-bad', title: u.banned.reason || '', text: 'Banned' }));
    if (u.mutedUntil && u.mutedUntil > Date.now()) bits.push(el('span', { class: 'chip chip-warn', text: `Muted ${Math.ceil((u.mutedUntil - Date.now()) / 60000)}m` }));
    if (u.online) bits.push(el('span', { class: 'chip chip-ok', text: 'Online' }));
    return bits.length ? bits : [el('span', { class: 'muted', text: '-' })];
  }
  function personRow(u) {
    const blocked = LVL[u.rank] >= LVL[me.rank] || u.id === me.id;
    return el('tr', {},
      el('td', {}, el('b', { text: u.username }), u.displayName ? el('span', { class: 'muted', text: ' ' + u.displayName }) : null),
      el('td', {}, el('span', { class: 'chip chip-role r-' + u.rank, text: ROLE[u.rank] })),
      el('td', {}, ...status(u)),
      el('td', { class: 'muted', text: u.createdAt ? new Date(u.createdAt).toLocaleDateString() : (u.guest ? 'guest' : '') }),
      el('td', { class: 'acts' }, blocked ? el('span', { class: 'muted small', text: u.id === me.id ? 'you' : '' }) : actionMenu(u)));
  }
  function actionMenu(u) {
    const sel = el('select', { class: 'select select-sm', 'aria-label': `Actions for ${u.username}` });
    const opts = [['', 'Actions…']];
    if (u.mutedUntil && u.mutedUntil > Date.now()) opts.push(['unmute', 'Unmute']);
    else opts.push(['mute10', 'Mute 10 minutes'], ['mute60', 'Mute 1 hour'], ['mute1440', 'Mute 24 hours']);
    opts.push(['kick', u.guest ? 'Kick (ends their guest session)' : 'Kick (disconnect)']);
    if (me.can.ban) {
      opts.push(u.banned ? ['unban', 'Unban'] : ['ban', u.guest ? 'Ban (block network 24h)' : 'Ban']);
      if (!u.guest) opts.push(['signout', 'Sign out everywhere'], ['wipe', 'Delete all their #public messages']);
    }
    if (!u.guest && me.can.roles) {
      for (const r of me.can.owner ? ['member', 'mod', 'admin'] : ['member', 'mod']) if (r !== u.rank) opts.push(['rank:' + r, `Make ${ROLE[r].toLowerCase()}`]);
    }
    if (!u.guest && me.can.owner) opts.push(['delete', 'Delete account']);
    for (const [v, t] of opts) sel.append(el('option', { value: v, text: t }));
    sel.addEventListener('change', async () => {
      const v = sel.value;
      sel.value = '';
      if (!v) return;
      const id = encodeURIComponent(u.id);
      try {
        if (v.startsWith('mute')) { await call(`/users/${id}/mute`, 'POST', { minutes: Number(v.slice(4)) }); toast(`${u.username} muted.`); }
        else if (v === 'unmute') { await call(`/users/${id}/unmute`, 'POST'); toast(`${u.username} unmuted.`); }
        else if (v === 'kick') { if (!ask(`Kick ${u.username}?`)) return; await call(`/users/${id}/kick`, 'POST'); toast(`${u.username} kicked.`); }
        else if (v === 'ban') { const reason = window.prompt(`Ban ${u.username}. Reason (optional):`, ''); if (reason === null) return; await call(`/users/${id}/ban`, 'POST', { reason }); toast(`${u.username} banned.`); }
        else if (v === 'unban') { await call(`/users/${id}/unban`, 'POST'); toast(`${u.username} unbanned.`); }
        else if (v === 'signout') { if (!ask(`Sign ${u.username} out on every device?`)) return; await call(`/users/${id}/signout`, 'POST'); toast(`${u.username} signed out.`); }
        else if (v === 'wipe') { if (!ask(`Delete every #public message from ${u.username}? This can't be undone.`)) return; const r = await call(`/users/${id}/purge-public`, 'POST'); toast(`Removed ${pl(r.removed, 'message', 'messages')}.`); }
        else if (v.startsWith('rank:')) { const rank = v.slice(5); await call(`/users/${id}/rank`, 'POST', { rank }); toast(`${u.username} is now ${ROLE[rank].toLowerCase()}.`); }
        else if (v === 'delete') { if (window.prompt(`Type ${u.username} to delete this account for good:`) !== u.username) return; await call(`/users/${id}`, 'DELETE'); toast(`${u.username}'s account was deleted.`); }
        loadPeople();
      } catch (e) { toast(e.message, true); }
    });
    return sel;
  }
  async function loadNetbans() {
    $('nb-sec').classList.remove('is-hidden');
    let data;
    try { data = await call('/netbans'); } catch { return; }
    const list = $('nb-list');
    list.textContent = '';
    if (!data.netbans.length) return list.append(el('p', { class: 'muted small', text: 'None right now.' }));
    for (const b of data.netbans) {
      list.append(el('div', { class: 'nb-row' },
        el('span', {}, el('b', { text: b.label || 'guest' }), el('span', { class: 'muted', text: `, by ${b.by}, ends ${new Date(b.until).toLocaleString()}${b.reason ? '. ' + b.reason : ''}` })),
        el('button', { class: 'btn btn-sm', type: 'button', text: 'Unblock', onclick: async () => { try { await call('/netbans/' + encodeURIComponent(b.key), 'DELETE'); loadNetbans(); } catch (e) { toast(e.message, true); } } })));
    }
  }

  /* ---------- settings ---------- */
  async function loadSettings() {
    try {
      const { settings } = await call('/settings');
      $('set-posting').value = settings.publicPosting;
      $('set-slow').value = settings.slowModeSec;
      $('set-ann').value = settings.announcement || '';
    } catch (e) { toast(e.message, true); }
  }
  $('set-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('set-msg').classList.add('is-hidden');
    try {
      await call('/settings', 'PUT', { publicPosting: $('set-posting').value, slowModeSec: Number($('set-slow').value) || 0, announcement: $('set-ann').value });
      toast('Saved. Everyone sees the change now.');
    } catch (err) {
      $('set-msg').textContent = err.message;
      $('set-msg').classList.remove('is-hidden');
    }
  });

  /* ---------- audit ---------- */
  const ACTION = {
    'set-role': 'changed role', mute: 'muted', unmute: 'unmuted', kick: 'kicked', ban: 'banned', 'ban-guest': 'banned guest', unban: 'unbanned',
    'sign-out': 'signed out', 'wipe-public': 'wiped #public messages of', 'delete-account': 'deleted account', 'delete-message': 'removed a message from',
    'report-actioned': 'handled a report on', 'report-dismissed': 'dismissed a report on', settings: 'changed #public settings', 'unblock-network': 'unblocked network of',
  };
  async function loadAudit() {
    let data;
    try { data = await call('/audit'); } catch (e) { return toast(e.message, true); }
    const body = $('aud-rows');
    body.textContent = '';
    if (!data.audit.length) body.append(el('tr', {}, el('td', { colspan: '5', class: 'muted', text: 'Nothing yet.' })));
    for (const a of data.audit) {
      body.append(el('tr', {},
        el('td', { class: 'muted', text: new Date(a.at).toLocaleString() }),
        el('td', {}, el('b', { text: a.by }), ' ', el('span', { class: 'chip chip-role r-' + a.rank, text: ROLE[a.rank] || a.rank })),
        el('td', { text: ACTION[a.action] || a.action }),
        el('td', { text: a.target || '' }),
        el('td', { class: 'muted', text: a.detail || '' })));
    }
  }

  /* ---------- start ---------- */
  async function refreshCounts() {
    try {
      const m = await call('/me');
      const c = m.openReports || 0;
      $('nav-reports').textContent = String(c);
      $('nav-reports').classList.toggle('is-hidden', !c);
    } catch { /* ignore */ }
  }

  async function start() {
    try { me = await call('/me'); } catch { me = { rank: 'guest', can: {} }; }
    let who = null;
    try { who = await Api.me(); } catch { /* signed out */ }
    if (!who || !me.can.moderate) {
      $('adm-gate').classList.remove('is-hidden');
      if (who) { $('gate-title').textContent = 'No staff role'; $('gate-text').textContent = `You're signed in as ${who.username}, but this account isn't staff. Ask the owner if you should be.`; }
      return;
    }
    me.id = who.id;
    $('adm-who').textContent = `${who.username}, ${ROLE[me.rank]}`;
    document.querySelectorAll('.adm-tab').forEach((b) => {
      b.classList.toggle('is-hidden', !me.can[b.dataset.need]);
      b.addEventListener('click', () => showTab(b.dataset.tab));
    });
    $('rep-open').addEventListener('click', () => { repStatus = 'open'; $('rep-open').classList.add('is-active'); $('rep-done').classList.remove('is-active'); loadReports(); });
    $('rep-done').addEventListener('click', () => { repStatus = 'resolved'; $('rep-done').classList.add('is-active'); $('rep-open').classList.remove('is-active'); loadReports(); });
    $('ppl-q').addEventListener('input', () => { clearTimeout(pplTimer); pplTimer = setTimeout(loadPeople, 300); });
    document.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
      pplFilter = b.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('is-active', x === b));
      loadPeople();
    }));
    $('adm-app').classList.remove('is-hidden');
    showTab(me.can.stats ? 'overview' : 'reports');
    refreshCounts();
    setInterval(() => { if (!document.hidden && current === 'overview') loadOverview(); refreshCounts(); }, 15000);
  }

  start();
})();
