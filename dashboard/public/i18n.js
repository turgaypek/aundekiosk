// i18n.js — minimal locale resolution, no framework dependency.
// resolveString/detectInitialLanguage have no DOM dependency so Deno can
// import and test them directly; the bootstrap code below only runs in a
// real browser (guarded by the `document`/`window` check at the bottom).

export function resolveString(catalogs, lang, key) {
  const primary = catalogs[lang];
  if (primary && Object.prototype.hasOwnProperty.call(primary, key)) {
    return primary[key];
  }
  const fallback = catalogs.en;
  if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) {
    return fallback[key];
  }
  return key;
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

  function applyLanguage(nextLang) {
    lang = nextLang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = resolveString(catalogs, lang, el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", resolveString(catalogs, lang, el.getAttribute("data-i18n-placeholder")));
    });
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
  applyLanguage(lang);
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrapI18n();
}
