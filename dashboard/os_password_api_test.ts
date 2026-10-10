import { createOsPasswordApi } from "./os_password_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  fn: (api: ReturnType<typeof createOsPasswordApi>, record: () => string[]) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const stepUpGuard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    const calls: string[] = [];
    const api = createOsPasswordApi({
      stepUpGuard,
      runPrivilegedChange: async (newPassword: string) => {
        calls.push(newPassword);
      },
    });
    await fn(api, () => calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
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
  await withApi(async (api, calls) => {
    const res = await api.handleChange(
      jsonRequest({ newPassword: "a-new-long-enough-password", confirmPassword: "a-long-enough-password" }),
      "admin",
      "203.0.113.1",
    );
    assertEquals(res.status, 200);
    assertEquals(JSON.stringify(calls()), JSON.stringify(["a-new-long-enough-password"]));
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
