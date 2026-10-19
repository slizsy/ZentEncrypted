// Long-term keys for friend messages.
// The private key is locked with a key derived from the password, in the browser. The server
// keeps the locked copy so any device can unlock it; it never sees the private key or password-derived key.
// Each friendship gets its own AES key from ECDH(my private, their public), so either side can
// read the history on any of their devices. No forward secrecy: a stolen private key reads old messages.
const Keys = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const EC = { name: 'ECDH', namedCurve: 'P-256' };
  const ITERS = 310000;
  const LOCK_AAD = enc.encode('zent-key-v1');

  const b64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function lockKey(password, salt, iters) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function lock(password, pkcs8) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: LOCK_AAD }, await lockKey(password, salt, ITERS), pkcs8);
    return { wrapped: b64(wrapped), salt: b64(salt), iv: b64(iv), iters: ITERS };
  }

  // Throws if the password is wrong.
  async function unlockPkcs8(password, rec) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: LOCK_AAD }, await lockKey(password, unb64(rec.salt), rec.iters), unb64(rec.wrapped));
  }

  const importPrivate = (pkcs8) => crypto.subtle.importKey('pkcs8', pkcs8, EC, false, ['deriveBits']);

  async function create(password) {
    const pair = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
    const pub = b64(await crypto.subtle.exportKey('raw', pair.publicKey));
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    return { record: { pub, ...(await lock(password, pkcs8)) }, priv: await importPrivate(pkcs8), pub };
  }

  async function unlock(password, rec) {
    return { priv: await importPrivate(await unlockPkcs8(password, rec)), pub: rec.pub };
  }

  async function relock(oldPassword, newPassword, rec) {
    return lock(newPassword, await unlockPkcs8(oldPassword, rec));
  }

  // Guests: the key never leaves this browser (non-extractable), so nothing is locked or uploaded but the public half.
  async function createGuest() {
    const pair = await crypto.subtle.generateKey(EC, false, ['deriveBits']);
    return { priv: pair.privateKey, pub: b64(await crypto.subtle.exportKey('raw', pair.publicKey)) };
  }

  const convCache = new Map();
  async function convKey(priv, myPub, theirPub, conv) {
    const id = `${conv}|${myPub}|${theirPub}`;
    if (convCache.has(id)) return convCache.get(id);
    const peer = await crypto.subtle.importKey('raw', unb64(theirPub), EC, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, priv, 256);
    const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('zent-dm-v2'), info: enc.encode(conv) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    convCache.set(id, key);
    return key;
  }

  // The additional data ties a ciphertext to its conversation, sender and id: it can't be moved or replayed elsewhere.
  const aad = (conv, from, id) => enc.encode(`${conv}|${from}|${id}`);

  async function seal(key, conv, from, id, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(conv, from, id) }, key, enc.encode(text));
    return { iv: b64(iv), ct: b64(ct) };
  }

  async function open(key, conv, from, id, iv, ct) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(conv, from, id) }, key, unb64(ct));
    return dec.decode(pt);
  }

  // Same on both sides, and stable for the life of the friendship. A swapped key changes it.
  async function safetyCode(pubA, pubB) {
    const [x, y] = [pubA, pubB].sort();
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${x}|${y}`)));
    const hex = Array.from(h.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `${hex.slice(0, 4)}-${hex.slice(4)}`;
  }

  /* ---- keeping the unlocked key on this device (IndexedDB stores the non-extractable key as-is) ---- */
  const memory = new Map();
  function db() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
      const req = indexedDB.open('zent-keys', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('k');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction('k', mode);
      const r = fn(t.objectStore('k'));
      t.oncomplete = () => { d.close(); resolve(r && r.result); };
      t.onerror = t.onabort = () => { d.close(); reject(t.error); };
    }));
  }

  async function remember(userId, keys) {
    memory.set(userId, keys);
    try { await tx('readwrite', (s) => s.put({ priv: keys.priv, pub: keys.pub }, userId)); } catch { /* private mode etc: memory only */ }
  }

  async function recall(userId) {
    if (memory.has(userId)) return memory.get(userId);
    try {
      const k = await tx('readonly', (s) => s.get(userId));
      if (k && k.priv && k.pub) { memory.set(userId, k); return k; }
    } catch { /* unavailable */ }
    return null;
  }

  async function forgetAll() {
    memory.clear();
    convCache.clear();
    try { await tx('readwrite', (s) => s.clear()); } catch { /* nothing stored */ }
  }

  return { create, unlock, relock, createGuest, convKey, seal, open, safetyCode, remember, recall, forgetAll };
})();
