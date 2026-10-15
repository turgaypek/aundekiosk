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

Deno.test("POST rejects a non-http(s) URL (e.g. javascript:) and leaves existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const original = JSON.stringify({ urls: [{ url: "https://keep.test", duration: 5, cycles: 1 }] });
    await Deno.writeTextFile(configPath, original);
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [{ url: "javascript:alert(1)", duration: 5, cycles: 1 }] }),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST rejects a URL whose extra text would be word-split into separate Chromium arguments, and leaves existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const original = JSON.stringify({ urls: [{ url: "https://keep.test", duration: 5, cycles: 1 }] });
    await Deno.writeTextFile(configPath, original);
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({
        urls: [{ url: "https://ok.test --proxy-server=evil.test:8080", duration: 5, cycles: 1 }],
      }),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST rejects a non-integer or out-of-range duration and leaves existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const original = JSON.stringify({ urls: [{ url: "https://keep.test", duration: 5, cycles: 1 }] });
    await Deno.writeTextFile(configPath, original);
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });

    for (const duration of [0, -3, 1.5, 301]) {
      const req = new Request("http://localhost/config", {
        method: "POST",
        body: JSON.stringify({ urls: [{ url: "https://a.test", duration, cycles: 1 }] }),
      });
      const res = await api.handlePost(req);
      assertEquals(res.status, 400, `duration ${duration} should be rejected`);
    }
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST rejects a non-integer or out-of-range cycles value and leaves existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const original = JSON.stringify({ urls: [{ url: "https://keep.test", duration: 5, cycles: 1 }] });
    await Deno.writeTextFile(configPath, original);
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });

    for (const cycles of [-1, 1.5, 101]) {
      const req = new Request("http://localhost/config", {
        method: "POST",
        body: JSON.stringify({ urls: [{ url: "https://a.test", duration: 5, cycles }] }),
      });
      const res = await api.handlePost(req);
      assertEquals(res.status, 400, `cycles ${cycles} should be rejected`);
    }
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST trims surrounding whitespace from a URL before saving", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [{ url: "  https://trim.test  ", duration: 5, cycles: 1 }] }),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 200);
    const saved = JSON.parse(await Deno.readTextFile(configPath));
    assertEquals(saved.urls[0].url, "https://trim.test");
  });
});

Deno.test("POST does not leave a stray temp file behind after a successful save", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [{ url: "https://b.test", duration: 10, cycles: 0 }] }),
    });
    await api.handlePost(req);
    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    entries.sort();
    const expected = ["config.json", "config.json.backup"];
    assertEquals(entries.length, expected.length);
    assertEquals(entries[0], expected[0]);
    assertEquals(entries[1], expected[1]);
  });
});

Deno.test("handlePost writes a backup file alongside config.json after a successful save", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/config.json.sample` });
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const body = JSON.stringify({ urls: [{ url: "https://example.com", duration: 10, cycles: 0 }] });
    const res = await api.handlePost(new Request("http://localhost/config", {
      method: "POST", body, headers: { "Content-Type": "application/json" },
    }));
    assertEquals(res.status, 200);
    const backup = await Deno.readTextFile(`${configPath}.backup`);
    const parsed = JSON.parse(backup);
    assertEquals(parsed.urls[0].url, "https://example.com");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("handlePost does not write a backup when the save fails (invalid JSON)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/config.json.sample` });
    const res = await api.handlePost(new Request("http://localhost/config", {
      method: "POST", body: "not json",
    }));
    assertEquals(res.status, 400);
    let threw = false;
    try { await Deno.stat(`${configPath}.backup`); } catch { threw = true; }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("handleBackupInfo returns hasBackup:false before any save", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const api = createConfigApi({ configPath: `${dir}/config.json`, samplePath: `${dir}/config.json.sample` });
    const res = await api.handleBackupInfo();
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.hasBackup, false);
    assertEquals(data.backupAgeSeconds, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("handleBackupInfo returns hasBackup:true after a save", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/config.json.sample` });
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    await api.handlePost(new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [] }),
      headers: { "Content-Type": "application/json" },
    }));
    const res = await api.handleBackupInfo();
    const data = await res.json();
    assertEquals(data.hasBackup, true);
    assertEquals(typeof data.backupAgeSeconds, "number");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Found on the real Pi: the dashboard runs with UMask=0077 (so audit.log
// and auth.db, which genuinely hold secrets, can never end up
// world-readable) — but that same umask also made config.json mode 600,
// readable only by the dashboard's own "aundekiosk" user. The kiosk
// runner/switcher run as the Pi's own login user (e.g. "pi") and need
// to READ this file — after the dashboard's very first write through
// this endpoint, they lost the ability to, and the kiosk display went
// dark on every reboot with "jq: ... Permission denied" in the journal.
// config.json holds only display URLs/durations, nothing sensitive, so
// making it world-readable (not group-readable, which would need a
// group-membership change too) is the simplest correct fix.
// Deno.FileInfo.mode is always null on Windows (no Unix permission
// bits to report), so this assertion only runs where it can mean
// anything — which is exactly the real deployment target (Linux).
Deno.test("handlePost calls runKioskRestart after a successful save", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    let restartCalled = false;
    const api = createConfigApi({
      configPath,
      samplePath: `${dir}/unused.json`,
      runKioskRestart: async () => { restartCalled = true; },
    });
    const res = await api.handlePost(new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [{ url: "https://b.test", duration: 10, cycles: 0 }] }),
    }));
    assertEquals(res.status, 200);
    assertEquals(restartCalled, true);
  });
});

Deno.test("handlePost does not fail when runKioskRestart throws", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({
      configPath,
      samplePath: `${dir}/unused.json`,
      runKioskRestart: async () => { throw new Error("systemctl unavailable"); },
    });
    const res = await api.handlePost(new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [{ url: "https://b.test", duration: 10, cycles: 0 }] }),
    }));
    // Config was saved; restart failure must not fail the request.
    assertEquals(res.status, 200);
    const saved = JSON.parse(await Deno.readTextFile(configPath));
    assertEquals(saved.urls[0].url, "https://b.test");
  });
});

Deno.test("handlePost does not call runKioskRestart when config validation fails", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    let restartCalled = false;
    const api = createConfigApi({
      configPath,
      samplePath: `${dir}/unused.json`,
      runKioskRestart: async () => { restartCalled = true; },
    });
    const res = await api.handlePost(new Request("http://localhost/config", {
      method: "POST",
      body: "not json",
    }));
    assertEquals(res.status, 400);
    assertEquals(restartCalled, false);
  });
});

Deno.test("POST writes config.json with mode 0644 (world-readable), not the UMask-restricted default", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [{ url: "https://b.test", duration: 10, cycles: 0 }] }),
    });
    await api.handlePost(req);
    if (Deno.build.os !== "windows") {
      const info = await Deno.stat(configPath);
      assertEquals((info.mode ?? 0) & 0o777, 0o644);
    }
  });
});
