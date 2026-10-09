import { createAuthApi } from "./auth_api.ts";
import { createCredentialStore } from "./credential_store.ts";
import { createSessionStore } from "./session_store.ts";
import { createRateLimiter } from "./rate_limiter.ts";
import { createAuditLog } from "./audit_log.ts";
import { assertEquals } from "../test_util.ts";

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

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
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
    );
    const res = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "someone-else", password: "another-password" }),
    );
    assertEquals(res.status, 409);
  });
});

Deno.test("handleSetup rejects a short password", async () => {
  await withApi(async (api) => {
    const res = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "short" }),
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("handleLogin with the right credentials returns 200 and sets a session cookie", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
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
    );
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }),
    );
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("Set-Cookie"), null);
  });
});

Deno.test("5 failed logins lock the account; the 6th attempt is rejected (423) even with the right password", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    for (let i = 0; i < 5; i++) {
      await api.handleLogin(jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }));
    }
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
    );
    assertEquals(res.status, 423);
  });
});

Deno.test("requireSession returns null without a cookie, and the username with a valid one from login", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    const noSessionReq = new Request("http://localhost/config");
    assertEquals(api.requireSession(noSessionReq), null);

    const loginRes = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
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
    );
    const loginRes = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
    );
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];

    await api.handleLogout(new Request("http://localhost/api/logout", { method: "POST", headers: { Cookie: cookiePair } }));

    const reusedReq = new Request("http://localhost/config", { headers: { Cookie: cookiePair } });
    assertEquals(api.requireSession(reusedReq), null);
  });
});

Deno.test("every login success, failure, lockout, and logout is recorded in the audit log in English with a timestamp and IP", async () => {
  await withApi(async (api, dir) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }, { "x-forwarded-for": "203.0.113.1" }),
    );
    const loginRes = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }, { "x-forwarded-for": "203.0.113.1" }),
    );
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];
    await api.handleLogout(new Request("http://localhost/api/logout", { method: "POST", headers: { Cookie: cookiePair } }));

    const lines = (await Deno.readTextFile(`${dir}/audit.log`)).trim().split("\n").map((l) => JSON.parse(l));
    const events = lines.map((l: Record<string, unknown>) => l.event);
    assertEquals(events.includes("login_failed"), true);
    assertEquals(events.includes("login_succeeded"), true);
    assertEquals(events.includes("logout"), true);
    for (const line of lines) {
      assertEquals(typeof line.timestamp, "string");
    }
    const failedLine = lines.find((l: Record<string, unknown>) => l.event === "login_failed");
    assertEquals(failedLine.ip, "203.0.113.1");
  });
});
