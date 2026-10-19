// the public profile page at /u/name. everything shown goes through textContent, links are checked twice.
(() => {
  const $ = (id) => document.getElementById(id);
  const HEX = /^#[0-9a-f]{6}$/i;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function lum(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  const inkOn = (hex) => { const L = lum(hex); return (L + 0.05) / 0.0545 >= 1.05 / (L + 0.05) ? '#0c0c0a' : '#ffffff'; };

  function missing(text) {
    $('pp-card').hidden = true;
    $('pp-missing').hidden = false;
    if (text) $('pp-missing-text').textContent = text;
    document.title = 'Not found · ZENT';
  }

  function render(p) {
    const root = document.documentElement.style;
    const bg = HEX.test(p.bg) ? p.bg : '#161513';
    const accent = HEX.test(p.accent) ? p.accent : '#e2b45c';
    root.setProperty('--bg', bg);
    root.setProperty('--accent', accent);
    root.setProperty('--ink', inkOn(bg));
    root.setProperty('--accent-ink', inkOn(accent));
    $('meta-theme').setAttribute('content', bg);

    const card = $('pp-card');
    if (p.banner) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.src = p.banner;
      $('pp-banner').append(img);
      const back = new Image();
      back.alt = '';
      back.src = p.banner;
      $('pp-backdrop').append(back);
    } else card.classList.add('no-banner');

    const av = $('pp-avatar');
    if (p.avatar) { const img = new Image(); img.alt = ''; img.src = p.avatar; av.append(img); }
    else av.textContent = (p.displayName || p.username).charAt(0);

    const shown = p.displayName || p.username;
    $('pp-name').textContent = shown;
    $('pp-handle').textContent = '@' + p.username;
    if (p.pronouns) {
      const pr = document.createElement('span');
      pr.className = 'pp-pronouns';
      pr.textContent = p.pronouns;
      $('pp-handle').append(pr);
    }
    if (p.status) { $('pp-status').textContent = p.status; $('pp-status').hidden = false; }
    $('pp-bio').textContent = p.bio || '';
    for (const l of Array.isArray(p.links) ? p.links : []) {
      if (!l || typeof l.url !== 'string' || !/^https?:\/\//i.test(l.url)) continue;
      const a = document.createElement('a');
      a.className = 'pp-link';
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      const label = document.createElement('span');
      label.textContent = l.label || l.url;
      const host = document.createElement('small');
      try { host.textContent = new URL(l.url).hostname.replace(/^www\./, ''); } catch { host.textContent = ''; }
      a.append(label, host);
      $('pp-links').append(a);
    }
    const m = /^(\d{4})-(\d{2})$/.exec(p.memberSince || '');
    $('pp-since').textContent = m ? `On ZENT since ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
    document.title = `${shown} (@${p.username}) · ZENT`;
    card.classList.remove('is-loading');
  }

  async function start() {
    const name = decodeURIComponent((location.pathname.match(/^\/u\/([^/]+)/) || [])[1] || '');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) return missing();
    let res;
    try {
      res = await fetch('/api/profiles/' + encodeURIComponent(name), { credentials: 'include' });
    } catch {
      return missing("Couldn't reach the server. Try again in a bit.");
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok || !data.profile) return missing(data.guest ? "Guests don't have profiles." : null);
    render(data.profile);
  }

  start();
})();
