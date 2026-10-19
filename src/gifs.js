// GIF search through Giphy, proxied by this server so people's browsers never talk to Giphy
// directly (Giphy never sees their IP). Off unless GIPHY_API_KEY is set in .env.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, readSession } = require('./auth');

const KEY = process.env.GIPHY_API_KEY || '';
const API = (process.env.GIPHY_API_BASE || 'https://api.giphy.com').replace(/\/+$/, '');
const MEDIA = (process.env.GIPHY_MEDIA_BASE || 'https://media.giphy.com').replace(/\/+$/, '');
const RATING = ['g', 'pg', 'pg-13', 'r'].includes(process.env.GIF_RATING) ? process.env.GIF_RATING : 'pg-13';
const GIF_ID = /^[A-Za-z0-9]{1,40}$/;
const MAX_GIF_BYTES = 4 * 1024 * 1024;
const CACHE_BYTES = 40 * 1024 * 1024;

const enabled = () => !!KEY;

// where giphy said each gif lives (learned from search results). fallback is the standard url pattern.
const known = new Map();
const mediaHost = (() => { try { return new URL(MEDIA).hostname; } catch { return ''; } })();
function okMediaUrl(u) {
  try {
    const url = new URL(u);
    if (url.hostname === mediaHost) return true; // whatever MEDIA points at (tests use a local one)
    return url.protocol === 'https:' && /^(media\d*|i)\.giphy\.com$/.test(url.hostname);
  } catch { return false; }
}
function remember(gid, u) {
  if (!okMediaUrl(u)) return;
  known.set(gid, u);
  if (known.size > 5000) known.delete(known.keys().next().value);
}

// small in-memory caches: search results (5 min) and gif bytes (LRU, ~40 MB)
const searches = new Map();
const bytes = new Map(); // id -> Buffer (Map keeps insertion order = LRU order)
let cached = 0;
function cachePut(gid, buf) {
  if (buf.length > MAX_GIF_BYTES) return;
  if (bytes.has(gid)) { cached -= bytes.get(gid).length; bytes.delete(gid); }
  bytes.set(gid, buf);
  cached += buf.length;
  while (cached > CACHE_BYTES && bytes.size) {
    const [k, v] = bytes.entries().next().value;
    bytes.delete(k);
    cached -= v.length;
  }
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, redirect: 'follow' }); } finally { clearTimeout(t); }
}

const toInt = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 && n <= 2000 ? n : 0; };

const router = express.Router();
const byUser = (req) => 'gif:' + (req.session ? req.session.sub : 'anon');
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: byUser, message: { error: 'Slow down on the GIF searches.' } });

router.get('/search', requireAuth, searchLimiter, async (req, res) => {
  if (!enabled()) return res.json({ enabled: false, results: [] });
  const q = String(req.query.q || '').trim().slice(0, 50);
  const offset = Math.min(200, Math.max(0, Math.floor(Number(req.query.offset) || 0)));
  const cacheKey = `${q.toLowerCase()}|${offset}`;
  const hit = searches.get(cacheKey);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return res.json({ enabled: true, results: hit.results });

  const params = new URLSearchParams({ api_key: KEY, limit: '24', offset: String(offset), rating: RATING });
  if (q) params.set('q', q);
  let data;
  try {
    const r = await fetchWithTimeout(`${API}/v1/gifs/${q ? 'search' : 'trending'}?${params}`, 8000);
    if (!r.ok) throw new Error('giphy said ' + r.status);
    data = await r.json();
  } catch (e) {
    console.warn('[gifs] search failed:', e.message);
    return res.status(502).json({ error: "Couldn't reach the GIF service. Try again in a bit." });
  }
  const results = [];
  for (const g of Array.isArray(data && data.data) ? data.data : []) {
    if (!g || !GIF_ID.test(String(g.id))) continue;
    const fh = (g.images && g.images.fixed_height) || {};
    const w = toInt(fh.width), h = toInt(fh.height);
    if (fh.url) remember(g.id, fh.url);
    results.push({ id: g.id, w: w || 200, h: h || 200, title: String(g.title || '').slice(0, 80) });
  }
  searches.set(cacheKey, { at: Date.now(), results });
  if (searches.size > 300) searches.delete(searches.keys().next().value);
  res.json({ enabled: true, results });
});

const mediaLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false, validate: false, keyGenerator: (req) => 'gifm:' + ((readSession(req) || {}).sub || 'anon'), message: 'Too many requests.' });

/** GET /gif/:id.gif (outside /api so the browser can cache it) */
async function media(req, res) {
  const gid = String(req.params.id || '');
  if (!GIF_ID.test(gid)) return res.status(404).end();
  if (!readSession(req)) return res.status(401).end();
  if (!enabled()) return res.status(404).end();
  const send = (buf) => {
    res.set('Content-Type', 'image/gif');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  };
  const hit = bytes.get(gid);
  if (hit) { bytes.delete(gid); bytes.set(gid, hit); return send(hit); } // bump to most-recent

  const urls = [known.get(gid), `${MEDIA}/media/${gid}/200.gif`].filter(Boolean);
  for (const u of urls) {
    try {
      const r = await fetchWithTimeout(u, 8000);
      if (!r.ok || !okMediaUrl(r.url || u)) continue;
      const type = String(r.headers.get('content-type') || '');
      if (!/^image\/gif\b/.test(type)) continue;
      const len = Number(r.headers.get('content-length'));
      if (Number.isFinite(len) && len > MAX_GIF_BYTES) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_GIF_BYTES || buf.slice(0, 4).toString('latin1') !== 'GIF8') continue;
      cachePut(gid, buf);
      return send(buf);
    } catch { /* try the next one */ }
  }
  res.status(404).end();
}

module.exports = { router, media, mediaLimiter, enabled, GIF_ID };
