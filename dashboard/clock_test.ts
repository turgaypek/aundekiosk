import { getIsoWeek } from "./public/clock.js";
import { assertEquals } from "./test_util.ts";

// ISO 8601: weeks run Monday-Sunday, week 1 is the week containing the
// year's first Thursday. Dates are constructed as local midnight, which
// is what `new Date()` in the browser gives the live clock — getIsoWeek
// itself works in UTC internally so a local-timezone offset can never
// shift a date across the Thursday boundary.

Deno.test("getIsoWeek returns 1 for January 4th (always in week 1 by definition)", () => {
  assertEquals(getIsoWeek(new Date(2026, 0, 4)), 1);
});

Deno.test("getIsoWeek returns 42 for October 12, 2026 (a plain Monday)", () => {
  assertEquals(getIsoWeek(new Date(2026, 9, 12)), 42);
});

Deno.test("getIsoWeek rolls December 31st into week 1 of the next year when it falls early in that week", () => {
  // Dec 31, 2025 is a Wednesday; ISO week 1 of 2026 starts Mon Dec 29, 2025.
  assertEquals(getIsoWeek(new Date(2025, 11, 31)), 1);
});

Deno.test("getIsoWeek keeps January 1st in the previous year's last week when the new year starts midweek", () => {
  // Jan 1, 2027 is a Friday, so it belongs to ISO week 53 of 2026.
  assertEquals(getIsoWeek(new Date(2027, 0, 1)), 53);
});

Deno.test("getIsoWeek returns 1 for a Monday starting the year cleanly", () => {
  // Jan 1, 2024 is a Monday -> week 1.
  assertEquals(getIsoWeek(new Date(2024, 0, 1)), 1);
});
