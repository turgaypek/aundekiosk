import { createSnmpApi } from "./snmp_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(fn: (api: ReturnType<typeof createSnmpApi>, calls: () => unknown[]) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    const calls: unknown[] = [];
    const api = createSnmpApi({
      stepUpGuard,
      runPrivilegedConfigure: async (payload: unknown) => {
        calls.push(payload);
      },
    });
    await fn(api, () => calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const VALID_SNMP_CONFIG = {
  enabled: true,
  username: "monitor_user",
  authProtocol: "SHA-256",
  authPassphrase: "a-long-enough-auth-pass",
  privProtocol: "AES",
  privPassphrase: "a-long-enough-priv-pass",
  allowedSource: "192.168.1.0/24",
};

function jsonRequest(body: unknown) {
  return new Request("http://localhost/snmp-config", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleConfigure with a valid SNMPv3 config and correct confirmPassword succeeds", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ ...VALID_SNMP_CONFIG, confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(calls().length, 1);
  });
});

Deno.test("handleConfigure rejects an auth protocol outside SHA/SHA-256", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ ...VALID_SNMP_CONFIG, authProtocol: "MD5", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleConfigure rejects a wrong confirmPassword and never invokes the privileged configure", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ ...VALID_SNMP_CONFIG, confirmPassword: "wrong" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(calls().length, 0);
  });
});

// Final review (Critical C3, defense in depth at the TS layer too): a
// newline in either passphrase is written verbatim into net-snmp's
// config files by the privileged helper and read as a second,
// attacker-chosen directive.
Deno.test("handleConfigure rejects an authPassphrase containing a newline", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ ...VALID_SNMP_CONFIG, authPassphrase: "a-pass\nrocommunity public", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleConfigure rejects a privPassphrase containing a newline", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ ...VALID_SNMP_CONFIG, privPassphrase: "a-pass\nrocommunity public", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleConfigure accepts enabled:false without requiring the SNMPv3 fields", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleConfigure(
      jsonRequest({ enabled: false, confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(calls().length, 1);
  });
});
