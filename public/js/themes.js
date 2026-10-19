// Built-in themes and the custom theme (shareable as a ZT1. code).
const Themes = (() => {
  const PRESETS = {
    graphite: { label: 'Graphite', bg: '#161513', panel: '#1f1e1b', ink: '#e8e3d8', accent: '#e2b45c', hot: '#d4574e', radius: '3px',  shadow: 'hard', mono: false, scan: false },
    signal:   { label: 'Signal',   bg: '#0e0f0c', panel: '#171914', ink: '#ece8dc', accent: '#c6ff3d', hot: '#ff5c39', radius: '2px',  shadow: 'hard', mono: false, scan: false },
    paper:    { label: 'Paper',    bg: '#e9e2d0', panel: '#f6f1e3', ink: '#1c1b17', accent: '#e4402a', hot: '#1f4fd8', radius: '2px',  shadow: 'hard', mono: false, scan: false },
    ember:    { label: 'Ember',    bg: '#140b08', panel: '#20130d', ink: '#f4e3d3', accent: '#ff8a1f', hot: '#ff3d5a', radius: '3px',  shadow: 'hard', mono: false, scan: false },
    glacier:  { label: 'Glacier',  bg: '#0a1218', panel: '#111e28', ink: '#dcecf5', accent: '#5fe0ff', hot: '#ff6b9a', radius: '8px',  shadow: 'soft', mono: false, scan: false },
    phosphor: { label: 'Phosphor', bg: '#020a04', panel: '#06150a', ink: '#8dff9c', accent: '#39ff6a', hot: '#ffd23f', radius: '0px',  shadow: 'hard', mono: true,  scan: true  },
    riso:     { label: 'Riso',     bg: '#f4e4ea', panel: '#fff6f9', ink: '#1d1b4a', accent: '#ff4f9a', hot: '#1f6bff', radius: '0px',  shadow: 'hard', mono: false, scan: false },
    oled:     { label: 'Oled',     bg: '#000000', panel: '#0b0b0b', ink: '#f2f2f2', accent: '#ffffff', hot: '#ff4d4d', radius: '3px',  shadow: 'none', mono: false, scan: false },
  };
  const CUSTOM_KEY = 'zent_custom_theme';
  const HEX = /^#[0-9a-f]{6}$/i;
  const RADII = ['0px', '3px', '8px', '16px'];
  const SHADOWS = ['hard', 'soft', 'none'];

  const SHADOW_CSS = {
    hard: ['4px 4px 0 0 var(--line-strong)', '2px 2px 0 0 var(--line-strong)'],
    soft: ['0 14px 30px -14px rgba(0,0,0,.55)', '0 6px 14px -8px rgba(0,0,0,.5)'],
    none: ['0 0 0 0 transparent', '0 0 0 0 transparent'],
  };

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  const isDark = (hex) => luminance(hex) < 0.35;
  // pick whichever of near-black / white has more contrast on this colour
  const inkOn = (hex) => { const L = luminance(hex); return (L + 0.05) / 0.0545 >= 1.05 / (L + 0.05) ? '#0c0c0a' : '#ffffff'; };

  function sanitize(t) {
    if (!t || typeof t !== 'object') return null;
    for (const k of ['bg', 'panel', 'ink', 'accent', 'hot']) if (typeof t[k] !== 'string' || !HEX.test(t[k])) return null;
    return {
      label: 'Custom',
      bg: t.bg.toLowerCase(), panel: t.panel.toLowerCase(), ink: t.ink.toLowerCase(),
      accent: t.accent.toLowerCase(), hot: t.hot.toLowerCase(),
      radius: RADII.includes(t.radius) ? t.radius : '2px',
      shadow: SHADOWS.includes(t.shadow) ? t.shadow : 'hard',
      mono: !!t.mono, scan: false,
    };
  }

  const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

  function exportCode(t) {
    const c = sanitize(t);
    if (!c) return null;
    const { bg, panel, ink, accent, hot, radius, shadow, mono } = c;
    return 'ZT1.' + b64url(JSON.stringify({ bg, panel, ink, accent, hot, radius, shadow, mono }));
  }

  function importCode(code) {
    try {
      const m = String(code).trim().match(/^ZT1\.([A-Za-z0-9_-]+)$/);
      if (!m) return null;
      return sanitize(JSON.parse(unb64url(m[1])));
    } catch {
      return null;
    }
  }

  function getCustom() {
    try {
      return sanitize(JSON.parse(localStorage.getItem(CUSTOM_KEY))) || { ...PRESETS.signal, label: 'Custom' };
    } catch {
      return { ...PRESETS.signal, label: 'Custom' };
    }
  }
  function saveCustom(t) {
    const c = sanitize(t);
    if (!c) return null;
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(c)); } catch { /* ignore */ }
    return c;
  }

  /** Applies a theme by name ('signal', …, 'custom') to the page. */
  function apply(name) {
    const t = name === 'custom' ? getCustom() : PRESETS[name] || PRESETS.graphite;
    const root = document.documentElement;
    const set = (k, v) => root.style.setProperty(k, v);
    set('--bg', t.bg); set('--panel', t.panel); set('--ink', t.ink);
    set('--accent', t.accent); set('--accent-ink', inkOn(t.accent)); set('--hot', t.hot);
    set('--radius', t.radius);
    set('--shadow', SHADOW_CSS[t.shadow][0]); set('--shadow-sm', SHADOW_CSS[t.shadow][1]);
    set('--name-l', isDark(t.bg) ? '70%' : '36%');
    set('--grain', isDark(t.bg) ? '0.07' : '0.10');
    root.dataset.theme = name in PRESETS || name === 'custom' ? name : 'graphite';
    root.dataset.scan = t.scan ? '1' : '0';
    root.dataset.mono = t.mono ? '1' : '0';
    root.style.colorScheme = isDark(t.bg) ? 'dark' : 'light';
    const meta = document.getElementById('meta-theme');
    if (meta) meta.setAttribute('content', t.bg);
    return t;
  }

  return { PRESETS, apply, getCustom, saveCustom, exportCode, importCode, sanitize, isDark, inkOn };
})();
