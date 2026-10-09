import type { createCredentialStore, VerifyResult } from "./credential_store.ts";
import type { createAuditLog } from "./audit_log.ts";

export interface StepUpOptions {
  credentialStore: ReturnType<typeof createCredentialStore>;
  auditLog: ReturnType<typeof createAuditLog>;
}

// Re-verifies the CURRENT dashboard password before a high-risk action is
// allowed to proceed, even though the caller already holds a valid
// session — this stops an unattended, already-logged-in browser from
// being used to change the OS password or toggle SSH (spec §6, §8.1).
// Deliberately reuses verifyCredentials so a step-up spam attempt trips
// the same account lockout as a login spam attempt.
//
// Returns the full VerifyResult (not a boolean) so a Plan 3/4 caller can
// distinguish "wrong password" from "account locked" and show the right
// message, and every outcome is audit-logged with the username and IP —
// same as login — so a step-up spam attempt leaves the same trail a login
// spam attempt would.
export function createStepUpGuard(opts: StepUpOptions) {
  const { credentialStore, auditLog } = opts;

  async function verify(username: string, confirmPassword: string, ip: string): Promise<VerifyResult> {
    const result = await credentialStore.verifyCredentials(username, confirmPassword);
    if (result.outcome === "success") {
      await auditLog.record("step_up_succeeded", { username, ip });
    } else if (result.outcome === "locked") {
      await auditLog.record("step_up_locked", { username, ip });
    } else if (result.outcome === "invalid") {
      await auditLog.record("step_up_failed", { username, ip });
    }
    return result;
  }

  return { verify };
}
