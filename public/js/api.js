// fetch wrapper; solves the server's proof-of-work check and retries when asked.
const Api = (() => {
  const hooks = { start: null, end: null };

  async function raw(path, method, body, proof) {
    const headers = { 'Content-Type': 'application/json' };
    if (proof) headers['X-Zent-Pow'] = proof;
    const res = await fetch(path, { method, credentials: 'include', headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { res, data };
  }

  async function call(path, method = 'GET', body) {
    let proof = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { res, data } = await raw(path, method, body, proof);
      if (res.status === 428 && data.challenge) {
        if (hooks.start) hooks.start();
        try {
          const counter = await Pow.solve(data.challenge);
          proof = `${data.challenge.token}|${counter}`;
        } finally {
          if (hooks.end) hooks.end();
        }
        continue;
      }
      if (!res.ok) {
        const err = new Error(data.error || 'Request failed.');
        err.status = res.status;
        throw err;
      }
      return data;
    }
    throw new Error('Could not finish the human check. Please try again.');
  }

  return {
    hooks,
    call,
    me: () => call('/api/auth/me'),
    login: (username, password, remember) => call('/api/auth/login', 'POST', { username, password, remember }),
    register: (username, password, remember) => call('/api/auth/register', 'POST', { username, password, remember }),
    guest: (remember) => call('/api/auth/guest', 'POST', { remember }),
    logout: () => call('/api/auth/logout', 'POST', {}),
    changePassword: (current, next, keys) => call('/api/auth/password', 'POST', { current, next, keys }),
    myKeys: () => call('/api/keys/me'),
    setKeys: (rec) => call('/api/keys', 'POST', rec),
    resetKeys: (body) => call('/api/keys/reset', 'POST', body || {}),
    logoutAll: () => call('/api/auth/logout-all', 'POST', {}),
    config: () => call('/api/config'),
    friendCode: () => call('/api/friends/me'),
    friends: () => call('/api/friends/list'),
    addFriend: (code) => call('/api/friends/add', 'POST', { code }),
    removeFriend: (id) => call('/api/friends/' + encodeURIComponent(id), 'DELETE'),
    gifSearch: (q, offset = 0) => call('/api/gifs/search?q=' + encodeURIComponent(q || '') + '&offset=' + offset),
    myProfile: () => call('/api/profiles/me'),
    saveProfile: (p) => call('/api/profiles/me', 'PUT', p),
    profile: (name) => call('/api/profiles/' + encodeURIComponent(name)),
  };
})();
