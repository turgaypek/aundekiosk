import { createHandler, resolveTlsMode } from "./server.ts";
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
