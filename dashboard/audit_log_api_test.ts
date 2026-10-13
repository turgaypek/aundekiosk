import { createAuditLogApi } from "./audit_log_api.ts";
import { assertEquals } from "./test_util.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

Deno.test("GET returns an empty list when the audit log doesn't exist yet", async () => {
  await withTempDir(async (dir) => {
    const api = createAuditLogApi({ auditLogPath: `${dir}/audit.log` });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    assertEquals(JSON.stringify(await res.json()), JSON.stringify([]));
  });
});

Deno.test("GET returns every event type, newest first — not just monitor events", async () => {
  await withTempDir(async (dir) => {
    const logPath = `${dir}/audit.log`;
    await Deno.writeTextFile(
      logPath,
      line({ timestamp: "2026-10-13T10:00:00.000Z", event: "login_succeeded", username: "admin", ip: "203.0.113.1" }) +
        line({ timestamp: "2026-10-13T10:01:00.000Z", event: "ssh_toggled", username: "admin", ip: "203.0.113.1", action: "disable", ok: true }) +
        line({ timestamp: "2026-10-13T10:02:00.000Z", event: "threshold_triggered", metric: "cpu", value: 80, threshold: 70, action: "log" }),
    );
    const api = createAuditLogApi({ auditLogPath: logPath });
    const res = await api.handleGet();
    const body = await res.json();
    assertEquals(body.length, 3);
    assertEquals(body[0].event, "threshold_triggered");
    assertEquals(body[1].event, "ssh_toggled");
    assertEquals(body[2].event, "login_succeeded");
  });
});

Deno.test("GET caps the result at 50 events, keeping the most recent", async () => {
  await withTempDir(async (dir) => {
    const logPath = `${dir}/audit.log`;
    let content = "";
    for (let i = 0; i < 60; i++) {
      const hour = String(i % 24).padStart(2, "0");
      content += line({ timestamp: `2026-10-13T${hour}:00:00.000Z`, event: "login_succeeded", username: `user${i}`, ip: "203.0.113.1" });
    }
    await Deno.writeTextFile(logPath, content);
    const api = createAuditLogApi({ auditLogPath: logPath });
    const res = await api.handleGet();
    const body = await res.json();
    assertEquals(body.length, 50);
    assertEquals(body[0].username, "user59");
    assertEquals(body[49].username, "user10");
  });
});

Deno.test("GET skips a blank trailing line without erroring", async () => {
  await withTempDir(async (dir) => {
    const logPath = `${dir}/audit.log`;
    await Deno.writeTextFile(
      logPath,
      line({ timestamp: "2026-10-13T10:00:00.000Z", event: "login_succeeded", username: "admin", ip: "203.0.113.1" }),
    );
    const api = createAuditLogApi({ auditLogPath: logPath });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.length, 1);
  });
});
