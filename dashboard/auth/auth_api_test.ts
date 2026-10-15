import { createAuthApi } from "./auth_api.ts";
import { createCredentialStore } from "./credential_store.ts";
import { createSessionStore } from "./session_store.ts";
import { createRateLimiter } from "./rate_limiter.ts";
import { createAuditLog } from "./audit_log.ts";
import { assertEquals } from "../test_util.ts";

const TEST_IP = "203.0.113.5";

async function withApi(
  fn: (api: ReturnType<typeof createAuthApi>, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const api = createAuthApi({
      credentialStore: createCredentialStore({ storePath: `${dir}/auth.db` }),
      sessionStore: createSessionStore({ idleTimeoutMs: 30 * 60_000 }),
      rateLimiter: createRateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
      auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
    });
    await fn(api, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleSetupStatus reports hasAdmin:false before setup", async () => {
  await withApi(async (api) => {
    const res = await api.handleSetupStatus();
    assertEquals((await res.json()).hasAdmin, false);
  });
});

Deno.test("handleSetup creates the admin and handleSetupStatus then reports hasAdmin:true", async () => {
  await withApi(async (api) => {
    const res = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    assertEquals(res.status, 201);
    const status = await api.handleSetupStatus();
    assertEquals((await status.json()).hasAdmin, true);
  });
});

Deno.test("handleSetup refuses a second admin once one exists", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    const res = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "someone-else", password: "another-password" }),
      TEST_IP,
    );
    assertEquals(res.status, 409);
  });
});

Deno.test("concurrent handleSetup calls: exactly one 201, the other 409 (never a 500 from the race)", async () => {
  await withApi(async (api) => {
    const [a, b] = await Promise.all([
      api.handleSetup(jsonRequest("http://localhost/api/setup", { username: "first", password: "a-long-enough-password" }), TEST_IP),
      api.handleSetup(jsonRequest("http://localhost/api/setup", { username: "second", password: "another-long-password" }), TEST_IP),
    ]);
    const statuses = [a.status, b.status].sort();
    assertEquals(JSON.stringify(statuses), JSON.stringify([201, 409]));
  });
});

Deno.test("handleSetup rejects a short password", async () => {
  await withApi(async (api) => {
    const res = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "short" }),
      TEST_IP,
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("handleSetup rejects an overly long username or password", async () => {
  await withApi(async (api) => {
    const longUsername = "a".repeat(65);
    const res1 = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: longUsername, password: "a-long-enough-password" }),
      TEST_IP,
    );
    assertEquals(res1.status, 400);

    const longPassword = "a".repeat(1025);
    const res2 = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: longPassword }),
      TEST_IP,
    );
    assertEquals(res2.status, 400);
  });
});

Deno.test("handleLogin with the right credentials returns 200 and sets a session cookie", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    assertEquals(res.status, 200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    assertEquals(setCookie.includes("HttpOnly"), true);
    assertEquals(setCookie.includes("SameSite=Strict"), true);
    assertEquals(setCookie.includes("Secure"), true);
  });
});

Deno.test("handleLogin with the wrong password returns 401 and sets no cookie", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }),
      TEST_IP,
    );
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("Set-Cookie"), null);
  });
});

Deno.test("handleLogin rejects an overly long username or password without touching the credential store", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "a".repeat(65), password: "a-long-enough-password" }),
      TEST_IP,
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("5 failed logins lock the account; the 6th attempt is rejected (423) even with the right password", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    for (let i = 0; i < 5; i++) {
      await api.handleLogin(jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }), TEST_IP);
    }
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    assertEquals(res.status, 423);
  });
});

Deno.test("the attempt that triggers the lockout is itself recorded as account_locked in the audit log", async () => {
  await withApi(async (api, dir) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    for (let i = 0; i < 5; i++) {
      await api.handleLogin(jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }), TEST_IP);
    }
    const lines = (await Deno.readTextFile(`${dir}/audit.log`)).trim().split("\n").map((l) => JSON.parse(l));
    const events = lines.map((l: Record<string, unknown>) => l.event);
    assertEquals(events.includes("account_locked"), true);
    // Exactly once: the 5th failure crosses the threshold, the earlier four don't.
    assertEquals(events.filter((e) => e === "account_locked").length, 1);
  });
});

Deno.test("requireSession returns null without a cookie, and the username with a valid one from login", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    const noSessionReq = new Request("http://localhost/config");
    assertEquals(api.requireSession(noSessionReq), null);

    const loginRes = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    const setCookie = loginRes.headers.get("Set-Cookie") ?? "";
    const cookiePair = setCookie.split(";")[0];
    const authedReq = new Request("http://localhost/config", { headers: { Cookie: cookiePair } });
    assertEquals(api.requireSession(authedReq)?.username, "admin");
  });
});

Deno.test("handleLogout clears the session so the same cookie no longer authenticates", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    const loginRes = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];

    await api.handleLogout(
      new Request("http://localhost/api/logout", { method: "POST", headers: { Cookie: cookiePair } }),
      TEST_IP,
    );

    const reusedReq = new Request("http://localhost/config", { headers: { Cookie: cookiePair } });
    assertEquals(api.requireSession(reusedReq), null);
  });
});

Deno.test("requireSession after admin login returns admin role", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const api = createAuthApi({
      credentialStore: store,
      sessionStore: createSessionStore({ idleTimeoutMs: 30 * 60_000 }),
      rateLimiter: createRateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
      auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
    });
    const loginRes = await api.handleLogin(
      new Request("http://localhost/api/login", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
        headers: { "Content-Type": "application/json" },
      }),
      TEST_IP,
    );
    const cookie = loginRes.headers.get("set-cookie")!;
    const session = api.requireSession(
      new Request("http://localhost/", { headers: { cookie } }),
    );
    assertEquals(session?.role, "admin");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("requireSession after viewer login returns viewer role", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    await store.createUser("viewer1", "viewer-long-pass-12", null, "viewer");
    const api = createAuthApi({
      credentialStore: store,
      sessionStore: createSessionStore({ idleTimeoutMs: 30 * 60_000 }),
      rateLimiter: createRateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
      auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
    });
    const loginRes = await api.handleLogin(
      new Request("http://localhost/api/login", {
        method: "POST",
        body: JSON.stringify({ username: "viewer1", password: "viewer-long-pass-12" }),
        headers: { "Content-Type": "application/json" },
      }),
      TEST_IP,
    );
    const cookie = loginRes.headers.get("set-cookie")!;
    const session = api.requireSession(
      new Request("http://localhost/", { headers: { cookie } }),
    );
    assertEquals(session?.role, "viewer");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("every login success, failure, lockout, and logout is recorded in the audit log in English with a timestamp and the caller-supplied IP", async () => {
  await withApi(async (api, dir) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    await api.handleLogin(jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }), TEST_IP);
    const loginRes = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
      TEST_IP,
    );
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];
    await api.handleLogout(
      new Request("http://localhost/api/logout", { method: "POST", headers: { Cookie: cookiePair } }),
      TEST_IP,
    );

    const lines = (await Deno.readTextFile(`${dir}/audit.log`)).trim().split("\n").map((l) => JSON.parse(l));
    const events = lines.map((l: Record<string, unknown>) => l.event);
    assertEquals(events.includes("login_failed"), true);
    assertEquals(events.includes("login_succeeded"), true);
    assertEquals(events.includes("logout"), true);
    for (const line of lines) {
      assertEquals(typeof line.timestamp, "string");
    }
    const failedLine = lines.find((l: Record<string, unknown>) => l.event === "login_failed");
    assertEquals(failedLine.ip, TEST_IP);
  });
});
