import { createCredentialStore } from "./credential_store.ts";
import { assertEquals } from "../test_util.ts";

async function withTempStore(fn: (storePath: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(`${dir}/auth.db`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("hasAdmin is false before any admin is created", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    assertEquals(await store.hasAdmin(), false);
  });
});

Deno.test("createInitialAdmin makes hasAdmin true", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    assertEquals(await store.hasAdmin(), true);
  });
});

Deno.test("createInitialAdmin refuses to run a second time", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    let threw = false;
    try {
      await store.createInitialAdmin("someone-else", "another-password");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  });
});

Deno.test("verifyCredentials reports no-admin before setup", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    const result = await store.verifyCredentials("admin", "anything");
    assertEquals(result.outcome, "no-admin");
  });
});

Deno.test("verifyCredentials succeeds with the right username and password", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const result = await store.verifyCredentials("admin", "a-long-enough-password");
    assertEquals(result.outcome, "success");
  });
});

Deno.test("verifyCredentials rejects the wrong password", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const result = await store.verifyCredentials("admin", "wrong-password");
    assertEquals(result.outcome, "invalid");
  });
});

Deno.test("verifyCredentials rejects the wrong username", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const result = await store.verifyCredentials("not-admin", "a-long-enough-password");
    assertEquals(result.outcome, "invalid");
  });
});

Deno.test("5 consecutive failures lock the account, and the 6th attempt is rejected even with the correct password", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");

    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      const result = await store.verifyCredentials("admin", "wrong-password", now);
      assertEquals(result.outcome, "invalid");
    }

    const sixth = await store.verifyCredentials("admin", "a-long-enough-password", now);
    assertEquals(sixth.outcome, "locked");
  });
});

Deno.test("after the lockout window passes, the correct password succeeds and resets the failure count", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");

    const now = 2_000_000;
    for (let i = 0; i < 5; i++) {
      await store.verifyCredentials("admin", "wrong-password", now);
    }
    const locked = await store.verifyCredentials("admin", "a-long-enough-password", now);
    assertEquals(locked.outcome, "locked");
    if (locked.outcome !== "locked") throw new Error("unreachable");

    const afterWindow = now + locked.retryAfterMs + 1;
    const result = await store.verifyCredentials("admin", "a-long-enough-password", afterWindow);
    assertEquals(result.outcome, "success");
  });
});
