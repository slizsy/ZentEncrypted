// Registered accounts (lowdb JSON file). Guests are never written here.
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');

const dataDir = path.dirname(DB_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const adapter = new FileSync(DB_FILE);
const db = low(adapter);

db.defaults({ users: [] }).write();

/**
 * Generates a short, unique, human-typeable friend code like "7K4P-QX2M".
 * extraCheckFn lets the caller also check a second pool of codes (e.g.
 * guest codes) so the two pools never collide with each other.
 */
function generateFriendCode(extraCheckFn) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  const part = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  let code;
  do {
    code = `${part()}-${part()}`;
  } while (codeTaken(code) || (extraCheckFn && extraCheckFn(code)));
  return code;
}

function codeTaken(code) {
  return !!db.get('users').find({ friendCode: code }).value();
}

module.exports = db;
module.exports.generateFriendCode = generateFriendCode;
module.exports.codeTaken = codeTaken;
