import { createCredentialStore } from "./credential_store.ts";
import { createAuditLog } from "./audit_log.ts";
import { createStepUpGuard } from "./step_up.ts";
import { assertEquals } from "../test_util.ts";

async function withGuard(
  fn: (guard: ReturnType<typeof createStepUpGuard>, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const guard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    await fn(guard, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("verify succeeds when the current password is correct", async () => {
  await withGuard(async (guard) => {
    const result = await guard.verify("admin", "a-long-enough-password", "203.0.113.5");
    assertEquals(result.outcome, "success");
  });
});

Deno.test("verify reports invalid when the current password is wrong", async () => {
  await withGuard(async (guard) => {
    const result = await guard.verify("admin", "wrong-password", "203.0.113.5");
    assertEquals(result.outcome, "invalid");
  });
});

Deno.test("verify reports no-admin when none is configured yet", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    const guard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    const result = await guard.verify("admin", "anything", "203.0.113.5");
    assertEquals(result.outcome, "no-admin");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verify reports locked once the account is locked, distinct from a plain wrong password", async () => {
  await withGuard(async (guard) => {
    for (let i = 0; i < 5; i++) {
      await guard.verify("admin", "wrong-password", "203.0.113.5");
    }
    const result = await guard.verify("admin", "a-long-enough-password", "203.0.113.5");
    assertEquals(result.outcome, "locked");
  });
});

Deno.test("every step-up attempt (success, failure) is recorded in the audit log with the username and IP", async () => {
  await withGuard(async (guard, dir) => {
    await guard.verify("admin", "wrong-password", "203.0.113.5");
    await guard.verify("admin", "a-long-enough-password", "203.0.113.5");

    const lines = (await Deno.readTextFile(`${dir}/audit.log`)).trim().split("\n").map((l) => JSON.parse(l));
    const events = lines.map((l: Record<string, unknown>) => l.event);
    assertEquals(events.includes("step_up_failed"), true);
    assertEquals(events.includes("step_up_succeeded"), true);
    for (const line of lines) {
      assertEquals(line.username, "admin");
      assertEquals(line.ip, "203.0.113.5");
    }
  });
});
