// Password hashing with Node's built-in scrypt. Old bcrypt hashes are still
// accepted once and upgraded on the next successful sign-in.
const crypto = require('crypto');
const bcryptjs = require('bcryptjs');

const N = 1 << 15, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 96 * 1024 * 1024;

const scrypt = (pw, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))));

async function hash(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verify(pw, stored) {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, salt, key] = stored.split('$');
    if (+n !== N || +r !== R || +p !== P) return false;
    const expected = Buffer.from(key, 'base64');
    const got = await scrypt(pw, Buffer.from(salt, 'base64'));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }
  if (/^\$2[aby]\$/.test(stored)) return bcryptjs.compare(pw, stored);
  return false;
}

const needsUpgrade = (stored) => typeof stored === 'string' && !stored.startsWith('scrypt$');

// Small list of the passwords attackers try first.
const COMMON = new Set(`password password1 password12 password123 passw0rd 12345678 123456789 1234567890 11111111 00000000
12341234 87654321 qwertyui qwerty123 qwertyuiop 1q2w3e4r 1qaz2wsx zaq12wsx asdfghjkl iloveyou sunshine princess
football baseball basketball superman batman starwars whatever trustno1 letmein1 welcome1 welcome123 admin123
administrator changeme monkey123 dragon123 master123 shadow123 michael1 jennifer computer internet abc12345 abcd1234
aaaaaaaa zxcvbnm1 zxcvbnmm minecraft fortnite roblox123 pokemon1 chocolate butterfly freedom1 secret123 summer2024
summer2025 summer2026 winter2025 winter2026 spring2026 autumn2026 hello123 hello1234 helloworld lovely123 qwerty12`.split(/\s+/));

function policyError(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  const low = pw.toLowerCase();
  if (COMMON.has(low)) return 'That password is too common. Pick something less guessable.';
  if (username && low.includes(String(username).toLowerCase())) return "Password can't contain your username.";
  if (/^(.)\1+$/.test(pw)) return 'Password is too easy to guess.';
  return null;
}

module.exports = { hash, verify, needsUpgrade, policyError };
