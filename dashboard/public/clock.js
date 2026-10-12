// clock.js — live date/time/week-number display in the navbar.
// getIsoWeek is pure (no DOM dependency) so Deno can import and test it
// directly; the DOM wiring below only runs in a real browser (guarded by
// the `document`/`window` check at the bottom), like i18n.js/script.js.

// ISO 8601 week number: weeks run Monday-Sunday, and week 1 is the week
// containing the year's first Thursday. Runs entirely in UTC internally
// so the caller's local timezone offset can never shift a date across
// the Thursday boundary.
export function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Sunday (0) -> 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

const LOCALE_BY_LANG = { tr: "tr-TR", en: "en-US", de: "de-DE" };

function startClock() {
  const el = document.getElementById("live-clock");
  if (!el) return;

  function tick() {
    // i18n.js keeps #lang-switch's value in sync with the active
    // language on every switch; document.documentElement.lang is never
    // updated after the initial static "tr" in the HTML, so reading
    // that would silently ignore a language change.
    const lang = document.getElementById("lang-switch")?.value || "tr";
    const locale = LOCALE_BY_LANG[lang] || lang;
    const now = new Date();
    const datePart = new Intl.DateTimeFormat(locale, { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now);
    const timePart = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(now);
    const weekLabel = window.aundekiosk?.t?.("clock_week_label", { n: getIsoWeek(now) }) ?? `${getIsoWeek(now)}`;
    el.textContent = `${datePart} · ${timePart} · ${weekLabel}`;
  }

  tick();
  setInterval(tick, 1000);
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  startClock();
}
