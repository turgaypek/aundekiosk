import { createMonitorConfigApi } from "./monitor_config_api.ts";
import { assertEquals } from "./test_util.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const VALID_CONFIG = {
  sampleIntervalSeconds: 10,
  activeWindow: null,
  tiers: [
    { threshold: 70, sustainedSamples: 10, action: "log", cooldownSeconds: 300 },
    { threshold: 80, sustainedSamples: 10, action: "restart_services", cooldownSeconds: 300 },
    { threshold: 90, sustainedSamples: 5, action: "reboot", cooldownSeconds: 600 },
  ],
};

Deno.test("GET returns the sample config when none has been saved yet", async () => {
  await withTempDir(async (dir) => {
    const samplePath = `${dir}/monitor-config.json.sample`;
    await Deno.writeTextFile(samplePath, JSON.stringify(VALID_CONFIG));
    const api = createMonitorConfigApi({ configPath: `${dir}/monitor-config.json`, samplePath });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    assertEquals(await res.text(), JSON.stringify(VALID_CONFIG));
  });
});

Deno.test("POST with a valid config writes the file and returns 200", async () => {
  await withTempDir(async (dir) => {
    const api = createMonitorConfigApi({ configPath: `${dir}/monitor-config.json`, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/monitor-config", {
      method: "POST",
      body: JSON.stringify(VALID_CONFIG),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 200);
    const saved = JSON.parse(await Deno.readTextFile(`${dir}/monitor-config.json`));
    assertEquals(saved.tiers.length, 3);
  });
});

Deno.test("POST rejects an unknown action value and leaves the existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/monitor-config.json`;
    const original = JSON.stringify(VALID_CONFIG);
    await Deno.writeTextFile(configPath, original);
    const api = createMonitorConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const badConfig = {
      ...VALID_CONFIG,
      tiers: [{ threshold: 80, sustainedSamples: 10, action: "shutdown", cooldownSeconds: 300 }],
    };
    const req = new Request("http://localhost/monitor-config", { method: "POST", body: JSON.stringify(badConfig) });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST rejects a threshold outside 0-100 and leaves the existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/monitor-config.json`;
    const original = JSON.stringify(VALID_CONFIG);
    await Deno.writeTextFile(configPath, original);
    const api = createMonitorConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const badConfig = {
      ...VALID_CONFIG,
      tiers: [{ threshold: 150, sustainedSamples: 10, action: "log", cooldownSeconds: 300 }],
    };
    const req = new Request("http://localhost/monitor-config", { method: "POST", body: JSON.stringify(badConfig) });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST rejects a malformed activeWindow time and leaves the existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/monitor-config.json`;
    const original = JSON.stringify(VALID_CONFIG);
    await Deno.writeTextFile(configPath, original);
    const api = createMonitorConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const badConfig = { ...VALID_CONFIG, activeWindow: { start: "25:00", end: "02:00" } };
    const req = new Request("http://localhost/monitor-config", { method: "POST", body: JSON.stringify(badConfig) });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST accepts a null activeWindow (always-on monitoring)", async () => {
  await withTempDir(async (dir) => {
    const api = createMonitorConfigApi({ configPath: `${dir}/monitor-config.json`, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/monitor-config", {
      method: "POST",
      body: JSON.stringify({ ...VALID_CONFIG, activeWindow: null }),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 200);
  });
});
