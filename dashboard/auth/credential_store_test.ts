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

Deno.test("concurrent wrong-password attempts are serialized, so the account locks at exactly 5 failures, not never", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");

    const now = 3_000_000;
    // Fire 10 wrong-password attempts "at once" (as concurrently-pending
    // promises). Without serializing the read-check-write cycle inside the
    // store, each one reads the record before any of the others' writes
    // land, so the failure count undercounts and the account never locks.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.verifyCredentials("admin", "wrong-password", now)),
    );
    const invalidCount = results.filter((r) => r.outcome === "invalid").length;
    const lockedCount = results.filter((r) => r.outcome === "locked").length;
    assertEquals(invalidCount, 5);
    assertEquals(lockedCount, 5);

    const correctWhileLocked = await store.verifyCredentials("admin", "a-long-enough-password", now);
    assertEquals(correctWhileLocked.outcome, "locked");
  });
});

Deno.test("concurrent createInitialAdmin calls: exactly one succeeds, the other is rejected", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    const results = await Promise.allSettled([
      store.createInitialAdmin("first", "a-long-enough-password"),
      store.createInitialAdmin("second", "another-long-password"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assertEquals(fulfilled.length, 1);
    assertEquals(rejected.length, 1);
  });
});

// --- multi-user (createUser / listUsers / deleteUser) ---

Deno.test("createUser adds a second account that can log in independently", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    await store.createUser("ayse", "another-long-password", "ayse@aundeteknik.com");

    const first = await store.verifyCredentials("admin", "a-long-enough-password");
    assertEquals(first.outcome, "success");
    const second = await store.verifyCredentials("ayse", "another-long-password");
    assertEquals(second.outcome, "success");
  });
});

Deno.test("createUser refuses a username that already exists", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    let threw = false;
    try {
      await store.createUser("admin", "another-long-password", null);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  });
});

Deno.test("createUser before any admin exists creates the first account (same effect as createInitialAdmin)", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createUser("admin", "a-long-enough-password", "admin@aundeteknik.com");
    assertEquals(await store.hasAdmin(), true);
    const result = await store.verifyCredentials("admin", "a-long-enough-password");
    assertEquals(result.outcome, "success");
  });
});

Deno.test("listUsers returns every account's username and email, never a password hash", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    await store.createUser("ayse", "another-long-password", "ayse@aundeteknik.com");

    const users = await store.listUsers();
    assertEquals(users.length, 2);
    assertEquals(JSON.stringify(users.map((u) => u.username).sort()), JSON.stringify(["admin", "ayse"]));
    const ayse = users.find((u) => u.username === "ayse");
    assertEquals(ayse?.email, "ayse@aundeteknik.com");
    assertEquals((ayse as unknown as Record<string, unknown>).passwordHash, undefined);
  });
});

Deno.test("deleteUser removes an account, which can then no longer log in", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    await store.createUser("ayse", "another-long-password", null);

    await store.deleteUser("ayse");
    const users = await store.listUsers();
    assertEquals(users.length, 1);
    const result = await store.verifyCredentials("ayse", "another-long-password");
    assertEquals(result.outcome, "invalid");
  });
});

Deno.test("deleteUser refuses to remove the last remaining account", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    let threw = false;
    try {
      await store.deleteUser("admin");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(await store.hasAdmin(), true);
  });
});

Deno.test("each user has an independent lockout counter — locking one account doesn't affect another", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    await store.createUser("ayse", "another-long-password", null);

    const now = 5_000_000;
    for (let i = 0; i < 5; i++) {
      await store.verifyCredentials("admin", "wrong-password", now);
    }
    const adminResult = await store.verifyCredentials("admin", "a-long-enough-password", now);
    assertEquals(adminResult.outcome, "locked");

    const ayseResult = await store.verifyCredentials("ayse", "another-long-password", now);
    assertEquals(ayseResult.outcome, "success");
  });
});

// --- migration from the old single-admin file format ---

Deno.test("reads an old single-admin-format file (no 'users' wrapper) and treats it as that one user", async () => {
  await withTempStore(async (storePath) => {
    // The exact shape createInitialAdmin wrote before multi-user support:
    // a bare record, not wrapped in { users: [...] }.
    const { hashPassword } = await import("./password.ts");
    const passwordHash = await hashPassword("a-long-enough-password");
    await Deno.writeTextFile(
      storePath,
      JSON.stringify({ username: "admin", passwordHash, failedAttempts: 0, lockedUntil: null }),
    );

    const store = createCredentialStore({ storePath });
    assertEquals(await store.hasAdmin(), true);
    const result = await store.verifyCredentials("admin", "a-long-enough-password");
    assertEquals(result.outcome, "success");
    const users = await store.listUsers();
    assertEquals(users.length, 1);
    assertEquals(users[0].username, "admin");
  });
});

Deno.test("an old-format file upgrades to the multi-user format on disk the first time a user is added", async () => {
  await withTempStore(async (storePath) => {
    const { hashPassword } = await import("./password.ts");
    const passwordHash = await hashPassword("a-long-enough-password");
    await Deno.writeTextFile(
      storePath,
      JSON.stringify({ username: "admin", passwordHash, failedAttempts: 0, lockedUntil: null }),
    );

    const store = createCredentialStore({ storePath });
    await store.createUser("ayse", "another-long-password", null);

    const onDisk = JSON.parse(await Deno.readTextFile(storePath));
    assertEquals(Array.isArray(onDisk.users), true);
    assertEquals(onDisk.users.length, 2);

    // A second store instance, reading the now-upgraded file fresh, must
    // still find the original admin account intact.
    const store2 = createCredentialStore({ storePath });
    const result = await store2.verifyCredentials("admin", "a-long-enough-password");
    assertEquals(result.outcome, "success");
  });
});

Deno.test("resetPassword changes the password hash so the new password logs in and the old one no longer does", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "the-old-password");

    await store.resetPassword("admin", "the-new-password-123");

    const withNew = await store.verifyCredentials("admin", "the-new-password-123");
    assertEquals(withNew.outcome, "success");

    const withOld = await store.verifyCredentials("admin", "the-old-password");
    assertEquals(withOld.outcome, "invalid");
  });
});

Deno.test("resetPassword clears a lockout, so a previously locked-out user can log in immediately with the new password", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "the-old-password");

    const now = 5_000_000;
    for (let i = 0; i < 5; i++) {
      await store.verifyCredentials("admin", "wrong-password", now);
    }
    const lockedCheck = await store.verifyCredentials("admin", "the-old-password", now);
    assertEquals(lockedCheck.outcome, "locked");

    await store.resetPassword("admin", "the-new-password-123");

    const afterReset = await store.verifyCredentials("admin", "the-new-password-123", now);
    assertEquals(afterReset.outcome, "success");
  });
});

Deno.test("resetPassword on a username that doesn't exist throws, without touching any other account", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "the-old-password");

    let threw = false;
    try {
      await store.resetPassword("nobody", "the-new-password-123");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);

    const stillWorks = await store.verifyCredentials("admin", "the-old-password");
    assertEquals(stillWorks.outcome, "success");
  });
});

Deno.test("a failed attempt that crosses the lockout threshold reports justLocked:true, and earlier ones report false", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");

    const now = 4_000_000;
    for (let i = 0; i < 4; i++) {
      const result = await store.verifyCredentials("admin", "wrong-password", now);
      if (result.outcome !== "invalid") throw new Error("unreachable");
      assertEquals(result.justLocked, false);
    }
    const fifth = await store.verifyCredentials("admin", "wrong-password", now);
    if (fifth.outcome !== "invalid") throw new Error("unreachable");
    assertEquals(fifth.justLocked, true);
  });
});
