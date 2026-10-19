// Looks people up (accounts or guests) and names DM rooms.
const db = require('../config/database');
const guestRegistry = require('./guestRegistry');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DM_RE = new RegExp(`^dm:(${UUID}):(${UUID})$`);

function getIdentity(id) {
  const user = db.get('users').find({ id }).value();
  if (user) {
    return {
      id: user.id,
      username: user.username,
      role: 'registered',
      friendCode: user.friendCode,
      friends: user.friends || [],
      pub: (user.keys && user.keys.pub) || null,
    };
  }
  const guest = guestRegistry.get(id);
  if (guest) {
    return {
      id,
      username: guest.username,
      role: 'guest',
      friendCode: guest.friendCode,
      friends: Array.from(guest.friends),
      expiresAt: guest.expiresAt,
      pub: guest.pub || null,
    };
  }
  return null;
}

function findByCode(code) {
  const user = db.get('users').find({ friendCode: code }).value();
  if (user) return { id: user.id, username: user.username, role: 'registered' };
  const guest = guestRegistry.findByCode(code);
  if (guest) return { id: guest.id, username: guest.username, role: 'guest' };
  return null;
}

function addTo(person, otherId) {
  if (person.role === 'registered') {
    db.get('users').find({ id: person.id }).update('friends', (f) => Array.from(new Set([...(f || []), otherId]))).write();
  } else {
    guestRegistry.addFriend(person.id, otherId);
  }
}

function removeFrom(person, otherId) {
  if (person.role === 'registered') {
    db.get('users').find({ id: person.id }).update('friends', (f) => (f || []).filter((x) => x !== otherId)).write();
  } else {
    guestRegistry.removeFriend(person.id, otherId);
  }
}

function addFriendRelationship(a, b) {
  addTo(a, b.id);
  addTo(b, a.id);
}

function removeFriendRelationship(a, b) {
  removeFrom(a, b.id);
  removeFrom(b, a.id);
}

function areFriends(idA, idB) {
  const a = getIdentity(idA);
  return !!a && a.friends.includes(idB);
}

/** Sorted so both people compute the identical room key. */
function privateRoomName(idA, idB) {
  return `dm:${[idA, idB].sort().join(':')}`;
}

function parseDmRoom(name) {
  const m = DM_RE.exec(String(name));
  return m ? [m[1], m[2]] : null;
}

module.exports = {
  getIdentity, findByCode, addFriendRelationship, removeFriendRelationship,
  areFriends, privateRoomName, parseDmRoom,
};
