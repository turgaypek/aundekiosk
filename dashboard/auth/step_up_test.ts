import { createCredentialStore } from "./credential_store.ts";
import { createStepUpGuard } from "./step_up.ts";
import { assertEquals } from "../test_util.ts";

async function withGuard(fn: (guard: ReturnType<typeof createStepUpGuard>) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    await credentialStore.createInitialAdmin("admin", "a-long-enough-password");
    const guard = createStepUpGuard({ credentialStore });
    await fn(guard);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("verify succeeds when the current password is correct", async () => {
  await withGuard(async (guard) => {
    assertEquals(await guard.verify("admin", "a-long-enough-password"), true);
  });
});

Deno.test("verify fails when the current password is wrong", async () => {
  await withGuard(async (guard) => {
    assertEquals(await guard.verify("admin", "wrong-password"), false);
  });
});

Deno.test("verify fails when no admin is configured yet", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const credentialStore = createCredentialStore({ storePath: `${dir}/auth.db` });
    const guard = createStepUpGuard({ credentialStore });
    assertEquals(await guard.verify("admin", "anything"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
