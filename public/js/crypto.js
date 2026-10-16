/**
 * crypto.js
 * Client-side end-to-end encryption using the native Web Crypto API.
 *
 * MODEL USED HERE (read before extending):
 * Each room is protected by a symmetric AES-256-GCM key derived from a
 * PASSPHRASE that room members share with each other OUT OF BAND (in
 * person, over a separate secure channel, etc.) — never through this
 * server. The key is derived locally with PBKDF2 and never transmitted.
 * The server only ever sees room names and opaque ciphertext/IV pairs.
 *
 * This "shared passphrase" model is simple and genuinely end-to-end (the
 * server operator cannot read messages even with full database/traffic
 * access), but it does NOT provide forward secrecy or per-user key
 * revocation. If you need those properties, replace this module with a
 * vetted protocol implementation (e.g. libsignal, matrix-org/olm/megolm)
 * rather than extending the scheme below.
 */

const E2EE = (() => {
  const PBKDF2_ITERATIONS = 250000;
  const AES_PARAMS = { name: 'AES-GCM', length: 256 };

  // In-memory only. Cleared on tab close, logout, or "Clear local keys".
  const roomKeys = new Map(); // roomName -> CryptoKey
  const roomSalts = new Map(); // roomName -> Uint8Array (per-room fixed salt derived from room name)

  function textEncode(str) {
    return new TextEncoder().encode(str);
  }

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /**
   * Derive a stable per-room salt from the room name itself via SHA-256.
   * This does NOT add secrecy (the room name is public) — it only ensures
   * two different rooms never reuse the same salt, which is a PBKDF2 best
   * practice. Actual secrecy comes entirely from the passphrase.
   */
  async function saltForRoom(roomName) {
    if (roomSalts.has(roomName)) return roomSalts.get(roomName);
    const hash = await crypto.subtle.digest('SHA-256', textEncode(`e2ee-salt:${roomName}`));
    const salt = new Uint8Array(hash).slice(0, 16);
    roomSalts.set(roomName, salt);
    return salt;
  }

  async function deriveRoomKey(roomName, passphrase) {
    const salt = await saltForRoom(roomName);
    const baseKey = await crypto.subtle.importKey('raw', textEncode(passphrase), 'PBKDF2', false, [
      'deriveKey',
    ]);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      baseKey,
      AES_PARAMS,
      false,
      ['encrypt', 'decrypt']
    );
    roomKeys.set(roomName, key);
    return key;
  }

  function hasRoomKey(roomName) {
    return roomKeys.has(roomName);
  }

  function forgetRoomKey(roomName) {
    roomKeys.delete(roomName);
  }

  async function encryptMessage(roomName, plaintext) {
    const key = roomKeys.get(roomName);
    if (!key) throw new Error(`No encryption key set for room "${roomName}". Unlock it first.`);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = textEncode(plaintext);
    const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    return {
      ciphertext: arrayBufferToBase64(ciphertextBuf),
      iv: arrayBufferToBase64(iv.buffer),
    };
  }

  /**
   * Returns null on failure (wrong passphrase / not our room key) instead
   * of throwing, so the UI can render "[unable to decrypt]" per-message.
   */
  async function decryptMessage(roomName, ciphertextB64, ivB64) {
    const key = roomKeys.get(roomName);
    if (!key) return null;
    try {
      const iv = new Uint8Array(base64ToArrayBuffer(ivB64));
      const ciphertext = base64ToArrayBuffer(ciphertextB64);
      const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(plainBuf);
    } catch {
      return null;
    }
  }

  function clearAllKeys() {
    roomKeys.clear();
    roomSalts.clear();
  }

  return {
    deriveRoomKey,
    hasRoomKey,
    forgetRoomKey,
    encryptMessage,
    decryptMessage,
    clearAllKeys,
  };
})();
