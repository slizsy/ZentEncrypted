// On-device translation via the browser's Translator API. No cloud fallback.
const Translate = (() => {
  const LANGS = [
    ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'],
    ['it', 'Italiano'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['ru', 'Русский'],
    ['uk', 'Українська'], ['ar', 'العربية'], ['hi', 'हिन्दी'], ['ja', '日本語'], ['ko', '한국어'],
    ['zh', '中文'], ['vi', 'Tiếng Việt'], ['id', 'Bahasa Indonesia'],
  ];

  const supported = () => typeof self.Translator !== 'undefined' && typeof self.LanguageDetector !== 'undefined';
  const base = (tag) => String(tag || '').toLowerCase().split('-')[0];

  let detector = null;
  const translators = new Map();

  async function detect(text) {
    if (!supported()) return null;
    try {
      if (!detector) detector = await self.LanguageDetector.create();
      const results = await detector.detect(text);
      const top = results && results[0];
      return top && top.confidence >= 0.6 && top.detectedLanguage !== 'und' ? base(top.detectedLanguage) : null;
    } catch {
      return null;
    }
  }

  /**
   * status: 'ok' | 'same' | 'skip' | 'needs-download' | 'unavailable' | 'error'
   * `gesture` must be true when called from a click (language packs may need a download).
   */
  async function run(text, target, { gesture = false } = {}) {
    if (!supported()) return { status: 'unavailable' };
    if (typeof text !== 'string' || text.trim().length < 4 || !/\p{L}/u.test(text)) return { status: 'skip' };
    const from = await detect(text);
    if (!from) return { status: 'skip' };
    if (from === base(target)) return { status: 'same', from };
    const key = `${from}>${target}`;
    try {
      let t = translators.get(key);
      if (!t) {
        const avail = await self.Translator.availability({ sourceLanguage: from, targetLanguage: target });
        if (avail === 'unavailable') return { status: 'unavailable', from };
        if (avail !== 'available' && !gesture) return { status: 'needs-download', from };
        t = await self.Translator.create({ sourceLanguage: from, targetLanguage: target });
        translators.set(key, t);
      }
      return { status: 'ok', from, text: await t.translate(text) };
    } catch (e) {
      if (e && e.name === 'NotAllowedError') return { status: 'needs-download', from };
      return { status: 'error', from };
    }
  }

  const label = (code) => (LANGS.find((l) => l[0] === code) || [code, code])[1];

  return { LANGS, supported, run, label, base };
})();
