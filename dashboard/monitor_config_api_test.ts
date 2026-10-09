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

Deno.test("POST rejects a cooldownSeconds so large it would break the daemon's bash arithmetic", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/monitor-config.json`;
    const original = JSON.stringify(VALID_CONFIG);
    await Deno.writeTextFile(configPath, original);
    const api = createMonitorConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    // 1e300 passes Number.isInteger but is nowhere near a realistic
    // cooldown, and $((NOW_EPOCH + 1e+300)) in the bash daemon is an
    // arithmetic error that would crash it before it could act.
    const badConfig = {
      ...VALID_CONFIG,
      tiers: [{ threshold: 80, sustainedSamples: 10, action: "restart_services", cooldownSeconds: 1e300 }],
    };
    const req = new Request("http://localhost/monitor-config", { method: "POST", body: JSON.stringify(badConfig) });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST rejects a cooldownSeconds large enough to overflow bash's 64-bit signed arithmetic", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/monitor-config.json`;
    const original = JSON.stringify(VALID_CONFIG);
    await Deno.writeTextFile(configPath, original);
    const api = createMonitorConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    // An admin's "never again" value near Number.MAX_SAFE_INTEGER wraps to
    // a negative number in bash's signed 64-bit arithmetic, putting the
    // cooldown deadline in the past — i.e. no cooldown at all.
    const badConfig = {
      ...VALID_CONFIG,
      tiers: [{ threshold: 80, sustainedSamples: 10, action: "restart_services", cooldownSeconds: 9223372036854775807 }],
    };
    const req = new Request("http://localhost/monitor-config", { method: "POST", body: JSON.stringify(badConfig) });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST rejects a sustainedSamples value absurdly larger than anything sampleIntervalSeconds could reach", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/monitor-config.json`;
    const original = JSON.stringify(VALID_CONFIG);
    await Deno.writeTextFile(configPath, original);
    const api = createMonitorConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const badConfig = {
      ...VALID_CONFIG,
      tiers: [{ threshold: 80, sustainedSamples: 1e300, action: "log", cooldownSeconds: 10 }],
    };
    const req = new Request("http://localhost/monitor-config", { method: "POST", body: JSON.stringify(badConfig) });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST accepts cooldownSeconds and sustainedSamples at their upper bounds", async () => {
  await withTempDir(async (dir) => {
    const api = createMonitorConfigApi({ configPath: `${dir}/monitor-config.json`, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/monitor-config", {
      method: "POST",
      body: JSON.stringify({
        ...VALID_CONFIG,
        tiers: [{ threshold: 90, sustainedSamples: 1000, action: "reboot", cooldownSeconds: 604800 }],
      }),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 200);
  });
});
