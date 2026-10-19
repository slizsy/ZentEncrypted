// Socket.io connection and promise-based emits.
const Net = (() => {
  let socket = null;

  function emit(event, payload, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!socket || !socket.connected) return resolve({ ok: false, error: "You're offline right now." });
      const t = setTimeout(() => resolve({ ok: false, error: 'The server took too long to answer.' }), timeoutMs);
      socket.emit(event, payload, (res) => {
        clearTimeout(t);
        resolve(res || { ok: false, error: 'No response.' });
      });
    });
  }

  function connect(h) {
    socket = io({ withCredentials: true, reconnectionDelayMax: 8000 });
    const on = (ev, name) => socket.on(ev, (...a) => h[name] && h[name](...a));
    on('connect', 'onConnect');
    on('disconnect', 'onDisconnect');
    on('connect_error', 'onConnectError');
    on('session:ready', 'onReady');
    on('presence:join', 'onPresenceJoin');
    on('presence:leave', 'onPresenceLeave');
    on('room:count', 'onCount');
    on('message:receive', 'onMessage');
    on('typing', 'onTyping');
    on('room:expired', 'onExpired');
    on('room:kicked', 'onKicked');
    on('dm:message', 'onDmMessage');
    on('dm:typing', 'onDmTyping');
    on('dm:cleared', 'onDmCleared');
    on('friends:changed', 'onFriendsChanged');
    on('friend:presence', 'onFriendPresence');
    on('session:idle', 'onIdle');
    on('server:error', 'onServerError');
    on('message:edited', 'onEdited');
    on('message:deleted', 'onDeleted');
    on('dm:edited', 'onDmEdited');
    on('dm:deleted', 'onDmDeleted');
    return socket;
  }

  return {
    connect,
    reconnect: () => socket && socket.connect(),
    disconnect: () => socket && socket.disconnect(),
    isConnected: () => !!(socket && socket.connected),
    join: (p) => emit('room:join', p),
    create: (p) => emit('room:create', p),
    leave: (room) => emit('room:leave', { room }),
    send: (p) => emit('message:send', p),
    editMsg: (p) => emit('message:edit', p),
    deleteMsg: (p) => emit('message:delete', p),
    dmEdit: (p) => emit('dm:edit', p),
    dmDelete: (p) => emit('dm:delete', p),
    friendsOnline: () => emit('friends:online', {}),
    history: (p) => emit('history:load', p),
    typing: (room) => socket && socket.connected && socket.emit('typing', { room }),
    dmSend: (p) => emit('dm:send', p),
    dmHistory: (p) => emit('dm:history', p),
    dmUnread: () => emit('dm:unread', {}),
    dmRead: (p) => socket && socket.connected && socket.emit('dm:read', p),
    dmTyping: (to) => socket && socket.connected && socket.emit('dm:typing', { to }),
    activity: () => socket && socket.connected && socket.emit('activity'),
  };
})();
