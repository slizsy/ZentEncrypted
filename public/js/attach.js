// Files in the browser: shrink + clean pictures, encrypt for private chats, upload, download.
// Pictures get redrawn before upload, which drops hidden photo data like GPS location.
// For private rooms and friend chats every file gets its own random key; that key only travels
// inside the (already encrypted) message, so the server just stores noise.
const Attach = (() => {
  const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const MAX_SIDE = 2048;
  let cfg = { enabled: true, maxBytes: 10 * 1024 * 1024, publicUploads: 'members' };

  const b64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  const isImage = (mime) => IMAGES.includes(mime);

  function canvasBlob(canvas, mime, quality) {
    return new Promise((resolve) => {
      try { canvas.toBlob((b) => resolve(b), mime, quality); } catch { resolve(null); }
    });
  }

  /**
   * Pictures: redraw (strips metadata, fixes rotation) and shrink to 2048px. GIFs stay as-is so they
   * keep moving. If the browser can't do it, the original goes up instead.
   * returns { blob, w, h, mime }
   */
  async function prepImage(file, { maxSide = MAX_SIDE } = {}) {
    const mime = file.type;
    if (!isImage(mime) || typeof createImageBitmap !== 'function') return { blob: file, w: 0, h: 0, mime };
    let bmp;
    try {
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(file); }
    } catch { return { blob: file, w: 0, h: 0, mime }; }
    const w0 = bmp.width, h0 = bmp.height;
    if (mime === 'image/gif') { if (bmp.close) bmp.close(); return { blob: file, w: w0, h: h0, mime }; }
    try {
      const scale = Math.min(1, maxSide / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); } // no black where transparency was
      ctx.drawImage(bmp, 0, 0, w, h);
      const outType = mime === 'image/png' ? 'image/png' : mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
      let blob = await canvasBlob(canvas, outType, 0.86);
      if (!blob || !blob.size) throw new Error('encode failed');
      if (outType === 'image/webp' && blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/jpeg', 0.86) || blob; // old Safari
      return { blob, w, h, mime: blob.type || outType };
    } catch {
      return { blob: file, w: w0, h: h0, mime };
    } finally {
      if (bmp && bmp.close) bmp.close();
    }
  }

  async function encrypt(buf) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf);
    return { data, key: b64(await crypto.subtle.exportKey('raw', key)), iv: b64(iv) };
  }

  async function decrypt(buf, keyB64, ivB64) {
    const key = await crypto.subtle.importKey('raw', unb64(keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, buf);
  }

  /** scope: 'public' | 'room' | 'dm' | 'profile'; target: room key or friend id */
  async function upload(body, scope, target) {
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Zent-Scope': scope };
    if (target) headers['X-Zent-Target'] = target;
    let res;
    try {
      res = await fetch('/api/files', { method: 'POST', credentials: 'include', headers, body });
    } catch {
      throw new Error("Couldn't upload. Check your connection.");
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new Error(data.error || (res.status === 413 ? 'That file is too big.' : "Couldn't upload that."));
    return data;
  }

  const cache = new Map(); // file id -> object URL (so a picture is only fetched/decrypted once)

  async function fetchBytes(id) {
    const res = await fetch('/files/' + encodeURIComponent(id), { credentials: 'include' });
    if (res.status === 404) { const e = new Error('This file is gone. Files are deleted after a while.'); e.gone = true; throw e; }
    if (!res.ok) throw new Error("Couldn't load that file.");
    return res.arrayBuffer();
  }

  /** downloads + decrypts an encrypted file; returns an object URL with the right type */
  async function openUrl(att) {
    if (cache.has(att.id)) return cache.get(att.id);
    const plain = await decrypt(await fetchBytes(att.id), att.key, att.iv);
    const url = URL.createObjectURL(new Blob([plain], { type: att.mime || 'application/octet-stream' }));
    cache.set(att.id, url);
    return url;
  }

  /** saves a file to the device under its real name */
  async function save(att) {
    const url = await openUrl(att);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.name || 'file';
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  }

  /** Blob -> ArrayBuffer, with a fallback for browsers that lack blob.arrayBuffer() */
  function bytesOf(blob) {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error("Couldn't read that file."));
      r.readAsArrayBuffer(blob);
    });
  }

  const cleanName = (s) => String(s || 'file').replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069/\\]/g, '').trim().slice(0, 120) || 'file';

  return {
    isImage, prepImage, bytesOf, encrypt, decrypt, upload, fetchBytes, openUrl, save, cleanName,
    setConfig: (c) => { if (c && typeof c === 'object') cfg = { ...cfg, ...c }; },
    config: () => cfg,
  };
})();
