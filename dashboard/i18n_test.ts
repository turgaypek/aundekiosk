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

Deno.test("detectInitialLanguage uses the stored language when supported", () => {
  assertEquals(detectInitialLanguage("de", ["tr", "en", "de"], "tr"), "de");
});

Deno.test("detectInitialLanguage falls back to the default when stored language is unsupported or missing", () => {
  assertEquals(detectInitialLanguage("fr", ["tr", "en", "de"], "tr"), "tr");
  assertEquals(detectInitialLanguage(null, ["tr", "en", "de"], "tr"), "tr");
});
