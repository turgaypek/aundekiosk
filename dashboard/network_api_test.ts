import { createNetworkApi } from "./network_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (
    api: ReturnType<typeof createNetworkApi>,
    applyCalls: () => unknown[],
    confirmCalls: () => number,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    const applyCalls: unknown[] = [];
    let confirmCalls = 0;
    const api = createNetworkApi({
      stepUpGuard,
      runPrivilegedApply: async (payload: unknown) => {
        applyCalls.push(payload);
      },
      runPrivilegedConfirm: async () => {
        confirmCalls++;
      },
    });
    await fn(api, () => applyCalls, () => confirmCalls);
  } finally {
    await Deno.remove(dir, { recursive: true });
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
  await withApi(async (api, applyCalls) => {
    const res = await api.handleApply(
      jsonRequest("/network-config", { ...VALID_NETWORK_CONFIG, confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(applyCalls().length, 1);
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
  await withApi(async (api, _applyCalls, confirmCalls) => {
    const res = await api.handleConfirm(
      jsonRequest("/network-confirm", { confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(confirmCalls(), 1);
  });
});
