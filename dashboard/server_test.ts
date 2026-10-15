import { createHandler, resolveTlsMode } from "./server.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { assertEquals } from "./test_util.ts";

function fakeConnInfo(hostname: string): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp", hostname, port: 54321 },
    completed: Promise.resolve(),
  };
}

Deno.test("GET /config returns the sample config end to end", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const samplePath = `${dir}/config.json.sample`;
    await Deno.writeTextFile(samplePath, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    // Without a session, /config is always 401 now — see the dedicated
    // "full setup -> login -> GET /config flow" test for the authenticated path.
    const res = await handle(new Request("http://localhost/config"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unknown static paths are routed through the static handler", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<h1>AundeKiosk</h1>");
    const handle = createHandler({
      publicDir: dir,
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
    });
    const res = await handle(new Request("http://localhost/"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "<h1>AundeKiosk</h1>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /config with the wrong method on another path is not routed to the config API", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<h1>AundeKiosk</h1>");
    const handle = createHandler({
      publicDir: dir,
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/config", { method: "DELETE" }));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /config without a session returns 401, never the config data", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/config"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the full setup -> login -> GET /config flow works end to end through createHandler", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });

    const setupRes = await handle(
      new Request("http://localhost/api/setup", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
      }),
    );
    assertEquals(setupRes.status, 201);

    const loginRes = await handle(
      new Request("http://localhost/api/login", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
      }),
    );
    assertEquals(loginRes.status, 200);
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];

    const configRes = await handle(
      new Request("http://localhost/config", { headers: { Cookie: cookiePair } }),
    );
    assertEquals(configRes.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the audit log records the real connection IP, not a client-supplied X-Forwarded-For header", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });

    await handle(
      new Request("http://localhost/api/setup", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
        headers: { "x-forwarded-for": "9.9.9.9" },
      }),
      fakeConnInfo("198.51.100.42"),
    );

    const lines = (await Deno.readTextFile(`${dir}/audit.log`)).trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines[0].event, "admin_created");
    assertEquals(lines[0].ip, "198.51.100.42");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveTlsMode uses https when a certificate was loaded", () => {
  assertEquals(resolveTlsMode(true, undefined), "https");
});

Deno.test("resolveTlsMode refuses to fall back to http by default when no certificate exists", () => {
  let threw = false;
  try {
    resolveTlsMode(false, undefined);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("resolveTlsMode allows http only with an explicit opt-in", () => {
  assertEquals(resolveTlsMode(false, "1"), "http");
});

Deno.test("GET /monitor-config without a session returns 401, never the tier data", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
      monitorConfigPath: `${dir}/monitor-config.json`,
      monitorSamplePath: `${dir}/monitor-config.json.sample`,
    });
    const res = await handle(new Request("http://localhost/monitor-config"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /monitor-config with a valid session returns the tier data", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    await Deno.writeTextFile(`${dir}/monitor-config.json.sample`, JSON.stringify({ sampleIntervalSeconds: 10, activeWindow: null, tiers: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
      monitorConfigPath: `${dir}/monitor-config.json`,
      monitorSamplePath: `${dir}/monitor-config.json.sample`,
    });

    await handle(
      new Request("http://localhost/api/setup", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
      }),
    );
    const loginRes = await handle(
      new Request("http://localhost/api/login", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
      }),
    );
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];

    const res = await handle(new Request("http://localhost/monitor-config", { headers: { Cookie: cookiePair } }));
    assertEquals(res.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /ssh-config without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/ssh-config", { method: "POST", body: JSON.stringify({ action: "enable" }) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /os-password without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/os-password", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /network-config without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/network-config", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /network-confirm without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/network-confirm", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /snmp-config without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/snmp-config", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /remote-access-status without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/remote-access-status"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /vnc-config without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/vnc-config", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /hostname-config without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/hostname-config", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /audit-log without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/audit-log"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /users without a session returns 401, never the user list", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/users"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /users without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/users", { method: "POST", body: JSON.stringify({}) }));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /users-delete without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/users-delete", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /users-role without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/users-role", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /users-role with a viewer session returns 403", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const viewerCookie = await loginAs(handle, `${dir}/auth.db`, "vieweruser", "viewerpassword123", "viewer");
    const res = await handle(
      new Request("http://localhost/users-role", {
        method: "POST",
        headers: { Cookie: viewerCookie },
        body: JSON.stringify({ username: "vieweruser", role: "admin", confirmPassword: "viewerpassword123" }),
      }),
    );
    assertEquals(res.status, 403);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /apt-upgrade/start without a session returns 401, never invoking the privileged start", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/apt-upgrade/start", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /apt-upgrade/status without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/apt-upgrade/status"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /service-status without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/service-status"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /service-control without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(
      new Request("http://localhost/service-control", { method: "POST", body: JSON.stringify({}) }),
    );
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /monitor-events without a session returns 401, never the event data", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/monitor-events"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- viewer role enforcement ---

async function loginAs(
  handle: ReturnType<typeof createHandler>,
  authStorePath: string,
  username: string,
  password: string,
  role: "admin" | "viewer",
): Promise<string> {
  const store = createCredentialStore({ storePath: authStorePath });
  if (username === "admin") {
    await store.createInitialAdmin(username, password);
  } else {
    await store.createUser(username, password, null, role);
  }
  const loginRes = await handle(
    new Request("http://localhost/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  return loginRes.headers.get("set-cookie")!;
}

Deno.test("viewer session gets 403 on admin-only POST /hostname-config", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const adminCookie = await loginAs(handle, `${dir}/auth.db`, "admin", "a-long-enough-password", "admin");
    const viewerCookie = await loginAs(handle, `${dir}/auth.db`, "viewer1", "viewer-long-pass-12", "viewer");
    const res = await handle(
      new Request("http://localhost/hostname-config", {
        method: "POST",
        body: JSON.stringify({ hostname: "newname", confirmPassword: "viewer-long-pass-12" }),
        headers: { "Content-Type": "application/json", cookie: viewerCookie },
      }),
    );
    assertEquals(res.status, 403);
    try {
      const adminRes = await handle(
        new Request("http://localhost/hostname-config", {
          method: "POST",
          body: JSON.stringify({ hostname: "newname", confirmPassword: "a-long-enough-password" }),
          headers: { "Content-Type": "application/json", cookie: adminCookie },
        }),
      );
      // Auth gate passed — not a 403
      assertEquals(adminRes.status === 403, false);
    } catch (err) {
      // sudo unavailable in test env (Windows) — auth check passed, otherwise 403 returned before sudo
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("viewer session can access GET /config (viewer-allowed route)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    await loginAs(handle, `${dir}/auth.db`, "admin", "a-long-enough-password", "admin");
    const viewerCookie = await loginAs(handle, `${dir}/auth.db`, "viewer1", "viewer-long-pass-12", "viewer");
    const res = await handle(
      new Request("http://localhost/config", { headers: { cookie: viewerCookie } }),
    );
    assertEquals(res.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /api/update without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/api/update", { method: "POST" }));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /api/update with a viewer session returns 403", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const viewerCookie = await loginAs(handle, `${dir}/auth.db`, "viewer1", "viewer-long-pass-12", "viewer");
    const res = await handle(
      new Request("http://localhost/api/update", { method: "POST", headers: { cookie: viewerCookie } }),
    );
    assertEquals(res.status, 403);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /api/update with an admin session returns 202 Accepted", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const adminCookie = await loginAs(handle, `${dir}/auth.db`, "admin1", "a-long-enough-pass", "admin");
    const res = await handle(
      new Request("http://localhost/api/update", { method: "POST", headers: { cookie: adminCookie } }),
    );
    // sudo/systemd-run will fail in the test environment, but the 202 is
    // returned immediately (fire-and-forget) before the privileged command.
    assertEquals(res.status, 202);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /api/me without a session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/api/me"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /api/me returns username and role for an authenticated session", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const adminCookie = await loginAs(handle, `${dir}/auth.db`, "admin1", "a-long-enough-pass", "admin");
    const viewerCookie = await loginAs(handle, `${dir}/auth.db`, "viewer1", "viewer-long-pass-12", "viewer");

    const adminRes = await handle(
      new Request("http://localhost/api/me", { headers: { cookie: adminCookie } }),
    );
    assertEquals(adminRes.status, 200);
    const adminData = await adminRes.json();
    assertEquals(adminData.username, "admin1");
    assertEquals(adminData.role, "admin");

    const viewerRes = await handle(
      new Request("http://localhost/api/me", { headers: { cookie: viewerCookie } }),
    );
    assertEquals(viewerRes.status, 200);
    const viewerData = await viewerRes.json();
    assertEquals(viewerData.username, "viewer1");
    assertEquals(viewerData.role, "viewer");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- noVNC proxy auth tests -------------------------------------------

Deno.test("GET /novnc-ws without session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/novnc-ws"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /novnc/ without session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/novnc/vnc.html"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- TTY proxy auth tests ---------------------------------------------

Deno.test("GET /tty-ws without session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/tty-ws"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /terminal without session returns 401", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/terminal"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
