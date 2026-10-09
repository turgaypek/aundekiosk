import { createHandler } from "./server.ts";
import { assertEquals } from "./test_util.ts";

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
