// Client-side encryption (Web Crypto).
// Rooms: PBKDF2(join-code secret) -> half proves the code to the server, half is the AES-GCM key.
// DMs: throwaway ECDH per conversation; the safety code is a hash of both public keys.
const Vault = (() => {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const ITERATIONS = 150000;
  const AES = { name: 'AES-GCM', length: 256 };
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const keys = new Map(); // roomKey -> CryptoKey

  const toB64 = (buf) => {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  };
  const fromB64 = (b64) => {
    const s = atob(b64);
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  };
  const toHex = (buf) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');

  /* ---------------- join codes ---------------- */
  function generateJoinCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let raw = '';
    for (const b of bytes) raw += ALPHABET[b & 31]; // 256 % 32 == 0, so no modulo bias
    return format(raw);
  }

  function format(raw) {
    return raw.match(/.{4}/g).join('-');
  }

  /** Accepts "abcd efgh-ijkl mnop", full links with #join=..., etc. */
  function parseJoinCode(input) {
    if (typeof input !== 'string') return null;
    let s = input;
    const m = s.match(/join=([A-Za-z0-9-]+)/);
    if (m) s = m[1];
    s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length !== 16) return null;
    for (const ch of s) if (!ALPHABET.includes(ch)) return null;
    return { locator: s.slice(0, 4), secret: s.slice(4), normalized: format(s) };
  }

  async function deriveRoom(locator, secret) {
    const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode('zent-room-v2:' + locator), iterations: ITERATIONS, hash: 'SHA-256' },
      base,
      512
    );
    const bytes = new Uint8Array(bits);
    const roomKey = `c:${locator}`;
    keys.set(roomKey, await crypto.subtle.importKey('raw', bytes.slice(32), AES, false, ['encrypt', 'decrypt']));
    return { roomKey, auth: toHex(bytes.slice(0, 32)) };
  }

  /* ---------------- sealing ---------------- */
  const isReady = (roomKey) => keys.has(roomKey);

  async function seal(roomKey, plaintext) {
    const key = keys.get(roomKey);
    if (!key) throw new Error('This conversation is not unlocked yet.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // AAD binds the ciphertext to its room, so it can't be replayed elsewhere.
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(roomKey) }, key, enc.encode(plaintext));
    return { ciphertext: toB64(ct), iv: toB64(iv) };
  }

  /** Returns the text, or null if it can't be decrypted. */
  async function open(roomKey, ciphertextB64, ivB64) {
    const key = keys.get(roomKey);
    if (!key) return null;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(ivB64), additionalData: enc.encode(roomKey) },
        key,
        fromB64(ciphertextB64)
      );
      return dec.decode(pt);
    } catch {
      return null;
    }
  }

  const forget = (roomKey) => {
    keys.delete(roomKey);
  };
  const wipe = () => {
    keys.clear();
  };

  return { generateJoinCode, parseJoinCode, deriveRoom, isReady, seal, open, forget, wipe };
})();
