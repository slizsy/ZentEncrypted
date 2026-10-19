// Peer-to-peer chat over WebRTC (PeerJS) with its own ECDH + AES-GCM layer on top.
const PeerSession = (() => {
  let peer = null;
  let conn = null;
  let myKeys = null;
  let sharedKey = null;
  let handlers = {};

  function signalingOptions() {
    const secure = location.protocol === 'https:';
    return {
      host: location.hostname,
      port: location.port || (secure ? 443 : 80),
      path: '/peerjs',
      secure,
    };
  }

  function emit(event, payload) {
    if (handlers[event]) handlers[event](payload);
  }

  function on(event, fn) {
    handlers[event] = fn;
  }

  async function generateKeys() {
    myKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  }

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function fromB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function sendPublicKey() {
    const raw = await crypto.subtle.exportKey('raw', myKeys.publicKey);
    conn.send({ type: 'pubkey', key: toB64(raw) });
  }

  async function onPeerPublicKey(base64Key) {
    const raw = fromB64(base64Key);
    const theirPublicKey = await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirPublicKey },
      myKeys.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    emit('status', 'secure');
  }

  function wireConnection() {
    conn.on('open', async () => {
      emit('status', 'connected');
      await generateKeys();
      await sendPublicKey();
    });

    conn.on('data', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'pubkey') {
        await onPeerPublicKey(msg.key);
        return;
      }
      if (msg.type === 'msg' && sharedKey) {
        try {
          const iv = new Uint8Array(fromB64(msg.iv));
          const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, fromB64(msg.ciphertext));
          emit('message', new TextDecoder().decode(plainBuf));
        } catch {
          emit('message', null); // tampered or out-of-sync — surfaced as a decrypt failure
        }
      }
    });

    conn.on('close', () => emit('status', 'closed'));
    conn.on('error', (err) => emit('status', 'error', err));
  }

  /** Host side: generates a shareable link and waits for someone to connect. */
  function host() {
    return new Promise((resolve, reject) => {
      peer = new Peer(undefined, signalingOptions());

      peer.on('open', (id) => {
        const link = `${location.origin}/#p2p-${id}`;
        resolve({ id, link });
      });

      peer.on('connection', (incoming) => {
        conn = incoming;
        wireConnection();
      });

      peer.on('error', (err) => {
        emit('status', 'error', err);
        reject(err);
      });
    });
  }

  /** Joiner side: connects to a host's peer ID (parsed from a shared link). */
  function join(hostId) {
    return new Promise((resolve, reject) => {
      peer = new Peer(undefined, signalingOptions());

      peer.on('open', () => {
        conn = peer.connect(hostId, { reliable: true });
        wireConnection();
        resolve();
      });

      peer.on('error', (err) => {
        emit('status', 'error', err);
        reject(err);
      });
    });
  }

  async function sendMessage(text) {
    if (!conn || !sharedKey) throw new Error('Not connected yet.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, new TextEncoder().encode(text));
    conn.send({ type: 'msg', ciphertext: toB64(ct), iv: toB64(iv.buffer) });
  }

  function teardown() {
    if (conn) conn.close();
    if (peer) peer.destroy();
    conn = null;
    peer = null;
    myKeys = null;
    sharedKey = null;
  }

  function isActive() {
    return !!conn;
  }

  return { on, host, join, sendMessage, teardown, isActive };
})();
