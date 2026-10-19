// Stored friend messages. Only ciphertext ever reaches this file: the keys live in the browsers.
// One JSON line per record: m = message, r = read marker, x = conversation deleted,
// e = message edited (new ciphertext), d = message deleted. e/d get squashed into the file soon after.
const fs = require('fs');
const path = require('path');

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

function create(opts = {}) {
  const file = opts.file;
  const days = Math.max(0, num(opts.days, 0));
  const max = Math.max(1000, num(opts.max, 200000));
  const compactMs = Math.max(0, num(opts.compactMs, 10000));

  const convs = new Map(); // conv -> messages, ascending n
  const reads = new Map(); // `${user}|${conv}` -> last read n
  let seq = 0;
  let total = 0;
  let stream = null;
  let warned = false;
  let compactTimer = null;

  const warn = (msg) => { if (!warned) { warned = true; console.error('[dm]', msg); } };

  function openStream() {
    try {
      stream = fs.createWriteStream(file, { fd: fs.openSync(file, 'a'), autoClose: true });
      stream.on('error', (e) => warn('write error: ' + e.message));
    } catch (e) {
      stream = null;
      warn(`cannot open ${file}: ${e.message} (messages kept in memory only)`);
    }
  }

  const write = (rec) => { if (stream) stream.write(JSON.stringify(rec) + '\n'); };

  function rewrite() {
    if (compactTimer) { clearTimeout(compactTimer); compactTimer = null; }
    const old = stream;
    stream = null;
    if (old) old.end();
    const lines = [];
    for (const list of convs.values()) for (const m of list) lines.push(JSON.stringify({ t: 'm', ...m }));
    for (const [k, n] of reads) {
      const i = k.indexOf('|');
      lines.push(JSON.stringify({ t: 'r', u: k.slice(0, i), c: k.slice(i + 1), n }));
    }
    try {
      fs.writeFileSync(file + '.tmp', lines.join('\n') + (lines.length ? '\n' : ''));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      warn('rewrite failed: ' + e.message);
    }
    openStream();
  }

  const validMsg = (m) => typeof m.c === 'string' && typeof m.id === 'string' && typeof m.f === 'string' &&
    Number.isFinite(m.n) && Number.isFinite(m.ts) && typeof m.iv === 'string' && typeof m.ct === 'string' &&
    (m.e === undefined || Number.isFinite(m.e));

  // old ciphertext from edits/deletes shouldn't hang around in the file, so squash it in a bit
  function scheduleCompact() {
    if (compactTimer) return;
    if (!compactMs) return rewrite();
    compactTimer = setTimeout(() => { compactTimer = null; rewrite(); }, compactMs);
    compactTimer.unref();
  }

  const findIn = (c, id) => { const list = convs.get(c); return list ? list.findIndex((m) => m.id === id) : -1; };

  function dropConv(c) {
    const list = convs.get(c);
    if (list) total -= list.length;
    convs.delete(c);
    for (const k of Array.from(reads.keys())) if (k.endsWith('|' + c)) reads.delete(k);
  }

  function prune() {
    let changed = false;
    if (days > 0) {
      const cutoff = Date.now() - days * 86400000;
      for (const [c, list] of convs) {
        const keep = list.filter((m) => m.ts >= cutoff);
        if (keep.length !== list.length) { total -= list.length - keep.length; changed = true; keep.length ? convs.set(c, keep) : convs.delete(c); }
      }
    }
    while (total > max) { // drop the oldest messages across all conversations
      let oldest = null;
      for (const [c, list] of convs) if (list.length && (!oldest || list[0].n < oldest.n)) oldest = { c, n: list[0].n };
      if (!oldest) break;
      const list = convs.get(oldest.c);
      list.shift();
      total--;
      if (!list.length) convs.delete(oldest.c);
      changed = true;
    }
    return changed;
  }

  function load() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { warn(e.message); }
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* first run */ }
    let junk = 0, lines = 0, ops = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      lines++;
      let r;
      try { r = JSON.parse(line); } catch { junk++; continue; }
      if (r.t === 'm' && validMsg(r)) {
        const { t, ...m } = r;
        if (!convs.has(m.c)) convs.set(m.c, []);
        convs.get(m.c).push(m);
        total++;
        seq = Math.max(seq, m.n);
      } else if (r.t === 'r' && typeof r.u === 'string' && typeof r.c === 'string' && Number.isFinite(r.n)) {
        reads.set(`${r.u}|${r.c}`, Math.max(reads.get(`${r.u}|${r.c}`) || 0, r.n));
      } else if (r.t === 'x' && typeof r.c === 'string') {
        dropConv(r.c);
      } else if (r.t === 'e' && typeof r.c === 'string' && typeof r.id === 'string' && typeof r.iv === 'string' && typeof r.ct === 'string') {
        ops++;
        const i = findIn(r.c, r.id);
        if (i >= 0) { const m = convs.get(r.c)[i]; m.iv = r.iv; m.ct = r.ct; if (Number.isFinite(r.e)) m.e = r.e; }
      } else if (r.t === 'd' && typeof r.c === 'string' && typeof r.id === 'string') {
        ops++;
        const i = findIn(r.c, r.id);
        if (i >= 0) { const list = convs.get(r.c); list.splice(i, 1); total--; if (!list.length) convs.delete(r.c); }
      } else junk++;
    }
    for (const list of convs.values()) list.sort((a, b) => a.n - b.n);
    // compact when there's junk, expired data, or lots of superseded read markers
    if (prune() || junk || ops || lines > (total + reads.size) * 2 + 50) rewrite(); else openStream();
  }

  function append({ c, id, f, iv, ct }) {
    const m = { n: ++seq, c, id, f, ts: Date.now(), iv, ct };
    if (!convs.has(c)) convs.set(c, []);
    convs.get(c).push(m);
    total++;
    write({ t: 'm', ...m });
    if (total > max + Math.ceil(max * 0.05)) { prune(); rewrite(); }
    return m;
  }

  const has = (c, id) => findIn(c, id) >= 0;

  /** Swap in new ciphertext for your own message. Returns the message, or null if missing / not yours. */
  function edit(c, id, from, iv, ct) {
    const i = findIn(c, id);
    if (i < 0) return null;
    const m = convs.get(c)[i];
    if (m.f !== from) return null;
    m.iv = iv;
    m.ct = ct;
    m.e = Date.now();
    write({ t: 'e', c, id, iv, ct, e: m.e });
    scheduleCompact();
    return m;
  }

  /** Delete your own message. Returns the removed message, or null. */
  function remove(c, id, from) {
    const i = findIn(c, id);
    if (i < 0) return null;
    const list = convs.get(c);
    const m = list[i];
    if (m.f !== from) return null;
    list.splice(i, 1);
    total--;
    if (!list.length) convs.delete(c);
    write({ t: 'd', c, id });
    scheduleCompact();
    return m;
  }

  function page(c, { before, limit } = {}) {
    const list = convs.get(c) || [];
    const lim = Math.min(100, Math.max(1, Math.floor(num(limit, 50))));
    let end = list.length;
    if (before !== undefined && before !== null && Number.isFinite(Number(before))) {
      const b = Number(before);
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].n < b) lo = mid + 1; else hi = mid; }
      end = lo;
    }
    const start = Math.max(0, end - lim);
    return { messages: list.slice(start, end), hasMore: start > 0 };
  }

  function markRead(user, c, n) {
    const k = `${user}|${c}`;
    const list = convs.get(c);
    const last = list && list.length ? list[list.length - 1].n : 0;
    const v = Math.min(Math.floor(num(n, 0)), last);
    if (v <= (reads.get(k) || 0)) return false;
    reads.set(k, v);
    write({ t: 'r', u: user, c, n: v });
    return true;
  }

  function unread(user, c) {
    const list = convs.get(c);
    if (!list) return 0;
    const seen = reads.get(`${user}|${c}`) || 0;
    let count = 0;
    for (let i = list.length - 1; i >= 0 && list[i].n > seen; i--) if (list[i].f !== user) count++;
    return count;
  }

  function deleteConv(c) {
    if (!convs.has(c) && ![...reads.keys()].some((k) => k.endsWith('|' + c))) return false;
    dropConv(c);
    write({ t: 'x', c });
    scheduleCompact(); // unfriending should really remove the old ciphertext from disk too
    return true;
  }

  const conversations = () => Array.from(convs.keys());
  const close = () => {
    if (compactTimer) rewrite();
    if (stream) { stream.end(); stream = null; }
  };

  load();
  if (!opts.noSweep) setInterval(() => { if (prune()) rewrite(); }, 3600000).unref();

  return { append, has, edit, remove, page, markRead, unread, deleteConv, conversations, close, size: () => total };
}

// The server's store, created on first use.
let shared = null;
function store() {
  if (!shared) {
    const dataDir = path.dirname(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json'));
    shared = create({
      file: process.env.DM_FILE || path.join(dataDir, 'dm.jsonl'),
      days: process.env.DM_HISTORY_DAYS,
      max: process.env.DM_HISTORY_MAX,
      compactMs: process.env.HISTORY_COMPACT_MS,
    });
  }
  return shared;
}

module.exports = {
  create,
  append: (m) => store().append(m),
  has: (c, id) => store().has(c, id),
  edit: (c, id, f, iv, ct) => store().edit(c, id, f, iv, ct),
  remove: (c, id, f) => store().remove(c, id, f),
  page: (c, o) => store().page(c, o),
  markRead: (u, c, n) => store().markRead(u, c, n),
  unread: (u, c) => store().unread(u, c),
  deleteConv: (c) => store().deleteConv(c),
  conversations: () => store().conversations(),
  size: () => store().size(),
  close: () => { if (shared) shared.close(); },
};
