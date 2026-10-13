import { createHostnameApi } from "./hostname_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (api: ReturnType<typeof createHostnameApi>, dir: string, calls: () => string[]) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const calls: string[] = [];
    const api = createHostnameApi({
      stepUpGuard,
      auditLog,
      runPrivilegedChange: async (hostname: string) => {
        calls.push(hostname);
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
  return new Request("http://localhost/hostname-config", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleChange with the correct confirmPassword invokes the privileged change", async () => {
  await withApi(async (api, dir, calls) => {
    const res = await api.handleChange(
      jsonRequest({ hostname: "kiosk-lobby", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(JSON.stringify(calls()), JSON.stringify(["kiosk-lobby"]));

    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "hostname_changed");
    assertEquals(event !== undefined, true);
    assertEquals(event?.username, "admin");
    assertEquals(event?.ip, "203.0.113.1");
    assertEquals(event?.hostname, "kiosk-lobby");
    assertEquals(event?.ok, true);
  });
});

Deno.test("handleChange with a wrong confirmPassword returns 403 and never invokes the privileged change", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleChange(
      jsonRequest({ hostname: "kiosk-lobby", confirmPassword: "wrong-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleChange rejects a hostname with a space and never invokes the privileged change", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleChange(
      jsonRequest({ hostname: "kiosk lobby", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleChange rejects a hostname starting with a hyphen", async () => {
  await withApi(async (api, _dir, calls) => {
    const res = await api.handleChange(
      jsonRequest({ hostname: "-bad", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleChange rejects a hostname over 63 characters", async () => {
  await withApi(async (api, _dir, calls) => {
    const tooLong = "a".repeat(64);
    const res = await api.handleChange(
      jsonRequest({ hostname: tooLong, confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleChange audit-logs a failed privileged change with ok:false", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const api = createHostnameApi({
      stepUpGuard,
      auditLog,
      runPrivilegedChange: async () => {
        throw new Error("change-hostname.sh failed: simulated");
      },
    });
    let threw = false;
    try {
      await api.handleChange(
        jsonRequest({ hostname: "kiosk-lobby", confirmPassword: "a-long-enough-password" }),
        "admin",
        "203.0.113.1",
      );
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "hostname_changed");
    assertEquals(event?.ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
