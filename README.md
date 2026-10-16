# 🔒 E2EE Chat — Self-Hosted Encrypted Chat App

A self-hosted, real-time, end-to-end encrypted chat application built with **Node.js, Express, Socket.io**, and **vanilla HTML/CSS/JS**. The server relays only ciphertext — it never has access to plaintext messages or encryption keys.

---

## Table of Contents
1. [Architecture](#architecture)
2. [How the encryption works](#how-the-encryption-works)
3. [Setup](#setup)
4. [Running the app](#running-the-app)
5. [Project structure](#project-structure)
6. [Security controls](#security-controls)
7. [Self-hosting & deployment](#self-hosting--deployment)
8. [Putting it behind Cloudflare / NGINX (DDoS protection)](#putting-it-behind-cloudflare--nginx-ddos-protection)
9. [Extending the project](#extending-the-project)
10. [Support](#support)

---

## Architecture

```
Browser (client)                     Server (Node.js)
┌─────────────────────┐              ┌──────────────────────┐
│ crypto.js            │  ciphertext  │ Express (HTTP API)   │
│  - PBKDF2 key derive  │ ───────────▶│  - /api/auth/*        │
│  - AES-256-GCM        │◀─────────── │ Socket.io (WebSocket) │
│ app.js (UI + sockets) │  ciphertext │  - rooms, relay only  │
└─────────────────────┘              │ lowdb (users only)   │
                                      └──────────────────────┘
```

The server's role is intentionally limited to:
- Authenticating users (username/password, or issuing ephemeral guest identities)
- Tracking which sockets are in which rooms
- Relaying **opaque ciphertext blobs** between clients in the same room
- Rate-limiting and validating traffic

It never decrypts messages, never stores message content, and never sees private keys or passphrases.

---

## How the encryption works

Each **room** is protected by a **shared passphrase** that members agree on outside of this app (in person, over a phone call, in a separate secure channel, etc.). When a user opens a room for the first time, the client:

1. Prompts for that room's passphrase.
2. Derives a 256-bit AES-GCM key locally using **PBKDF2** (250,000 iterations, SHA-256) via the browser's native `crypto.subtle` API.
3. Uses that key to encrypt every outgoing message (`AES-256-GCM`, with a fresh random IV per message) before it's ever handed to Socket.io.
4. Decrypts incoming ciphertext locally using the same derived key.

The passphrase and derived key **never leave the browser** — they live only in memory / `sessionStorage` for that tab and are wiped on logout or via **Settings → Clear local keys & session data**.

> **Important limitation to understand before deploying this for anything sensitive:** this "shared passphrase" scheme is simple and genuinely end-to-end, but it does **not** provide forward secrecy, per-device key rotation, or protection against a member who leaves the room but still remembers the passphrase (you'd need to rotate the passphrase and inform remaining members). If you need those properties, replace `public/js/crypto.js` with a vetted protocol implementation such as [libsignal](https://github.com/signalapp/libsignal) or [matrix-org/olm](https://gitlab.matrix.org/matrix-org/olm) rather than extending this scheme yourself.

---

## Setup

### Prerequisites
- Node.js 18+
- npm

### Install

```bash
git clone https://github.com/yourname/e2ee-chat.git
cd e2ee-chat
npm install
cp .env.example .env
```

Open `.env` and set a strong, random `JWT_SECRET` (32+ random characters). You can generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Running the app

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

By default the app listens on `http://localhost:3000` (configurable via `PORT` in `.env`).

---

## Project structure

```
e2ee-chat/
├── server.js                # App entry point: Express + Socket.io bootstrap
├── package.json
├── .env.example              # Copy to .env and configure
├── .gitignore
├── data/
│   └── db.json               # lowdb file — registered users only (auto-created)
├── src/
│   ├── db.js                 # lowdb setup
│   ├── auth.js                # /api/auth routes: register, login, guest, logout, me
│   └── socket.js              # Socket.io handlers: rooms, rate limiting, message relay
└── public/
    ├── index.html
    ├── css/
    │   └── style.css          # Dark/Light/OLED themes, responsive layout
    └── js/
        ├── crypto.js           # Web Crypto API E2EE logic
        └── app.js              # Frontend app: auth flow, socket wiring, UI
```

---

## Security controls

| Concern | Where it's implemented |
|---|---|
| Password hashing | `bcrypt`, 12 salt rounds — `src/auth.js` |
| HTTP auth rate limiting | `express-rate-limit` on `/api/auth/*` — `src/auth.js` |
| Session handling | Stateless JWT in an httpOnly, sameSite cookie |
| WebSocket per-socket flood limit | Max 5 messages/sec (configurable) — `src/socket.js` |
| WebSocket payload size cap | 10 KB default, enforced both at Socket.io's `maxHttpBufferSize` and in the app handler — `server.js`, `src/socket.js` |
| Idle connection timeout | Auto-disconnect after inactivity (default 10 min) — `src/socket.js` |
| Security headers | `helmet` with a restrictive CSP — `server.js` |
| Guest data handling | Never written to disk; lives only in the JWT and in-memory room maps |

All of the above thresholds are configurable via `.env` — see `.env.example`.

**Note on scope:** this project implements *application-level* DoS mitigations (per-connection rate/size/idle limits). It does **not** implement network-level DDoS mitigation (SYN floods, volumetric attacks, etc.) — that's a job for infrastructure in front of Node, covered next.

---

## Deploying zentencrypted.org from a home server

This is the exact path for running the app on a server in your house and reaching it from the internet at `zentencrypted.org`, with a real TLS certificate (no browser warnings).

### 1. Give your home server a fixed local IP
On your router, reserve a static/DHCP-reserved local IP for the machine running the app (e.g. `192.168.1.50`), so port forwarding doesn't break when it reboots.

### 2. Handle your home's changing public IP (Dynamic DNS)
Most home ISPs don't give you a static public IP. Two options:
- **If your registrar/DNS provider supports dynamic DNS updates** (Cloudflare does, via their API), run a small updater (e.g. [ddclient](https://ddclient.net/) or Cloudflare's own `cloudflare-ddns` script) on the home server that keeps an `A` record for `zentencrypted.org` pointed at your current public IP.
- **If you'd rather not expose your home IP publicly at all**, use **Cloudflare Tunnel** (`cloudflared`) instead of port forwarding — it makes an outbound-only connection from your home server to Cloudflare, so you don't open any inbound ports on your router. This is the option I'd recommend for a home setup. Steps:
  ```bash
  # On the home server
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
  sudo dpkg -i cloudflared.deb
  cloudflared tunnel login
  cloudflared tunnel create zentencrypted
  cloudflared tunnel route dns zentencrypted zentencrypted.org
  ```
  Then create `~/.cloudflared/config.yml`:
  ```yaml
  tunnel: zentencrypted
  credentials-file: /root/.cloudflared/<tunnel-id>.json
  ingress:
    - hostname: zentencrypted.org
      service: http://localhost:3000
    - service: http_status:404
  ```
  Run it with `cloudflared tunnel run zentencrypted` (or as a systemd service — `cloudflared service install` sets that up for you). With this route, TLS, DDoS protection, and DNS are all handled by Cloudflare automatically — you don't need the NGINX/Certbot section below at all.

### 3. If you go the port-forwarding route instead
Forward ports **80** and **443** on your router to your home server's local IP, then follow [Putting it behind Cloudflare / NGINX](#putting-it-behind-cloudflare--nginx-ddos-protection) below, using `zentencrypted.org` as `server_name` and running Certbot against that domain:
```bash
sudo certbot --nginx -d zentencrypted.org
```

### 4. Keep the app itself running
```bash
npm install -g pm2
cd /path/to/e2ee-chat
pm2 start server.js --name zentencrypted
pm2 save
pm2 startup   # prints a command to run so pm2 survives reboots
```

### 5. Set production env vars
In `.env`, make sure:
```
NODE_ENV=production
PORT=3000
CORS_ORIGIN=https://zentencrypted.org
JWT_SECRET=<your generated secret>
```

At this point, anyone visiting `https://zentencrypted.org` reaches your home server, with TLS terminated either by Cloudflare (tunnel option) or by NGINX+Certbot (port-forward option), while Node keeps running as a background service.

---

## Self-hosting & deployment

### Option A: plain Node process + reverse proxy (recommended baseline)
1. Deploy this repo to your VPS (DigitalOcean, Hetzner, etc.).
2. Run it under a process manager so it restarts on crash/reboot:
   ```bash
   npm install -g pm2
   pm2 start server.js --name e2ee-chat
   pm2 save
   pm2 startup
   ```
3. Put NGINX in front of it (see below) to terminate TLS and proxy to `localhost:3000`.

### Option B: Docker
A minimal `Dockerfile` you can add:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

---

## Putting it behind Cloudflare / NGINX (edge DDoS protection)

Application-level rate limiting (already built in) protects a single Node process from being overwhelmed by one abusive client, but it can't stop large-scale volumetric attacks. For that, put a layer in front of the app:

### Cloudflare (easiest)
1. Point your domain's DNS to Cloudflare and enable the proxy (orange cloud).
2. Under **SSL/TLS**, set mode to **Full (strict)** once you have a certificate on your origin (see NGINX + Let's Encrypt below).
3. Under **Security → WAF**, enable a rate-limiting rule for `/api/auth/*` (e.g. 20 requests/min per IP) as a second layer on top of the app's own limiter.
4. Enable **"I'm Under Attack Mode"** only if you're actively being attacked — it adds a JS challenge that will affect the Socket.io handshake, so leave it off otherwise.
5. Note: Cloudflare's free proxy can buffer/interfere with long-lived WebSocket connections on some plans — verify WebSocket support is enabled for your zone (**Network → WebSockets**, on by default for most plans).

### NGINX (self-managed edge)
Example reverse-proxy config with WebSocket upgrade support and connection limiting:

```nginx
limit_req_zone $binary_remote_addr zone=authlimit:10m rate=10r/m;
limit_conn_zone $binary_remote_addr zone=connlimit:10m;

server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    limit_conn connlimit 20;

    location /api/auth/ {
        limit_req zone=authlimit burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Use [Certbot](https://certbot.eff.org/) to obtain the TLS certificate referenced above.

---

## Extending the project

Ideas for further work, roughly in order of impact:
- **Stronger key exchange**: replace the shared-passphrase model with per-user asymmetric keys (ECDH) and a proper ratchet for forward secrecy.
- **Persistent (encrypted) message history**: currently messages are not stored anywhere — add client-side encrypted local history (e.g. IndexedDB) if you want message persistence without the server ever seeing plaintext.
- **Private 1:1 DMs** as a distinct room type with per-pair keys.
- **File/image sharing**, encrypted client-side before upload.
- **Read receipts / presence indicators** beyond join/leave.
- **Multi-server scaling** via the Socket.io Redis adapter if you outgrow a single instance.

---

## Support

- 🐛 Issues: [GitHub Issues](https://github.com/yourname/e2ee-chat/issues)
- 📖 Docs: this README
- ☕ [Buy Me a Coffee](#) — placeholder, add your link
- 💬 [Discord](#) — placeholder, add your invite link

---

## License

MIT — do whatever you'd like, but see the encryption caveats above before relying on this for anything where forward secrecy or key revocation genuinely matters.
