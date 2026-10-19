// Device-local settings.
const Settings = (() => {
  const KEY = 'zent_settings_v2';
  const defaults = {
    theme: 'graphite',
    sound: true,
    hour24: false,
    compact: false,
    motion: true,
    fontScale: 100,
    boot: false,
    translate: false,
    translateTo: 'en',
    rememberRooms: true,
    wipeOnClose: false,
    blurOnHide: false,
  };
  let data = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const k of Object.keys(defaults)) if (typeof saved[k] === typeof defaults[k]) data[k] = saved[k];
  } catch { /* storage unavailable or corrupted: fall back to defaults */ }

  const listeners = new Set();
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* private mode */ }
  };

  return {
    get: (k) => data[k],
    all: () => ({ ...data }),
    set(k, v) {
      if (!(k in defaults) || typeof v !== typeof defaults[k]) return;
      data[k] = v;
      persist();
      listeners.forEach((fn) => fn(k, v));
    },
    onChange: (fn) => listeners.add(fn),
    defaults,
  };
})();
