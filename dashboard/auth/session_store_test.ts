import { createSessionStore } from "./session_store.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("touch returns the username for a freshly created session", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const token = store.createSession("admin", 1000);
  assertEquals(store.touch(token, 1000)?.username, "admin");
});

Deno.test("touch returns null for an unknown token", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  assertEquals(store.touch("not-a-real-token"), null);
});

Deno.test("touch returns null once the session has been idle past the timeout", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const token = store.createSession("admin", 1000);
  const idleCutoff = 1000 + 30 * 60_000 + 1;
  assertEquals(store.touch(token, idleCutoff), null);
});

Deno.test("touch within the timeout keeps the session alive for a later touch at the same relative gap", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const token = store.createSession("admin", 1000);
  // Touch twice, each time within the idle window of the *previous* touch,
  // proving activity resets the idle clock rather than the original
  // creation time being the only thing that matters.
  assertEquals(store.touch(token, 1000 + 20 * 60_000) !== null, true);
  assertEquals(store.touch(token, 1000 + 20 * 60_000 + 20 * 60_000) !== null, true);
});

Deno.test("destroy invalidates the session immediately", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const token = store.createSession("admin", 1000);
  store.destroy(token);
  assertEquals(store.touch(token, 1000), null);
});

Deno.test("two sessions get two different tokens", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const a = store.createSession("admin", 1000);
  const b = store.createSession("admin", 1000);
  assertEquals(a === b, false);
});
