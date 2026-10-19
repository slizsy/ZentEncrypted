#!/usr/bin/env node
/**
 * scripts/purge-public.js
 * Deletes saved PUBLIC-room messages. Run it with the server STOPPED:
 *
 *   pm2 stop zentencrypted
 *   npm run purge-public -- --all
 *   pm2 start zentencrypted
 *
 * Options (use one):
 *   --all                  delete every saved public message
 *   --older-than DAYS      delete messages older than DAYS days
 *   --user NAME            delete everything a display name posted (exact match, case-insensitive)
 *   --match TEXT           delete messages containing TEXT (case-insensitive)
 *   --dry-run              show what would be deleted, change nothing
 *   --force                run even if a server seems to be running (not recommended)
 */
require('dotenv').config();
const http = require('http');
const { create } = require('../src/history');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

function usage(msg) {
  if (msg) console.error('\n' + msg + '\n');
  console.error('Usage: npm run purge-public -- (--all | --older-than DAYS | --user NAME | --match TEXT) [--dry-run]');
  process.exit(2);
}

function serverIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: process.env.PORT || 3000, path: '/health', timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

(async () => {
  const modes = ['--all', '--older-than', '--user', '--match'].filter(flag);
  if (modes.length !== 1) usage('Pick exactly one of --all, --older-than, --user, --match.');

  if (!flag('--force') && (await serverIsUp())) {
    console.error('\nThe chat server is running. Stop it first (pm2 stop zentencrypted), run this, then start it again.\n' +
      'Changing the file under a running server can lose new messages or bring deleted ones back.\n');
    process.exit(1);
  }

  let predicate;
  if (flag('--all')) predicate = () => true;
  else if (flag('--older-than')) {
    const d = Number(val('--older-than'));
    if (!Number.isFinite(d) || d < 0) usage('--older-than needs a number of days.');
    const cutoff = Date.now() - d * 86400000;
    predicate = (m) => m.ts < cutoff;
  } else if (flag('--user')) {
    const u = (val('--user') || '').toLowerCase();
    if (!u) usage('--user needs a display name.');
    predicate = (m) => m.sender.toLowerCase() === u;
  } else {
    const t = (val('--match') || '').toLowerCase();
    if (!t) usage('--match needs some text.');
    predicate = (m) => m.text.toLowerCase().includes(t);
  }

  // retention off for this tool so it only does what you asked
  const hist = create({ file: process.env.PUBLIC_HISTORY_FILE || require('path').join(require('path').dirname(process.env.DB_FILE || require('path').join(__dirname, '..', 'data', 'db.json')), 'public-history.jsonl'), days: 0, max: 1e9, noSweep: true });
  const total = hist.size();
  const all = hist.page({ limit: 100 }); // (only to confirm the file loads)
  void all;

  if (flag('--dry-run')) {
    let would = 0;
    // page through everything without modifying
    let before; let more = true;
    while (more) {
      const p = hist.page({ before, limit: 100 });
      would += p.messages.filter(predicate).length;
      more = p.hasMore; before = p.messages[0] && p.messages[0].n;
    }
    console.log(`Dry run: ${would} of ${total} saved messages would be deleted. Nothing was changed.`);
  } else {
    const removed = hist.purge(predicate);
    console.log(`Deleted ${removed} of ${total} saved public messages. ${total - removed} remain.`);
  }
  hist.close();
  setTimeout(() => process.exit(0), 100);
})();
