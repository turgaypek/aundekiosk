import type { createCredentialStore } from "./credential_store.ts";

export interface StepUpOptions {
  credentialStore: ReturnType<typeof createCredentialStore>;
}

// Re-verifies the CURRENT dashboard password before a high-risk action is
// allowed to proceed, even though the caller already holds a valid
// session — this stops an unattended, already-logged-in browser from
// being used to change the OS password or toggle SSH (spec §6, §8.1).
// Deliberately reuses verifyCredentials so a step-up spam attempt trips
// the same account lockout as a login spam attempt.
export function createStepUpGuard(opts: StepUpOptions) {
  const { credentialStore } = opts;

  async function verify(username: string, confirmPassword: string): Promise<boolean> {
    const result = await credentialStore.verifyCredentials(username, confirmPassword);
    return result.outcome === "success";
  }

  return { verify };
}
