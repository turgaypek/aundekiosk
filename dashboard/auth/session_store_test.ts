import { createSessionStore } from "./session_store.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("createSession with viewer role — touch returns viewer role", () => {
  const store = createSessionStore({ idleTimeoutMs: 60_000 });
  const token = store.createSession("alice", "viewer");
  const session = store.touch(token);
  assertEquals(session?.username, "alice");
  assertEquals(session?.role, "viewer");
});

Deno.test("createSession with admin role — touch returns admin role", () => {
  const store = createSessionStore({ idleTimeoutMs: 60_000 });
  const token = store.createSession("bob", "admin");
  assertEquals(store.touch(token)?.role, "admin");
});

Deno.test("touch returns null for an expired session", () => {
  const store = createSessionStore({ idleTimeoutMs: 1_000 });
  const token = store.createSession("charlie", "admin", 0);
  assertEquals(store.touch(token, 2_000), null);
});
