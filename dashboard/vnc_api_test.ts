import { createVncApi } from "./vnc_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (api: ReturnType<typeof createVncApi>, dir: string, calls: () => string[]) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const calls: string[] = [];
    const api = createVncApi({
      stepUpGuard,
      auditLog,
      runPrivilegedToggle: async (action: string) => {
        calls.push(action);
      },
    });
    await fn(api, dir, () => calls);
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
  return new Request("http://localhost/vnc-config", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleToggle with the correct confirmPassword invokes the privileged toggle", async () => {
  await withApi(async (api, dir, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ action: "enable", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(JSON.stringify(calls()), JSON.stringify(["enable"]));

    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "vnc_toggled");
    assertEquals(event !== undefined, true);
    assertEquals(event?.username, "admin");
    assertEquals(event?.ip, "203.0.113.1");
    assertEquals(event?.action, "enable");
    assertEquals(event?.ok, true);
  });
});

Deno.test("handleToggle with a wrong confirmPassword returns 403 and never invokes the privileged toggle", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ action: "enable", confirmPassword: "wrong-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleToggle with a missing confirmPassword returns 400 and never invokes the privileged toggle", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleToggle(jsonRequest({ action: "enable" }), "admin", "203.0.113.1");
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleToggle rejects an action outside enable/disable", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleToggle(
      jsonRequest({ action: "destroy", confirmPassword: "a-long-enough-password" }),
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
    const api = createVncApi({
      stepUpGuard,
      auditLog,
      runPrivilegedToggle: async () => {
        throw new Error("toggle-vnc.sh failed: simulated");
      },
    });
    let threw = false;
    try {
      await api.handleToggle(
        jsonRequest({ action: "enable", confirmPassword: "a-long-enough-password" }),
        "admin",
        "203.0.113.1",
      );
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "vnc_toggled");
    assertEquals(event?.ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
