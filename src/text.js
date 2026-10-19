// shared text cleanup for anything people type
// control chars + bidi tricks get stripped. U+200D (zero width joiner) is kept on purpose,
// otherwise emojis like the family / job ones fall apart into separate pieces.
const JUNK = /[\u0000-\u0008\u000B-\u001F\u007F\u200B\u200C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** message text: newlines allowed, everything else trimmed */
function cleanText(raw) {
  return String(raw).replace(JUNK, '').trim();
}

/** single line stuff (names, labels): newlines/tabs become spaces */
function cleanLine(raw, max) {
  const s = String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').replace(JUNK, '').replace(/\s+/g, ' ').trim();
  return max ? Array.from(s).slice(0, max).join('') : s;
}

/** multi line stuff (bios): keeps line breaks but caps how many */
function cleanBlock(raw, max, maxLines = 8) {
  const s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(JUNK, '');
  const lines = s.split('\n').map((l) => l.replace(/ +/g, ' ').trimEnd()).slice(0, maxLines);
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return max ? Array.from(out).slice(0, max).join('') : out;
}

/** length in characters people would count (emoji = 1, not 2) */
const charLen = (s) => Array.from(String(s)).length;

module.exports = { cleanText, cleanLine, cleanBlock, charLen };
