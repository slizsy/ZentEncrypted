// Real visitor IP. Proxy headers are trusted only from loopback (cloudflared on this machine).
const net = require('net');

function isLoopback(addr) {
  return addr === '::1' || addr === '127.0.0.1' || addr === '::ffff:127.0.0.1';
}

function fromRequest(req) {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  if (isLoopback(peer)) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf && net.isIP(String(cf))) return String(cf);
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (net.isIP(first)) return first;
    }
  }
  return peer.replace(/^::ffff:/, '') || 'unknown';
}

/** Expands an IPv6 address into 8 hextets. */
function expandV6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  if (t === null) return h.map((x) => x.padStart(4, '0'));
  const fill = Array(Math.max(0, 8 - h.length - t.length)).fill('0000');
  return [...h, ...fill, ...t].map((x) => x.padStart(4, '0'));
}

/**
 * Bucket key for rate limiting. IPv6 users usually own a whole /64, so we
 * key on that prefix — otherwise rotating addresses would dodge every limit.
 */
function keyFor(ip) {
  if (net.isIPv6(ip)) return 'v6:' + expandV6(ip).slice(0, 4).join(':');
  return ip;
}

module.exports = { fromRequest, keyFor, isLoopback };
