import { createNetworkApi } from "./network_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { PrivilegedCommandError } from "./privileged_runner.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (
    api: ReturnType<typeof createNetworkApi>,
    applyCalls: () => unknown[],
    confirmCalls: () => number,
    dir: string,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const applyCalls: unknown[] = [];
    let confirmCalls = 0;
    const api = createNetworkApi({
      stepUpGuard,
      auditLog,
      runPrivilegedApply: async (payload: unknown) => {
        applyCalls.push(payload);
      },
      runPrivilegedConfirm: async () => {
        confirmCalls++;
      },
    });
    await fn(api, () => applyCalls, () => confirmCalls, dir);
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

const VALID_NETWORK_CONFIG = {
  interface: "eth0",
  mode: "static",
  staticIp: "192.168.1.50/24",
  gateway: "192.168.1.1",
  dns: "8.8.8.8",
  wifiSsid: null,
  wifiPassword: null,
};

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleApply with a valid config and correct confirmPassword invokes the privileged apply", async () => {
  await withApi(async (api, applyCalls, _confirmCalls, dir) => {
    const res = await api.handleApply(
      jsonRequest("/network-config", { ...VALID_NETWORK_CONFIG, confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(applyCalls().length, 1);

    // Final review (Important I6): spec §6 requires every privileged
    // action to be audit-logged with who did it, from where, and
    // whether it succeeded.
    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "network_config_applied");
    assertEquals(event !== undefined, true);
    assertEquals(event?.username, "admin");
    assertEquals(event?.ip, "203.0.113.1");
    assertEquals(event?.ok, true);
  });
});

Deno.test("handleApply with a wrong confirmPassword returns 403 and never invokes the privileged apply", async () => {
  await withApi(async (api, applyCalls) => {
    const res = await api.handleApply(
      jsonRequest("/network-config", { ...VALID_NETWORK_CONFIG, confirmPassword: "wrong" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(applyCalls().length, 0);
  });
});

Deno.test("handleApply rejects an invalid interface before step-up even matters", async () => {
  await withApi(async (api, applyCalls) => {
    const res = await api.handleApply(
      jsonRequest("/network-config", {
        ...VALID_NETWORK_CONFIG,
        interface: "eth99",
        confirmPassword: "a-long-enough-password",
      }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(applyCalls().length, 0);
  });
});

Deno.test("handleConfirm with the correct confirmPassword invokes the privileged confirm", async () => {
  await withApi(async (api, _applyCalls, confirmCalls, dir) => {
    const res = await api.handleConfirm(
      jsonRequest("/network-confirm", { confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(confirmCalls(), 1);

    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "network_config_confirmed");
    assertEquals(event !== undefined, true);
    assertEquals(event?.ok, true);
  });
});

// Final review (Important I8): confirm-network-config.sh exits with
// code 2 to mean "nothing was pending" (already rolled back, or never
// scheduled) — the API must report this as a distinct outcome, not a
// bare 200 "confirmed" the user never actually got.
Deno.test("handleConfirm returns 409 when nothing was pending (already rolled back)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const api = createNetworkApi({
      stepUpGuard,
      auditLog,
      runPrivilegedApply: async () => {},
      runPrivilegedConfirm: async () => {
        throw new PrivilegedCommandError("confirm-network-config.sh failed: no pending rollback", 2);
      },
    });
    const res = await api.handleConfirm(
      jsonRequest("/network-confirm", { confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 409);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
