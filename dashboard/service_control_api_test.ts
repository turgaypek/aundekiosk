import { createServiceControlApi } from "./service_control_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (
    api: ReturnType<typeof createServiceControlApi>,
    calls: () => { service: string; action: string }[],
    dir: string,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const calls: { service: string; action: string }[] = [];
    const api = createServiceControlApi({
      stepUpGuard,
      auditLog,
      runPrivilegedToggle: async (service: string, action: "start" | "stop") => {
        calls.push({ service, action });
      },
      checkServiceStatus: async (service: string) => "active" as const,
    });
    await fn(api, () => calls, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function readAuditEvents(dir: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await Deno.readTextFile(`${dir}/audit.log`);
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/service-control", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleStatus returns the status of all four AundeKiosk services", async () => {
  await withApi(async (api) => {
    const res = await api.handleStatus();
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body["aundekiosk-dashboard"], "active");
    assertEquals(body["aundekiosk-monitor"], "active");
    assertEquals(body["aundekiosk-runner"], "active");
    assertEquals(body["aundekiosk-switcher"], "active");
  });
});

Deno.test("handleToggle with the correct confirmPassword invokes the privileged toggle", async () => {
  await withApi(async (api, calls, dir) => {
    const res = await api.handleToggle(
      jsonRequest({ service: "aundekiosk-runner", action: "stop", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(JSON.stringify(calls()), JSON.stringify([{ service: "aundekiosk-runner", action: "stop" }]));

    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "service_toggled");
    assertEquals(event !== undefined, true);
    assertEquals(event?.username, "admin");
    assertEquals(event?.ip, "203.0.113.1");
    assertEquals(event?.service, "aundekiosk-runner");
    assertEquals(event?.action, "stop");
    assertEquals(event?.ok, true);
  });
});

Deno.test("handleToggle with a wrong confirmPassword returns 403 and never invokes the privileged toggle", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ service: "aundekiosk-runner", action: "stop", confirmPassword: "wrong" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleToggle rejects a service outside the four AundeKiosk units", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ service: "sshd", action: "stop", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleToggle rejects an action outside start/stop", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ service: "aundekiosk-runner", action: "restart", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleToggle audit-logs a failed privileged toggle with ok:false", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const api = createServiceControlApi({
      stepUpGuard,
      auditLog,
      runPrivilegedToggle: async () => {
        throw new Error("toggle-service.sh failed: simulated");
      },
      checkServiceStatus: async () => "active" as const,
    });
    let threw = false;
    try {
      await api.handleToggle(
        jsonRequest({ service: "aundekiosk-runner", action: "stop", confirmPassword: "a-long-enough-password" }),
        "admin",
        "203.0.113.1",
      );
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "service_toggled");
    assertEquals(event?.ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
