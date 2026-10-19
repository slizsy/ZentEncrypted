// Proof-of-work check for sign-in endpoints, plus per-network connection caps.
// Calm visitors never see it; floods, repeated failures and guessing at one account do.
const crypto = require('crypto');
const { fromRequest, keyFor } = require('./clientIp');

const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

const CFG = {
  enabled: process.env.SHIELD_ENABLED !== '0',
  always: process.env.SHIELD_ALWAYS === '1',
  soft: num(process.env.SHIELD_AUTH_SOFT, 10), // passes / 60s before challenges start
  globalPer10s: num(process.env.SHIELD_GLOBAL_PER_10S, 80),
  ttlMs: 2 * 60 * 1000,
  maxConnPerIp: num(process.env.MAX_CONN_PER_IP, 250),
  maxNewConnPerMin: num(process.env.MAX_NEW_CONN_PER_MIN, 500),
};

const SECRET = crypto
  .createHmac('sha256', process.env.JWT_SECRET || 'dev-only-secret')
  .update('zent-shield-v1')
  .digest();

const perIp = new Map(); // key -> { hits: number[], fails: number[] }
const perAccount = new Map(); // username -> failure timestamps (catches guessing spread over many IPs)
let globalHits = [];
const usedNonces = new Map(); // nonce -> expiry
const conns = new Map(); // key -> { open, recent: number[] }

function rec(key) {
  let r = perIp.get(key);
  if (!r) perIp.set(key, (r = { hits: [], fails: [] }));
  return r;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, r] of perIp) {
    r.hits = r.hits.filter((t) => now - t < 600000);
    r.fails = r.fails.filter((t) => now - t < 600000);
    if (!r.hits.length && !r.fails.length) perIp.delete(k);
  }
  globalHits = globalHits.filter((t) => now - t < 10000);
  for (const [name, fails] of perAccount) {
    const recent = fails.filter((t) => now - t < 15 * 60 * 1000);
    if (recent.length) perAccount.set(name, recent); else perAccount.delete(name);
  }
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
  for (const [k, c] of conns) {
    c.recent = c.recent.filter((t) => now - t < 60000);
    if (!c.open && !c.recent.length) conns.delete(k);
  }
}, 30000).unref();

function underAttack(now = Date.now()) {
  return globalHits.filter((t) => now - t < 10000).length > CFG.globalPer10s;
}

function difficultyFor(key, req) {
  if (!CFG.enabled) return 0;
  const now = Date.now();
  let d = 0;
  if (CFG.always) d = 14;
  const r = perIp.get(key);
  if (r) {
    const hits = r.hits.filter((t) => now - t < 60000).length;
    const fails = r.fails.filter((t) => now - t < 600000).length;
    if (hits > CFG.soft) d = Math.max(d, Math.min(20, 15 + (hits - CFG.soft)));
    if (fails >= 3) d = Math.max(d, Math.min(20, 15 + (fails - 2)));
  }
  if (underAttack(now)) d = Math.max(d, 17);
  if (req && !req.get('user-agent')) d = Math.max(d, 16);
  return d;
}

function note(key) {
  const now = Date.now();
  rec(key).hits.push(now);
  globalHits.push(now);
}

function noteFail(req, account) {
  rec(keyFor(fromRequest(req))).fails.push(Date.now());
  if (account) {
    if (perAccount.size > 50000 && !perAccount.has(account)) perAccount.delete(perAccount.keys().next().value);
    const list = perAccount.get(account) || [];
    list.push(Date.now());
    perAccount.set(account, list.slice(-50));
  }
}

function noteSuccess(req, account) {
  const r = perIp.get(keyFor(fromRequest(req)));
  if (r) r.fails = [];
  if (account) perAccount.delete(account);
}

// After 5 failed logins on one account in 15 minutes, every further try on it needs a puzzle,
// from any network. The real owner waits a second; a guessing bot pays per attempt.
function accountDifficulty(account) {
  if (!CFG.enabled || !account) return 0;
  const now = Date.now();
  const n = (perAccount.get(account) || []).filter((t) => now - t < 15 * 60 * 1000).length;
  return n >= 5 ? Math.min(20, 16 + (n - 5)) : 0;
}

const ipTag = (key) => crypto.createHmac('sha256', SECRET).update('ip:' + key).digest('hex').slice(0, 16);

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}

function issue(difficulty, key) {
  const payload = {
    n: crypto.randomBytes(12).toString('hex'),
    d: difficulty,
    e: Date.now() + CFG.ttlMs,
    i: ipTag(key),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${sign(body)}`, n: payload.n, difficulty };
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/** proof = "<token>|<counter>" */
function verify(proof, needed, key) {
  try {
    const [token, counter] = String(proof).split('|');
    if (!token || !/^\d{1,12}$/.test(counter || '')) return false;
    const [body, sig] = token.split('.');
    if (!body || !sig) return false;
    const expect = sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.e < Date.now() || p.i !== ipTag(key) || p.d < needed) return false;
    if (usedNonces.has(p.n)) return false;
    const hash = crypto.createHash('sha256').update(`${p.n}:${counter}`).digest();
    if (leadingZeroBits(hash) < p.d) return false;
    usedNonces.set(p.n, p.e + 1000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Express middleware. Order matters: the difficulty is computed from
 * *previous* passes, and only passing requests are counted — otherwise the
 * retry carrying a solved proof would raise its own bar and loop forever.
 */
function guard(opts = {}) {
  return (req, res, next) => {
    const key = keyFor(fromRequest(req));
    const account = opts.account ? opts.account(req) : null;
    const need = Math.max(difficultyFor(key, req), accountDifficulty(account));
    if (!need) {
      note(key);
      return next();
    }
    const proof = req.get('x-zent-pow');
    if (proof && verify(proof, need, key)) {
      note(key);
      return next();
    }
    return res.status(428).json({ error: 'Quick check needed before continuing.', challenge: issue(need, key) });
  };
}

/* ---- WebSocket connection limiter ---- */
function connOpen(key) {
  const now = Date.now();
  let c = conns.get(key);
  if (!c) conns.set(key, (c = { open: 0, recent: [] }));
  c.recent = c.recent.filter((t) => now - t < 60000);
  if (c.open >= CFG.maxConnPerIp || c.recent.length >= CFG.maxNewConnPerMin) return false;
  c.open += 1;
  c.recent.push(now);
  return true;
}

function connClose(key) {
  const c = conns.get(key);
  if (c) c.open = Math.max(0, c.open - 1);
}

function status() {
  return { underAttack: underAttack(), tracked: perIp.size, config: { ...CFG } };
}

module.exports = { guard, noteFail, noteSuccess, accountDifficulty, connOpen, connClose, status, leadingZeroBits, _verify: verify, _issue: issue, _difficultyFor: difficultyFor };
