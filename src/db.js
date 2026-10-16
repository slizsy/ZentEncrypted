/**
 * db.js
 * Lightweight JSON-file database (lowdb) for REGISTERED users only.
 * Guests are never written here — their state lives purely in memory
 * inside src/socket.js and disappears when they disconnect.
 */
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');

// Ensure the data directory exists before lowdb tries to write to it
const dataDir = path.dirname(DB_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const adapter = new FileSync(DB_FILE);
const db = low(adapter);

// Default schema
db.defaults({ users: [], rooms: [] }).write();

module.exports = db;
