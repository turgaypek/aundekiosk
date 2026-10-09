import { decideUiState } from "./public/auth.js";
import { assertEquals } from "./test_util.ts";

Deno.test("shows setup when no admin exists yet", () => {
  assertEquals(decideUiState(false, false), "setup");
});

Deno.test("shows login when an admin exists but the session is not authenticated", () => {
  assertEquals(decideUiState(true, false), "login");
});

Deno.test("shows the app once an admin exists and the session is authenticated", () => {
  assertEquals(decideUiState(true, true), "app");
});

Deno.test("setup takes priority even if (inconsistently) authenticated is true with no admin", () => {
  assertEquals(decideUiState(false, true), "setup");
});
