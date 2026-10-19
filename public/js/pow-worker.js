// Proof-of-work solver (single-block SHA-256), run off the main thread.
(function () {
  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  var W = new Uint32Array(64);

  /** SHA-256 of one block (message must be <= 55 bytes). Returns 8 words. */
  function sha256Block(bytes, len, out) {
    var block = new Uint8Array(64);
    block.set(bytes.subarray(0, len));
    block[len] = 0x80;
    var bitLen = len * 8;
    block[62] = (bitLen >>> 8) & 0xff;
    block[63] = bitLen & 0xff;
    var i;
    for (i = 0; i < 16; i++) {
      W[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3];
    }
    for (i = 16; i < 64; i++) {
      var w15 = W[i - 15], w2 = W[i - 2];
      var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    var a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a;
    var e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19;
    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    out[0] = (a + 0x6a09e667) | 0; out[1] = (b + 0xbb67ae85) | 0;
    out[2] = (c + 0x3c6ef372) | 0;  out[3] = (d + 0xa54ff53a) | 0;
    out[4] = (e + 0x510e527f) | 0;  out[5] = (f + 0x9b05688c) | 0;
    out[6] = (g + 0x1f83d9ab) | 0;  out[7] = (h + 0x5be0cd19) | 0;
    return out;
  }

  /** Leading zero bits of the first word(s) of a hash. */
  function zeroBits(words) {
    var bits = 0;
    for (var i = 0; i < 8; i++) {
      var w = words[i] >>> 0;
      if (w === 0) { bits += 32; continue; }
      return bits + Math.clz32(w);
    }
    return bits;
  }

  function solve(nonce, difficulty, start, stride, report) {
    var prefix = nonce + ':';
    var buf = new Uint8Array(64);
    var out = new Int32Array(8);
    var p = prefix.length, i;
    for (i = 0; i < p; i++) buf[i] = prefix.charCodeAt(i);
    var counter = start;
    for (;;) {
      var s = String(counter);
      var len = p + s.length;
      for (i = 0; i < s.length; i++) buf[p + i] = s.charCodeAt(i);
      sha256Block(buf, len, out);
      if (zeroBits(out) >= difficulty) return counter;
      counter += stride;
      if (report && (counter - start) % (stride * 40000) === 0) report(counter);
    }
  }

  if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof module === 'undefined') {
    self.addEventListener('message', function (ev) {
      var m = ev.data;
      var counter = solve(m.n, m.difficulty, m.start, m.stride, function (c) {
        self.postMessage({ progress: c });
      });
      self.postMessage({ counter: counter });
    });
  }
  if (typeof module !== 'undefined') module.exports = { sha256Block: sha256Block, zeroBits: zeroBits, solve: solve };
})();
