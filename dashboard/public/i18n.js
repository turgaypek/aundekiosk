// i18n.js — minimal locale resolution, no framework dependency.
// resolveString/detectInitialLanguage have no DOM dependency so Deno can
// import and test them directly; the bootstrap code below only runs in a
// real browser (guarded by the `document`/`window` check at the bottom).

export function resolveString(catalogs, lang, key, params) {
  const primary = catalogs[lang];
  let template;
  if (primary && Object.prototype.hasOwnProperty.call(primary, key)) {
    template = primary[key];
  } else {
    const fallback = catalogs.en;
    template = fallback && Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : key;
  }
  if (!params) return template;
  // Languages order a value differently inside a sentence (TR "{n}.
  // Hafta" vs EN "Week {n}"), so callers can't just concatenate a
  // prefix/suffix string — the placeholder lives inside the translated
  // template itself.
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function detectInitialLanguage(storedLang, supportedLangs, defaultLang) {
  if (storedLang && supportedLangs.includes(storedLang)) {
    return storedLang;
  }
  return defaultLang;
}

const SUPPORTED_LANGS = ["tr", "en", "de"];
const DEFAULT_LANG = "tr";

async function bootstrapI18n() {
  const catalogs = {};
  for (const lang of SUPPORTED_LANGS) {
    const res = await fetch(`locales/${lang}.json`);
    catalogs[lang] = await res.json();
  }

  let storedLang = null;
  try {
    storedLang = localStorage.getItem("aundekiosk_lang");
  } catch {
    // localStorage unavailable (private mode etc.) — just start from default.
  }
  let lang = detectInitialLanguage(storedLang, SUPPORTED_LANGS, DEFAULT_LANG);

  // Scans `root` (and root itself, if it carries the attribute) for
  // data-i18n/data-i18n-placeholder — same rules applyLanguage uses for
  // the whole document, but callable on a smaller subtree too. Needed
  // because content cloned out of a <template> (URL rows, service rows,
  // monitor tier rows) is created well after the page's one-time initial
  // scan below, and never gets touched by it otherwise.
  function translateSubtree(root) {
    const textTargets = root.matches?.("[data-i18n]") ? [root] : [];
    textTargets.push(...root.querySelectorAll("[data-i18n]"));
    textTargets.forEach((el) => {
      el.textContent = resolveString(catalogs, lang, el.getAttribute("data-i18n"));
    });
    const placeholderTargets = root.matches?.("[data-i18n-placeholder]") ? [root] : [];
    placeholderTargets.push(...root.querySelectorAll("[data-i18n-placeholder]"));
    placeholderTargets.forEach((el) => {
      el.setAttribute("placeholder", resolveString(catalogs, lang, el.getAttribute("data-i18n-placeholder")));
    });
  }

  function applyLanguage(nextLang) {
    lang = nextLang;
    translateSubtree(document.documentElement);
    const switcher = document.getElementById("lang-switch");
    if (switcher) switcher.value = lang;
    try {
      localStorage.setItem("aundekiosk_lang", lang);
    } catch {
      // Language choice just won't persist across reloads — safe fallback.
    }
  }

  const switcher = document.getElementById("lang-switch");
  if (switcher) {
    switcher.addEventListener("change", (e) => applyLanguage(e.target.value));
  }

  window.aundekiosk = window.aundekiosk || {};
  window.aundekiosk.setLanguage = applyLanguage;
  // Exposed for scripts (script.js's service-control confirm()/prompt()
  // dialogs) that need a translated string outside the data-i18n
  // attribute scan above — e.g. text handed to a native browser dialog,
  // which has no DOM node of its own to tag.
  window.aundekiosk.t = (key, params) => resolveString(catalogs, lang, key, params);
  // For render functions that clone a <template> row (URL rows, service
  // rows, monitor tier rows): call this on the freshly-cloned element
  // once, instead of hand-translating each field with window.aundekiosk.t().
  window.aundekiosk.translateSubtree = translateSubtree;
  applyLanguage(lang);
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrapI18n();
}
