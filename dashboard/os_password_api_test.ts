import { createOsPasswordApi } from "./os_password_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (api: ReturnType<typeof createOsPasswordApi>, record: () => string[], dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const auditLog = createAuditLog({ logPath: `${dir}/audit.log` });
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog });
    const calls: string[] = [];
    const api = createOsPasswordApi({
      stepUpGuard,
      auditLog,
      runPrivilegedChange: async (newPassword: string) => {
        calls.push(newPassword);
      },
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
  return new Request("http://localhost/os-password", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("handleChange with the right confirmPassword and a long enough new password succeeds", async () => {
  await withApi(async (api, calls, dir) => {
    const res = await api.handleChange(
      jsonRequest({ newPassword: "a-new-long-enough-password", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(JSON.stringify(calls()), JSON.stringify(["a-new-long-enough-password"]));

    // Final review (Important I6): spec §6 requires every privileged
    // action to be audit-logged with who did it, from where, and
    // whether it succeeded.
    const events = await readAuditEvents(dir);
    const event = events.find((e) => e.event === "os_password_changed");
    assertEquals(event !== undefined, true);
    assertEquals(event?.username, "admin");
    assertEquals(event?.ip, "203.0.113.1");
    assertEquals(event?.ok, true);
  });
});

Deno.test("handleChange rejects a wrong confirmPassword and never invokes the privileged change", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleChange(
      jsonRequest({ newPassword: "a-new-long-enough-password", confirmPassword: "wrong" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 403);
    assertEquals(calls().length, 0);
  });
});

// Final review (Critical C1, defense in depth at the TS layer too): a
// newline in the new password is read by chpasswd as a SECOND
// "user:password" line, letting an attacker set an arbitrary account's
// password through a field that only checked length.
Deno.test("handleChange rejects a new password containing a newline", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleChange(
      jsonRequest({ newPassword: "a-long-enough-password\nroot:owned", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});

Deno.test("handleChange rejects a new password shorter than 12 characters", async () => {
  await withApi(async (api, calls) => {
    const res = await api.handleChange(
      jsonRequest({ newPassword: "short", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 400);
    assertEquals(calls().length, 0);
  });
});
