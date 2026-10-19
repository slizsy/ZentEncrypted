// admin dashboard: signs in with ADMIN_PASSWORD, then polls /api/admin/stats every 10s
(() => {
  const $ = (id) => document.getElementById(id);
  try { Themes.apply(Settings.get('theme')); } catch { /* default look */ }

  const show = (which) => {
    for (const id of ['adm-off', 'adm-login', 'adm-dash']) $(id).classList.toggle('is-hidden', id !== which);
    $('adm-out').classList.toggle('is-hidden', which !== 'adm-dash');
    $('adm-live').classList.toggle('is-hidden', which !== 'adm-dash');
  };
  const n = (x) => (Number.isFinite(x) ? x.toLocaleString() : '0');
  const pl = (x, one, many) => `${n(x)} ${x === 1 ? one : many}`;
  const dur = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const size = (b) => (b < 1048576 ? `${Math.round(b / 1024)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);

  function kv(el, rows) {
    el.textContent = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      el.append(dt, dd);
    }
  }

  function chart(days) {
    const el = $('adm-chart'), x = $('adm-chart-x');
    el.textContent = ''; x.textContent = '';
    const max = Math.max(1, ...days.map((d) => d.pub + d.room + d.dm));
    days.forEach((d, i) => {
      const col = document.createElement('div');
      col.className = 'bar';
      const total = d.pub + d.room + d.dm;
      col.title = `${d.date}: ${total} messages (${d.pub} public, ${d.room} rooms, ${d.dm} friends), ${d.signups} new accounts, peak ${d.peak} online`;
      for (const [k, v] of [['dm', d.dm], ['room', d.room], ['pub', d.pub]]) {
        const seg = document.createElement('i');
        seg.className = 'seg seg-' + k;
        seg.style.height = `${(v / max) * 100}%`;
        col.append(seg);
      }
      const num = document.createElement('span');
      num.className = 'bar-n';
      num.textContent = total ? n(total) : '';
      col.append(num);
      el.append(col);
      const lab = document.createElement('span');
      lab.textContent = i === days.length - 1 ? 'today' : i % 2 ? '' : d.date.slice(5).replace('-', '/');
      x.append(lab);
    });
  }

  function render(s) {
    const today = s.days[s.days.length - 1] || { pub: 0, room: 0, dm: 0 };
    $('s-online').textContent = n(s.people.online);
    $('s-online-sub').textContent = `${pl(s.people.members, 'member', 'members')}, ${pl(s.people.guests, 'guest', 'guests')}. Peak today ${n(s.people.peakToday)}`;
    $('s-msgs').textContent = n(today.pub + today.room + today.dm);
    $('s-msgs-sub').textContent = `${n(today.pub)} public, ${n(today.room)} rooms, ${n(today.dm)} friends`;
    $('s-accounts').textContent = n(s.accounts.total);
    $('s-accounts-sub').textContent = `+${n(s.accounts.today)} today, +${n(s.accounts.week)} this week`;
    $('s-rooms').textContent = n(s.rooms.active);
    $('s-rooms-sub').textContent = pl(s.rooms.inRooms, 'connection inside', 'connections inside');
    chart(s.days);

    const st = s.stored || {};
    kv($('adm-stored'), [
      ['Public messages saved', n(st.publicMessages)],
      ['Friend messages saved (encrypted)', n(st.friendMessages)],
      ['Files', `${n(st.files)} (${size(st.fileBytes || 0)})`],
    ]);
    const pct = st.fileCap ? Math.min(100, ((st.fileBytes || 0) / st.fileCap) * 100) : 0;
    $('adm-disk-bar').style.width = pct.toFixed(1) + '%';
    $('adm-disk-bar').classList.toggle('is-hot', pct > 85);
    $('adm-files-line').textContent = `File space: ${size(st.fileBytes || 0)} of ${size(st.fileCap || 0)} used (${pct.toFixed(1)}%)`;

    const sv = s.server;
    kv($('adm-server'), [
      ['App version', s.version],
      ['App running for', dur(s.uptimeSec)],
      ['Machine up for', dur(sv.systemUptimeSec)],
      ['CPU temperature', sv.cpuTempC == null ? 'n/a' : `${sv.cpuTempC} °C`],
      ['Load (1, 5, 15 min)', `${sv.load.join(', ')} on ${pl(sv.cpus, 'core', 'cores')}`],
      ['Memory free', `${n(sv.memFreeMB)} of ${n(sv.memTotalMB)} MB`],
      ['App memory', `${n(sv.rssMB)} MB`],
      ['Disk free', sv.disk ? `${sv.disk.freeGB} of ${sv.disk.totalGB} GB` : 'n/a'],
      ['Node', sv.node],
    ]);
    $('adm-updated').textContent = 'updated ' + new Date(s.now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  let timer = null;
  async function poll() {
    clearTimeout(timer);
    try {
      const r = await fetch('/api/admin/stats', { credentials: 'include' });
      if (r.status === 404) return show('adm-off');
      if (r.status === 401) return show('adm-login');
      if (!r.ok) throw new Error();
      render(await r.json());
      show('adm-dash');
    } catch {
      $('adm-updated').textContent = "can't reach the server";
    }
    timer = setTimeout(() => { if (!document.hidden) poll(); else timer = setTimeout(poll, 10000); }, 10000);
  }

  $('adm-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const err = $('adm-err');
    err.classList.add('is-hidden');
    btn.disabled = true; btn.classList.add('is-busy');
    try {
      await Api.call('/api/admin/login', 'POST', { password: $('adm-pw').value }); // solves the human check if asked
      $('adm-pw').value = '';
      await poll();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('is-hidden');
    } finally {
      btn.disabled = false; btn.classList.remove('is-busy');
    }
  });

  $('adm-out').addEventListener('click', async () => {
    try { await fetch('/api/admin/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* signed out anyway */ }
    clearTimeout(timer);
    show('adm-login');
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('adm-dash').classList.contains('is-hidden')) poll(); });

  poll();
})();
