import { createMonitorEventsApi } from "./monitor_events_api.ts";
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
    const api = createMonitorEventsApi({ auditLogPath: `${dir}/audit.log` });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    assertEquals(JSON.stringify(await res.json()), JSON.stringify([]));
  });
});

Deno.test("GET returns threshold_triggered events, newest first", async () => {
  await withTempDir(async (dir) => {
    const logPath = `${dir}/audit.log`;
    await Deno.writeTextFile(
      logPath,
      line({ timestamp: "2026-10-12T10:00:00.000Z", event: "threshold_triggered", metric: "cpu", value: 72, threshold: 70, action: "log" }) +
        line({ timestamp: "2026-10-12T10:05:00.000Z", event: "threshold_triggered", metric: "ram", value: 91, threshold: 90, action: "restart_services" }),
    );
    const api = createMonitorEventsApi({ auditLogPath: logPath });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.length, 2);
    // newest first
    assertEquals(body[0].metric, "ram");
    assertEquals(body[0].value, 91);
    assertEquals(body[1].metric, "cpu");
    assertEquals(body[1].value, 72);
  });
});

Deno.test("GET excludes unrelated audit events (logins, service toggles, etc.)", async () => {
  await withTempDir(async (dir) => {
    const logPath = `${dir}/audit.log`;
    await Deno.writeTextFile(
      logPath,
      line({ timestamp: "2026-10-12T10:00:00.000Z", event: "login_succeeded", username: "admin", ip: "127.0.0.1" }) +
        line({ timestamp: "2026-10-12T10:01:00.000Z", event: "service_toggled", username: "admin", service: "aundekiosk-runner", action: "stop", ok: true }) +
        line({ timestamp: "2026-10-12T10:02:00.000Z", event: "threshold_triggered", metric: "cpu", value: 80, threshold: 70, action: "log" }),
    );
    const api = createMonitorEventsApi({ auditLogPath: logPath });
    const res = await api.handleGet();
    const body = await res.json();
    assertEquals(body.length, 1);
    assertEquals(body[0].event, "threshold_triggered");
  });
});

Deno.test("GET includes action_executed and action_suppressed_startup_grace events", async () => {
  await withTempDir(async (dir) => {
    const logPath = `${dir}/audit.log`;
    await Deno.writeTextFile(
      logPath,
      line({ timestamp: "2026-10-12T10:00:00.000Z", event: "action_suppressed_startup_grace", metric: "system", value: 0, threshold: 0, action: "reboot" }) +
        line({ timestamp: "2026-10-12T10:01:00.000Z", event: "action_executed", metric: "system", value: 0, threshold: 0, action: "reboot" }),
    );
    const api = createMonitorEventsApi({ auditLogPath: logPath });
    const res = await api.handleGet();
    const body = await res.json();
    assertEquals(body.length, 2);
    assertEquals(body[0].event, "action_executed");
    assertEquals(body[1].event, "action_suppressed_startup_grace");
  });
});

Deno.test("GET caps the result at 20 events, keeping the most recent", async () => {
  await withTempDir(async (dir) => {
    const logPath = `${dir}/audit.log`;
    let content = "";
    for (let i = 0; i < 25; i++) {
      const hour = String(i).padStart(2, "0");
      content += line({
        timestamp: `2026-10-12T${hour}:00:00.000Z`,
        event: "threshold_triggered",
        metric: "cpu",
        value: i,
        threshold: 70,
        action: "log",
      });
    }
    await Deno.writeTextFile(logPath, content);
    const api = createMonitorEventsApi({ auditLogPath: logPath });
    const res = await api.handleGet();
    const body = await res.json();
    assertEquals(body.length, 20);
    // newest (highest value, since value == hour index here) first
    assertEquals(body[0].value, 24);
    assertEquals(body[19].value, 5);
  });
});

Deno.test("GET skips a blank trailing line without erroring", async () => {
  await withTempDir(async (dir) => {
    const logPath = `${dir}/audit.log`;
    await Deno.writeTextFile(
      logPath,
      line({ timestamp: "2026-10-12T10:00:00.000Z", event: "threshold_triggered", metric: "cpu", value: 80, threshold: 70, action: "log" }),
    );
    const api = createMonitorEventsApi({ auditLogPath: logPath });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.length, 1);
  });
});
