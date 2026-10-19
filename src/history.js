// Saved history for the public room: one JSON line per message, with retention and a size cap.
// Settings: PUBLIC_HISTORY, PUBLIC_HISTORY_DAYS (default 30, 0 = forever), PUBLIC_HISTORY_MAX.
// Edits and deletes are appended as small "op" lines, then the file gets rewritten a few
// seconds later so the old text is really gone from disk (not just hidden).
const fs = require('fs');
const path = require('path');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

function create(opts = {}) {
  const file = opts.file;
  const enabled = opts.enabled !== false;
  const days = Math.max(0, num(opts.days, 0));
  const max = Math.max(100, num(opts.max, 50000));
  const compactMs = Math.max(0, num(opts.compactMs, 10000));

  let msgs = []; // ascending by n
  let byId = new Map(); // id -> record
  let seq = 0;
  let stream = null;
  let warned = false;
  let compactTimer = null;
  let onDrop = typeof opts.onDrop === 'function' ? opts.onDrop : null;

  const validAtt = (a) => a && typeof a === 'object' && typeof a.t === 'string' && typeof a.id === 'string';
  const valid = (m) =>
    m && Number.isFinite(m.n) && Number.isFinite(m.ts) && typeof m.id === 'string' &&
    typeof m.sender === 'string' && typeof m.uid === 'string' && typeof m.text === 'string' &&
    (m.att === undefined || validAtt(m.att)) && (m.text !== '' || m.att !== undefined);

  const reindex = () => { byId = new Map(msgs.map((m) => [m.id, m])); };

  // tell the owner which messages went away (so attached images get deleted too)
  function dropped(list) {
    if (!onDrop || !list.length) return;
    try { onDrop(list); } catch (e) { console.error('[history] drop handler:', e.message); }
  }

  function openStream() {
    if (!enabled) return;
    try {
      // Open the file synchronously so the stream is bound to *this* file right now.
      // (A lazily-opened stream could attach to a file we've since replaced and write duplicates.)
      const fd = fs.openSync(file, 'a');
      stream = fs.createWriteStream(file, { fd, autoClose: true });
      stream.on('error', (e) => {
        if (!warned) { warned = true; console.error('[history] write error on', file, '-', e.message); }
      });
    } catch (e) {
      stream = null;
      if (!warned) { warned = true; console.error('[history] could not open', file, '-', e.message, '(messages will not be saved)'); }
    }
  }

  const write = (rec) => { if (stream) stream.write(JSON.stringify(rec) + '\n'); };

  /** Drops messages past the retention window or over the cap. Returns true if anything was removed. */
  function prune() {
    const before = msgs.length;
    const gone = [];
    if (days > 0) {
      const cutoff = Date.now() - days * 86400000;
      const keep = [];
      for (const m of msgs) (m.ts >= cutoff ? keep : gone).push(m);
      msgs = keep;
    }
    if (msgs.length > max) {
      gone.push(...msgs.slice(0, msgs.length - max));
      msgs = msgs.slice(msgs.length - max);
    }
    if (msgs.length !== before) { reindex(); dropped(gone); }
    return msgs.length !== before;
  }

  /** Atomically rewrites the file from memory (used after pruning/purging/edits). */
  function rewrite() {
    if (compactTimer) { clearTimeout(compactTimer); compactTimer = null; }
    if (!enabled) return;
    const old = stream;
    stream = null;
    if (old) old.end();
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, msgs.map((m) => JSON.stringify(m)).join('\n') + (msgs.length ? '\n' : ''));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!warned) { warned = true; console.error('[history] could not rewrite', file, '-', e.message); }
    }
    openStream();
  }

  // edits/deletes get squashed into the file shortly after, so old text doesn't linger on disk
  function scheduleCompact() {
    if (!enabled || compactTimer) return;
    if (!compactMs) return rewrite();
    compactTimer = setTimeout(() => { compactTimer = null; rewrite(); }, compactMs);
    compactTimer.unref();
  }

  function load() {
    if (!enabled) return { loaded: 0, skipped: 0 };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (e) {
      // Never let a storage problem take the chat down: keep history in memory only.
      warned = true;
      console.error('[history] cannot use', file, '-', e.message, '(history will be kept in memory only until this is fixed)');
    }
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* first run: no file yet */ }
    let skipped = 0, ops = 0;
    msgs = [];
    const seen = new Map();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { skipped++; continue; } // a half-written last line after a power cut, for example
      if (m && m.op === 'e' && typeof m.id === 'string' && typeof m.text === 'string') {
        ops++;
        const r = seen.get(m.id);
        if (r) { r.text = m.text; if (Number.isFinite(m.edited)) r.edited = m.edited; }
      } else if (m && m.op === 'd' && typeof m.id === 'string') {
        ops++;
        const r = seen.get(m.id);
        if (r) { r._gone = true; seen.delete(m.id); }
      } else if (valid(m)) {
        msgs.push(m);
        seen.set(m.id, m);
      } else skipped++;
    }
    msgs = msgs.filter((m) => !m._gone);
    msgs.sort((a, b) => a.n - b.n);
    reindex();
    seq = msgs.reduce((a, m) => Math.max(a, m.n), 0);
    if (prune() || skipped || ops) rewrite(); else openStream();
    return { loaded: msgs.length, skipped };
  }

  function append({ id, ts, sender, uid, text, att }) {
    if (!enabled) return null;
    const rec = { n: ++seq, id, ts, sender, uid, text };
    if (att) rec.att = att;
    msgs.push(rec);
    byId.set(id, rec);
    write(rec);
    if (msgs.length > max + Math.ceil(max * 0.05)) { prune(); rewrite(); } // batch the trimming
    return rec;
  }

  const get = (id) => byId.get(id) || null;

  /** Changes the text of your own message. Returns the record, or null if it's missing / not yours. */
  function edit(id, uid, text) {
    const rec = byId.get(id);
    if (!rec || rec.uid !== uid) return null;
    if (!text && !rec.att) return null;
    rec.text = text;
    rec.edited = Date.now();
    write({ op: 'e', id, text, edited: rec.edited });
    scheduleCompact();
    return rec;
  }

  /** Deletes your own message. Returns the removed record, or null. */
  function remove(id, uid) {
    const rec = byId.get(id);
    if (!rec || rec.uid !== uid) return null;
    let lo = 0, hi = msgs.length; // msgs is sorted by n
    while (lo < hi) { const mid = (lo + hi) >> 1; if (msgs[mid].n < rec.n) lo = mid + 1; else hi = mid; }
    if (msgs[lo] === rec) msgs.splice(lo, 1); else msgs = msgs.filter((m) => m !== rec);
    byId.delete(id);
    write({ op: 'd', id });
    scheduleCompact();
    return rec;
  }

  /** Newest `limit` messages, or the `limit` just before message number `before`. */
  function page({ before, limit } = {}) {
    const lim = Math.min(100, Math.max(1, Math.floor(num(limit, 100))));
    let end = msgs.length;
    if (before !== undefined && before !== null && Number.isFinite(Number(before))) {
      const b = Number(before);
      let lo = 0, hi = msgs.length; // first index with n >= b
      while (lo < hi) { const mid = (lo + hi) >> 1; if (msgs[mid].n < b) lo = mid + 1; else hi = mid; }
      end = lo;
    }
    const start = Math.max(0, end - lim);
    return { messages: msgs.slice(start, end), hasMore: start > 0 };
  }

  /** For the cleanup script: removes matching messages and rewrites the file. Returns how many were removed. */
  function purge(predicate) {
    const before = msgs.length;
    const gone = [];
    msgs = msgs.filter((m) => { const kill = predicate(m); if (kill) gone.push(m); return !kill; });
    if (msgs.length !== before) { reindex(); rewrite(); dropped(gone); }
    return before - msgs.length;
  }

  function close() {
    if (compactTimer) rewrite(); // flush pending edits/deletes before we go
    if (stream) { stream.end(); stream = null; }
  }

  const info = () => ({ enabled, days, max });
  const size = () => msgs.length;
  const ids = () => new Set(byId.keys());
  const setDropHandler = (fn) => { onDrop = typeof fn === 'function' ? fn : null; };

  load();
  if (enabled && !opts.noSweep) setInterval(() => { if (prune()) rewrite(); }, 3600000).unref();

  return { append, get, edit, remove, page, purge, close, info, size, ids, setDropHandler, file };
}

// The server's store is created on first use, so tools that only want create()
// (like scripts/purge-public.js) don't open or trim the file as a side effect.
let shared = null;
let pendingDrop = null;
function store() {
  if (!shared) {
    const dataDir = path.dirname(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json'));
    const days = process.env.PUBLIC_HISTORY_DAYS;
    shared = create({
      file: process.env.PUBLIC_HISTORY_FILE || path.join(dataDir, 'public-history.jsonl'),
      enabled: process.env.PUBLIC_HISTORY !== '0',
      days: days === undefined || days === '' ? 30 : days,
      max: process.env.PUBLIC_HISTORY_MAX,
      compactMs: process.env.HISTORY_COMPACT_MS,
      onDrop: (list) => pendingDrop && pendingDrop(list),
    });
  }
  return shared;
}

module.exports = {
  create,
  append: (m) => store().append(m),
  get: (id) => store().get(id),
  edit: (id, uid, text) => store().edit(id, uid, text),
  remove: (id, uid) => store().remove(id, uid),
  page: (o) => store().page(o),
  purge: (fn) => store().purge(fn),
  info: () => store().info(),
  size: () => store().size(),
  ids: () => store().ids(),
  onDrop: (fn) => { pendingDrop = fn; },
  close: () => { if (shared) shared.close(); },
};
