# ZentEncrypted

A self-hosted, end-to-end encrypted chat app. No accounts required to try it, no third-party captchas, no tracking. Runs on a Raspberry Pi behind a Cloudflare Tunnel, but it will run anywhere Node does.

Live at **https://zentencrypted.org**

---

## What it does

- **Public room** - open plaintext chat for everyone. Messages are saved for 30 days by default (configurable), with a "Load older" button and catch-up after a reconnect.
- **Private rooms** - create a room with a join code. The code is stretched with PBKDF2 into an AES-256-GCM key in your browser. The server only ever sees a hash of the auth half, never the key. Rooms can burn on a timer or when the last person leaves, and you can share a link to invite people.
- **Friend messages** - add friends with a friend code and DM them. Messages are stored on the server as ciphertext only, so they wait for you if you're offline. Includes unread badges, safety codes to verify a friend's key, and unfriending deletes the chat.
- **Guests** - jump in without an account. Guests get an ephemeral key and no history once the session ends.
- **Human check** - a small proof-of-work challenge (15-20 bits, escalating per account after repeated failures) instead of a third-party captcha.
- **Themes** - Graphite (default), Signal, Paper, Ember, Glacier, Phosphor, Riso, Oled, plus a custom theme you can share with a code.
- **Older device support** - CSS fallbacks for browsers without `dvh`, `gap` on flexbox, and modern `clamp()`.

> The P2P Link tab (PeerJS plus app-level ECDH) is experimental and not well tested yet.

## How the encryption works

| Where | What happens |
|---|---|
| Public room | Plaintext by design. Don't say anything there you wouldn't say in public. |
| Private rooms | Key derived from the join code in the browser (PBKDF2 to AES-256-GCM). Server stores no key. |
| Friend DMs | Each account has a long-term ECDH key pair. The private key is locked with a key derived from your password (PBKDF2), so any device can unlock it with your password. Messages are encrypted client-side and stored as ciphertext. |
| Guests | Ephemeral ECDH key, never persisted. |
| Password change | Your account key is re-locked with the new password. |

### Threat model (read this)

This is browser-based E2EE, which has a well-known limit: **you are trusting the server to serve you honest JavaScript.** If the server operator ships malicious code, the encryption can be bypassed. Self-hosting is the answer to that. If you don't run the server yourself, you are trusting whoever does.

The server can also see metadata: who is online, which rooms exist, message timing and size, and who is friends with whom. It cannot read private room or DM contents.

## Security hardening

- Passwords hashed with scrypt (N=32768), with automatic upgrade of legacy bcrypt hashes on login
- CSRF protection on all state-changing requests
- Per-account lockout after repeated failures
- Common-password rejection
- Restrictive file permissions on data (700 for directories, 600 for files)
- Zero known vulnerabilities from `npm audit` at release
- Password change and "sign out everywhere"

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/slizsy/ZentEncrypted.git
cd ZentEncrypted
npm install --omit=dev
cp .env.example .env
# edit .env and set a long random JWT_SECRET
node server.js
```

Then open `http://localhost:3000`.

Note: some browser crypto APIs only work on secure origins. `localhost` is fine, but if you open the app by LAN IP over plain `http://` the app will warn you and link to your `PUBLIC_URL`. For anything beyond local testing, put it behind HTTPS.

## Configuration

Set these in `.env`:

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | none (required) | Long random string used to sign sessions |
| `PORT` | `3000` | Port to listen on |
| `PUBLIC_URL` | none | Public https URL, used for share links and the http warning |
| `HOST` | all interfaces | Set to `127.0.0.1` if you only expose it through a tunnel or reverse proxy |
| `PUBLIC_HISTORY` | `1` | Set to `0` to turn off public chat history |
| `PUBLIC_HISTORY_DAYS` | `30` | How long public messages are kept |
| `PUBLIC_HISTORY_MAX` | `50000` | Max stored public messages |
| `DM_HISTORY_DAYS` | `0` | Days to keep stored DMs (`0` means keep until deleted) |
| `DM_HISTORY_MAX` | `200000` | Max stored encrypted DMs |

## Deploying (Raspberry Pi + Cloudflare Tunnel)

This is how the live site runs.

1. Install Node 20 and pm2 on the Pi.
2. Clone the repo, run `npm install --omit=dev`, and create your `.env`.
3. Start it with pm2 so it survives reboots:
   ```bash
   pm2 start server.js --name zentencrypted
   pm2 save
   ```
4. Install `cloudflared`, create a tunnel pointing at `http://localhost:3000`, and route your domain to it. No ports need to be opened on your router.
5. Once HTTPS works, set `HOST=127.0.0.1` so the app is only reachable through the tunnel.

## Data and maintenance

Everything lives in `data/`:

| File | Contents |
|---|---|
| `db.json` | Accounts, friend codes, locked keys |
| `public-history.jsonl` | Saved public messages |
| `dm.jsonl` | Stored encrypted friend messages (ciphertext only) |

Back these up if you care about them, and **never commit them**.

Clean up public history (stop the server first):

```bash
npm run purge-public -- --dry-run      # preview what would be removed
npm run purge-public -- --all          # wipe all public history
npm run purge-public -- --user NAME    # remove one person's messages
```

## Tests

The suite covers vault and key handling, the proof-of-work worker, history and DM storage, purge tooling, restarts, auth, realtime sockets, and the frontend.

```bash
npm test
```

## Project layout

```
server.js        Express + Socket.io entry point
src/             Server modules (auth, storage, history, etc.)
public/          Frontend (HTML, CSS, client-side crypto)
.env.example     Example configuration
```

## Version history

- **v1** - original shared-passphrase version, kept on the `v1` branch
- **v2** - full rebuild: rooms, friends, proof-of-work, new design
- **v2.2** - public history, theme updates, password change, older device fixes
- **v2.3** - security hardening
- **v2.4** - offline friend messages with stored encrypted DMs

## Roadmap

- Edit and delete messages
- Two-factor sign-in
- Emojis, GIFs, and file sharing
- Moderation tools (report and ban)
- Admin stats page (counts only, password protected)
- Optional Tor hidden service

## Contributing

Issues and pull requests are welcome. If you find a security problem, please open a private report or contact the maintainer directly instead of posting it publicly.

## Disclaimer

This is a hobby project and has not had a professional security audit. Don't rely on it for anything where a failure could put someone at risk.
