import { createConfigApi } from "./config_api.ts";
import { assertEquals } from "./test_util.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("GET returns the sample config when no config.json exists yet", async () => {
  await withTempDir(async (dir) => {
    const samplePath = `${dir}/config.json.sample`;
    await Deno.writeTextFile(samplePath, JSON.stringify({ urls: [] }));
    const api = createConfigApi({ configPath: `${dir}/config.json`, samplePath });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    assertEquals(await res.text(), JSON.stringify({ urls: [] }));
  });
});

Deno.test("GET returns the saved config.json when it exists", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({ urls: [{ url: "https://a.test", duration: 5, cycles: 1 }] }),
    );
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.urls[0].url, "https://a.test");
  });
});

Deno.test("POST with valid shape writes the file and returns 200", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const payload = JSON.stringify({ urls: [{ url: "https://b.test", duration: 10, cycles: 0 }] });
    const req = new Request("http://localhost/config", { method: "POST", body: payload });
    const res = await api.handlePost(req);
    assertEquals(res.status, 200);
    const saved = await Deno.readTextFile(configPath);
    assertEquals(JSON.parse(saved).urls[0].url, "https://b.test");
  });
});

Deno.test("POST with malformed JSON returns 400 and leaves existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const original = JSON.stringify({ urls: [{ url: "https://keep.test", duration: 5, cycles: 1 }] });
    await Deno.writeTextFile(configPath, original);
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/config", { method: "POST", body: "{not json" });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST with valid JSON but wrong shape returns 400 and leaves existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const original = JSON.stringify({ urls: [{ url: "https://keep.test", duration: 5, cycles: 1 }] });
    await Deno.writeTextFile(configPath, original);
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [{ url: "", duration: "ten", cycles: 1 }] }),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});
