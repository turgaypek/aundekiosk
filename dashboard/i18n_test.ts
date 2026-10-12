import { resolveString, detectInitialLanguage } from "./public/i18n.js";
import { assertEquals } from "./test_util.ts";

const catalogs = {
  tr: { greeting: "Merhaba", onlyTr: "sadece-tr" },
  en: { greeting: "Hello", onlyEn: "only-en" },
  de: { greeting: "Hallo" },
};

Deno.test("resolveString returns the value for the requested language", () => {
  assertEquals(resolveString(catalogs, "de", "greeting"), "Hallo");
});

Deno.test("resolveString falls back to English when the key is missing in the requested language", () => {
  assertEquals(resolveString(catalogs, "de", "onlyEn"), "only-en");
});

Deno.test("resolveString falls back to the key itself when missing everywhere", () => {
  assertEquals(resolveString(catalogs, "de", "missingEverywhere"), "missingEverywhere");
});

const templatedCatalogs = {
  tr: { week_label: "{n}. Hafta" },
  en: { week_label: "Week {n}" },
};

Deno.test("resolveString substitutes a {param} placeholder when params are given", () => {
  assertEquals(resolveString(templatedCatalogs, "tr", "week_label", { n: 42 }), "42. Hafta");
  assertEquals(resolveString(templatedCatalogs, "en", "week_label", { n: 42 }), "Week 42");
});

Deno.test("resolveString leaves a placeholder untouched when no matching param is given", () => {
  assertEquals(resolveString(templatedCatalogs, "tr", "week_label", {}), "{n}. Hafta");
});

Deno.test("resolveString without params returns the raw template, placeholder included", () => {
  assertEquals(resolveString(templatedCatalogs, "tr", "week_label"), "{n}. Hafta");
});

Deno.test("detectInitialLanguage uses the stored language when supported", () => {
  assertEquals(detectInitialLanguage("de", ["tr", "en", "de"], "tr"), "de");
});

Deno.test("detectInitialLanguage falls back to the default when stored language is unsupported or missing", () => {
  assertEquals(detectInitialLanguage("fr", ["tr", "en", "de"], "tr"), "tr");
  assertEquals(detectInitialLanguage(null, ["tr", "en", "de"], "tr"), "tr");
});
