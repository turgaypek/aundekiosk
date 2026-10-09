import { createHandler } from "./server.ts";
import { assertEquals } from "./test_util.ts";

Deno.test("GET /config returns the sample config end to end", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const samplePath = `${dir}/config.json.sample`;
    await Deno.writeTextFile(samplePath, JSON.stringify({ urls: [] }));
    const handle = createHandler({ configPath: `${dir}/config.json`, samplePath });
    const res = await handle(new Request("http://localhost/config"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), JSON.stringify({ urls: [] }));
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
    });
    const res = await handle(new Request("http://localhost/config", { method: "DELETE" }));
    assertEquals(res.status, 405);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
