import { createAptUpgradeApi } from "./apt_upgrade_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { PrivilegedCommandError } from "./privileged_runner.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (
    api: ReturnType<typeof createAptUpgradeApi>,
    deps: {
      startCalls: () => number;
      setUnitActive: (active: boolean) => void;
      setLog: (log: string) => void;
      setRebootRequired: (required: boolean) => void;
      setStartError: (error: Error | null) => void;
    },
    dir: string,
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });

    let startCalls = 0;
    let unitActive = false;
    let log = "";
    let rebootRequired = false;
    let startError: Error | null = null;

    const api = createAptUpgradeApi({
      stepUpGuard,
      auditLog,
      runPrivilegedStart: async () => {
        startCalls++;
        if (startError) throw startError;
      },
      checkUnitActive: async () => unitActive,
      readLog: async () => log,
      checkRebootRequired: async () => rebootRequired,
    });

    await fn(
      api,
      {
        startCalls: () => startCalls,
        setUnitActive: (active) => (unitActive = active),
        setLog: (next) => (log = next),
        setRebootRequired: (required) => (rebootRequired = required),
        setStartError: (error) => (startError = error),
      },
      dir,
    );
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

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleStart with the correct confirmPassword invokes the privileged start", async () => {
  await withApi(async (api, deps, dir) => {
    const res = await api.handleStart(
      jsonRequest("/apt-upgrade/start", { confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 202);
    assertEquals(deps.startCalls(), 1);
    const events = await readAuditEvents(dir);
    assertEquals(events.length, 2); // step-up success + apt_upgrade_requested
    assertEquals(events[1].event, "apt_upgrade_requested");
    assertEquals(events[1].ok, true);
  });
});

Deno.test("handleStart with a wrong confirmPassword returns 403 and never invokes the privileged start", async () => {
  await withApi(async (api, deps) => {
    const res = await api.handleStart(
      jsonRequest("/apt-upgrade/start", { confirmPassword: "wrong" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(deps.startCalls(), 0);
  });
});

Deno.test("handleStart with a missing confirmPassword returns 400 and never invokes the privileged start", async () => {
  await withApi(async (api, deps) => {
    const res = await api.handleStart(jsonRequest("/apt-upgrade/start", {}), "admin", "203.0.113.1");
    assertEquals(res.status, 400);
    assertEquals(deps.startCalls(), 0);
  });
});

Deno.test("handleStart returns 409 and audit-logs ok:false when an upgrade is already running", async () => {
  await withApi(async (api, deps, dir) => {
    deps.setStartError(new PrivilegedCommandError("apt-upgrade.sh failed: already running", 2));
    const res = await api.handleStart(
      jsonRequest("/apt-upgrade/start", { confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 409);
    const events = await readAuditEvents(dir);
    const requested = events.find((e) => e.event === "apt_upgrade_requested");
    assertEquals(requested?.ok, false);
    assertEquals(requested?.reason, "already_running");
  });
});

Deno.test("handleStart audit-logs ok:false and rethrows on an unexpected privileged error", async () => {
  await withApi(async (api, deps, dir) => {
    deps.setStartError(new Error("unexpected failure"));
    let threw = false;
    try {
      await api.handleStart(
        jsonRequest("/apt-upgrade/start", { confirmPassword: "a-long-enough-password" }),
        "admin",
        "203.0.113.1",
      );
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    const events = await readAuditEvents(dir);
    const requested = events.find((e) => e.event === "apt_upgrade_requested");
    assertEquals(requested?.ok, false);
  });
});

Deno.test("handleStatus reports idle when the unit has never run", async () => {
  await withApi(async (api) => {
    const res = await api.handleStatus();
    const body = await res.json();
    assertEquals(body.state, "idle");
    assertEquals(body.log, "");
  });
});

Deno.test("handleStatus reports running while the unit is active", async () => {
  await withApi(async (api, deps) => {
    deps.setUnitActive(true);
    deps.setLog("=== apt update/upgrade started: 2026-10-13T10:00:00Z ===\nFetched 1kB\n");
    const res = await api.handleStatus();
    const body = await res.json();
    assertEquals(body.state, "running");
  });
});

Deno.test("handleStatus reports success once the finished-successfully marker appears", async () => {
  await withApi(async (api, deps) => {
    deps.setUnitActive(false);
    deps.setLog(
      "=== apt update/upgrade started: 2026-10-13T10:00:00Z ===\n" +
        "=== apt update/upgrade finished successfully: 2026-10-13T10:01:00Z ===\n",
    );
    const res = await api.handleStatus();
    const body = await res.json();
    assertEquals(body.state, "success");
  });
});

Deno.test("handleStatus reports failed when the unit stopped without the success marker", async () => {
  await withApi(async (api, deps) => {
    deps.setUnitActive(false);
    deps.setLog("=== apt update/upgrade started: 2026-10-13T10:00:00Z ===\nE: some error\n");
    const res = await api.handleStatus();
    const body = await res.json();
    assertEquals(body.state, "failed");
  });
});

Deno.test("handleStatus reflects rebootRequired", async () => {
  await withApi(async (api, deps) => {
    deps.setRebootRequired(true);
    const res = await api.handleStatus();
    const body = await res.json();
    assertEquals(body.rebootRequired, true);
  });
});

Deno.test("handleStatus caps the returned log to its last portion", async () => {
  await withApi(async (api, deps) => {
    const line = "x".repeat(100) + "\n";
    deps.setLog(line.repeat(3000)); // ~300KB
    const res = await api.handleStatus();
    const body = await res.json();
    assertEquals(body.log.length <= 200_000, true);
    assertEquals(body.log.length > 0, true);
  });
});
