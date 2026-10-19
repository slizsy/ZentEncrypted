// Guest identities and friend codes, kept in memory for 24h.
const TTL_MS = 24 * 60 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

const guests = new Map(); // id -> { username, friendCode, friends: Set<string>, expiresAt }

function sweepExpired() {
  const now = Date.now();
  for (const [id, g] of guests) {
    if (g.expiresAt <= now) guests.delete(id);
  }
}
setInterval(sweepExpired, 10 * 60 * 1000).unref();

function codeTaken(code) {
  for (const g of guests.values()) {
    if (g.friendCode === code) return true;
  }
  return false;
}

function generateCode(extraCheckFn) {
  const part = () =>
    Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  let code;
  do {
    code = `${part()}-${part()}`;
  } while (codeTaken(code) || (extraCheckFn && extraCheckFn(code)));
  return code;
}

/**
 * Registers a guest and assigns them a friend code good for 24 hours.
 * extraCheckFn lets the caller also check the registered-user code pool,
 * so guest and registered codes never collide with each other.
 */
function register(id, username, extraCheckFn) {
  sweepExpired();
  const friendCode = generateCode(extraCheckFn);
  guests.set(id, { username, friendCode, friends: new Set(), expiresAt: Date.now() + TTL_MS });
  return friendCode;
}

function get(id) {
  sweepExpired();
  return guests.get(id);
}

function findByCode(code) {
  sweepExpired();
  for (const [id, g] of guests) {
    if (g.friendCode === code) return { id, ...g };
  }
  return null;
}

function nameTaken(username) {
  sweepExpired();
  for (const g of guests.values()) {
    if (g.username === username) return true;
  }
  return false;
}

function removeFriend(id, friendId) {
  const g = guests.get(id);
  if (g) g.friends.delete(friendId);
}

function addFriend(id, friendId) {
  const g = guests.get(id);
  if (g) g.friends.add(friendId);
}

module.exports = { register, get, findByCode, addFriend, removeFriend, nameTaken, codeTaken, TTL_MS };
