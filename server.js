/**
 * server.js
 * Entry point: Express app + Socket.io server for the self-hosted E2EE chat.
 */
require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const authRoutes = require('./src/auth');
const { initSocket, MAX_PAYLOAD_BYTES } = require('./src/socket');

const app = express();
const server = http.createServer(app);

// --- Security headers ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Tailwind's CDN build injects styles via a <script>, so it needs
        // 'unsafe-inline' on styleSrc too — this is a tradeoff of using the
        // CDN build; see README for swapping to a compiled Tailwind build.
        scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
      },
    },
  })
);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// --- Socket.io with a hard cap on incoming frame size (defense in depth
// alongside the application-level payload check in src/socket.js) ---
const io = new Server(server, {
  maxHttpBufferSize: MAX_PAYLOAD_BYTES + 2048, // small headroom for JSON envelope
  cors: {
    origin: process.env.CORS_ORIGIN || false,
    credentials: true,
  },
});

initSocket(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`E2EE chat server listening on port ${PORT}`);
});
