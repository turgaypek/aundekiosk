import { createRebootScheduleApi } from "./reboot_schedule_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  timerContent: string | null,
  fn: (
    api: ReturnType<typeof createRebootScheduleApi>,
    calls: string[],
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const calls: string[] = [];
  try {
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const api = createRebootScheduleApi({
      stepUpGuard: createStepUpGuard({
        credentialStore: store,
        auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
      }),
      auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
      runPrivilegedManage: async (payload) => {
        calls.push(JSON.stringify(payload));
      },
      readTimerFile: async () => {
        if (timerContent === null) throw new Deno.errors.NotFound("not found");
        return timerContent;
      },
    });
    await fn(api, calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("handleGet returns enabled:true and time when timer file exists", async () => {
  const content = "[Timer]\nOnCalendar=*-*-* 03:00:00\nPersistent=true\n";
  await withApi(content, async (api) => {
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.enabled, true);
    assertEquals(data.time, "03:00");
  });
});

Deno.test("handleGet returns enabled:false when timer file does not exist", async () => {
  await withApi(null, async (api) => {
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.enabled, false);
    assertEquals(data.time, null);
  });
});

Deno.test("handleSet calls runPrivilegedManage with enable+time on valid input", async () => {
  await withApi(null, async (api, calls) => {
    const res = await api.handleSet(
      new Request("http://localhost/reboot-schedule", {
        method: "POST",
        body: JSON.stringify({ time: "03:00", confirmPassword: "a-long-enough-password" }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", "127.0.0.1",
    );
    assertEquals(res.status, 200);
    assertEquals(calls.length, 1);
    assertEquals(JSON.parse(calls[0]).action, "enable");
    assertEquals(JSON.parse(calls[0]).time, "03:00");
  });
});

Deno.test("handleSet rejects invalid time format", async () => {
  await withApi(null, async (api) => {
    const res = await api.handleSet(
      new Request("http://localhost/reboot-schedule", {
        method: "POST",
        body: JSON.stringify({ time: "25:00", confirmPassword: "a-long-enough-password" }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", "127.0.0.1",
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("handleDelete calls runPrivilegedManage with disable", async () => {
  const content = "[Timer]\nOnCalendar=*-*-* 03:00:00\n";
  await withApi(content, async (api, calls) => {
    const res = await api.handleDelete(
      new Request("http://localhost/reboot-schedule", {
        method: "DELETE",
        body: JSON.stringify({ confirmPassword: "a-long-enough-password" }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", "127.0.0.1",
    );
    assertEquals(res.status, 200);
    assertEquals(JSON.parse(calls[0]).action, "disable");
  });
});
