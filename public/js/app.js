/**
 * app.js
 * Frontend application logic: auth screens, socket wiring, room UI,
 * message send/receive with client-side encrypt/decrypt.
 */
(() => {
  const state = {
    username: null,
    role: null,
    currentRoom: 'global',
    socket: null,
    settings: {
      sound: localStorage.getItem('echat_sound') !== 'off',
      theme: localStorage.getItem('echat_theme') || 'dark',
    },
  };

  const el = (id) => document.getElementById(id);

  // --- Screens ---
  const authScreen = el('auth-screen');
  const chatScreen = el('chat-screen');

  applyTheme(state.settings.theme);

  // --- Boot: check existing session ---
  fetch('/api/auth/me', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((me) => enterChat(me.username, me.role))
    .catch(() => showAuth());

  function showAuth() {
    authScreen.classList.remove('hidden');
    chatScreen.classList.add('hidden');
  }

  async function enterChat(username, role) {
    state.username = username;
    state.role = role;
    authScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    el('me-username').textContent = username;
    el('me-role').textContent = role === 'guest' ? 'Guest' : 'Registered';
    connectSocket();
    await unlockRoom('global');
  }

  // --- Auth form handlers ---
  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = el('login-username').value.trim();
    const password = el('login-password').value;
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.error);
    enterChat(data.username, 'registered');
  });

  el('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = el('register-username').value.trim();
    const password = el('register-password').value;
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.error);
    enterChat(data.username, 'registered');
  });

  el('guest-btn').addEventListener('click', async () => {
    const res = await fetch('/api/auth/guest', { method: 'POST', credentials: 'include' });
    const data = await res.json();
    enterChat(data.username, 'guest');
  });

  function showAuthError(message) {
    const box = el('auth-error');
    box.textContent = message || 'Something went wrong.';
    box.classList.remove('hidden');
  }

  el('show-register').addEventListener('click', () => {
    el('login-form').classList.add('hidden');
    el('register-form').classList.remove('hidden');
  });
  el('show-login').addEventListener('click', () => {
    el('register-form').classList.add('hidden');
    el('login-form').classList.remove('hidden');
  });

  // --- Socket wiring ---
  function connectSocket() {
    state.socket = io({ withCredentials: true });

    state.socket.on('session:ready', ({ room }) => {
      state.currentRoom = room;
    });

    state.socket.on('rooms:update', renderRoomList);

    state.socket.on('message:receive', async (msg) => {
      const plaintext = await E2EE.decryptMessage(msg.room, msg.ciphertext, msg.iv);
      renderMessage(msg.room, {
        sender: msg.sender,
        text: plaintext === null ? '[unable to decrypt — check room passphrase]' : plaintext,
        ts: msg.ts,
        failed: plaintext === null,
      });
      if (msg.room === state.currentRoom && state.settings.sound) playPing();
    });

    state.socket.on('presence:join', ({ username, room }) => {
      renderSystemLine(room, `${username} joined ${room}`);
    });
    state.socket.on('presence:leave', ({ username, room }) => {
      renderSystemLine(room, `${username} left ${room}`);
    });
    state.socket.on('typing', ({ username, room }) => {
      if (room === state.currentRoom) showTypingIndicator(username);
    });

    state.socket.on('server:error', ({ message }) => appendSystemNotice(message, true));
    state.socket.on('server:notice', ({ message }) => appendSystemNotice(message, false));

    state.socket.on('connect_error', () => showAuth());
  }

  // --- Room key unlock (prompt for shared passphrase) ---
  async function unlockRoom(roomName) {
    if (E2EE.hasRoomKey(roomName)) return;
    let passphrase = sessionStorage.getItem(`echat_pp_${roomName}`);
    if (!passphrase) {
      passphrase = prompt(
        `Enter the shared passphrase for room "${roomName}".\nAnyone with this passphrase can read messages in this room. It is never sent to the server.`
      );
      if (!passphrase) return;
      sessionStorage.setItem(`echat_pp_${roomName}`, passphrase);
    }
    await E2EE.deriveRoomKey(roomName, passphrase);
  }

  // --- Room list / switching ---
  function renderRoomList(rooms) {
    const list = el('room-list');
    list.innerHTML = '';
    rooms.forEach((r) => {
      const li = document.createElement('li');
      li.textContent = `# ${r.name} (${r.memberCount})`;
      li.className = r.name === state.currentRoom ? 'room active' : 'room';
      li.addEventListener('click', () => switchRoom(r.name));
      list.appendChild(li);
    });
  }

  async function switchRoom(roomName) {
    if (roomName === state.currentRoom) return;
    state.socket.emit('room:join', roomName);
    state.currentRoom = roomName;
    el('current-room-label').textContent = `# ${roomName}`;
    showRoomMessagePane(roomName);
    await unlockRoom(roomName);
  }

  el('create-room-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('new-room-name');
    const name = input.value.trim();
    if (!name) return;
    state.socket.emit('room:create', name);
    input.value = '';
  });

  // --- Message rendering (per-room panes, only current room visible) ---
  function getOrCreatePane(roomName) {
    let pane = document.querySelector(`.msg-pane[data-room="${CSS.escape(roomName)}"]`);
    if (!pane) {
      pane = document.createElement('div');
      pane.className = 'msg-pane hidden';
      pane.dataset.room = roomName;
      el('messages-container').appendChild(pane);
    }
    return pane;
  }

  function showRoomMessagePane(roomName) {
    document.querySelectorAll('.msg-pane').forEach((p) => p.classList.add('hidden'));
    getOrCreatePane(roomName).classList.remove('hidden');
  }

  function renderMessage(room, { sender, text, ts, failed }) {
    const pane = getOrCreatePane(room);
    const row = document.createElement('div');
    row.className = 'msg-row' + (failed ? ' msg-failed' : '');
    const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `<span class="msg-sender">${escapeHtml(sender)}</span><span class="msg-time">${time}</span><div class="msg-text">${escapeHtml(text)}</div>`;
    pane.appendChild(row);
    pane.scrollTop = pane.scrollHeight;
  }

  function renderSystemLine(room, text) {
    const pane = getOrCreatePane(room);
    const row = document.createElement('div');
    row.className = 'msg-system';
    row.textContent = text;
    pane.appendChild(row);
    pane.scrollTop = pane.scrollHeight;
  }

  function appendSystemNotice(text, isError) {
    const box = el('notice-bar');
    box.textContent = text;
    box.className = isError ? 'notice error' : 'notice';
    box.classList.remove('hidden');
    setTimeout(() => box.classList.add('hidden'), 4000);
  }

  let typingTimeout;
  function showTypingIndicator(username) {
    const indicator = el('typing-indicator');
    indicator.textContent = `${username} is typing…`;
    indicator.classList.remove('hidden');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => indicator.classList.add('hidden'), 2000);
  }

  // --- Send message ---
  el('message-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = el('message-input');
    const text = input.value;
    if (!text.trim()) return;

    if (!E2EE.hasRoomKey(state.currentRoom)) {
      await unlockRoom(state.currentRoom);
      if (!E2EE.hasRoomKey(state.currentRoom)) return; // user cancelled prompt
    }

    try {
      const { ciphertext, iv } = await E2EE.encryptMessage(state.currentRoom, text);
      state.socket.emit('message:send', { room: state.currentRoom, ciphertext, iv });
      input.value = '';
    } catch (err) {
      appendSystemNotice(err.message, true);
    }
  });

  el('message-input').addEventListener('input', () => {
    state.socket?.emit('typing', { room: state.currentRoom });
  });

  // --- Settings panel ---
  el('settings-btn').addEventListener('click', () => el('settings-panel').classList.toggle('hidden'));

  el('sound-toggle').checked = state.settings.sound;
  el('sound-toggle').addEventListener('change', (e) => {
    state.settings.sound = e.target.checked;
    localStorage.setItem('echat_sound', e.target.checked ? 'on' : 'off');
  });

  el('theme-select').value = state.settings.theme;
  el('theme-select').addEventListener('change', (e) => {
    applyTheme(e.target.value);
    localStorage.setItem('echat_theme', e.target.value);
  });

  el('clear-keys-btn').addEventListener('click', () => {
    if (!confirm('Clear all local decryption keys and cached room passphrases? You will need to re-enter passphrases to read new messages.')) return;
    E2EE.clearAllKeys();
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith('echat_pp_'))
      .forEach((k) => sessionStorage.removeItem(k));
    appendSystemNotice('Local keys cleared.', false);
  });

  el('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    E2EE.clearAllKeys();
    state.socket?.disconnect();
    location.reload();
  });

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function playPing() {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.2);
  }
})();
