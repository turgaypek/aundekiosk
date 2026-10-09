import { createCredentialStore } from "./credential_store.ts";
import { createAuditLog } from "./audit_log.ts";
import { createStepUpGuard } from "./step_up.ts";
import { requireStepUp } from "./require_step_up.ts";
import { assertEquals } from "../test_util.ts";

async function withGuard(fn: (guard: ReturnType<typeof createStepUpGuard>) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const guard = createStepUpGuard({ credentialStore, auditLog: createAuditLog({ logPath: `${dir}/audit.log` }) });
    await fn(guard);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("requireStepUp passes with the correct current password", async () => {
  await withGuard(async (guard) => {
    const result = await requireStepUp(guard, "admin", "a-long-enough-password", "203.0.113.1");
    assertEquals(result.ok, true);
  });
});

Deno.test("requireStepUp fails with status 403 for a wrong password", async () => {
  await withGuard(async (guard) => {
    const result = await requireStepUp(guard, "admin", "wrong-password", "203.0.113.1");
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.status, 403);
  });
});

Deno.test("requireStepUp fails with status 400 when confirmPassword is missing", async () => {
  await withGuard(async (guard) => {
    const result = await requireStepUp(guard, "admin", undefined, "203.0.113.1");
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.status, 400);
  });
});

Deno.test("requireStepUp fails with status 423 once the account is locked", async () => {
  await withGuard(async (guard) => {
    for (let i = 0; i < 5; i++) {
      await requireStepUp(guard, "admin", "wrong-password", "203.0.113.1");
    }
    const result = await requireStepUp(guard, "admin", "a-long-enough-password", "203.0.113.1");
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertEquals(result.status, 423);
  });
});
