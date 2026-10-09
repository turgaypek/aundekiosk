import { hashPassword, verifyPassword } from "./password.ts";

export interface CredentialRecord {
  username: string;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: number | null;
}

export interface CredentialStoreOptions {
  storePath: string;
}

export type VerifyResult =
  | { outcome: "success" }
  | { outcome: "locked"; retryAfterMs: number }
  | { outcome: "invalid" }
  | { outcome: "no-admin" };

// Lockout doubles starting at 1 minute (on the 5th failure), capped at 30
// minutes, so repeated brute-forcing gets slower rather than permanently
// locking the one admin account out.
const LOCKOUT_THRESHOLD = 5;
const ONE_MINUTE_MS = 60_000;
const LOCKOUT_CAP_MS = 30 * ONE_MINUTE_MS;

function lockoutDurationMs(failedAttempts: number): number {
  const exponent = Math.max(0, failedAttempts - LOCKOUT_THRESHOLD);
  return Math.min(ONE_MINUTE_MS * 2 ** exponent, LOCKOUT_CAP_MS);
}

export function createCredentialStore(opts: CredentialStoreOptions) {
  const { storePath } = opts;

  async function read(): Promise<CredentialRecord | null> {
    try {
      const text = await Deno.readTextFile(storePath);
      return JSON.parse(text) as CredentialRecord;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
  }

  async function write(record: CredentialRecord): Promise<void> {
    const tmpPath = `${storePath}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    await Deno.rename(tmpPath, storePath);
  }

  async function hasAdmin(): Promise<boolean> {
    return (await read()) !== null;
  }

  async function createInitialAdmin(username: string, password: string): Promise<void> {
    if (await hasAdmin()) {
      throw new Error("Admin already configured.");
    }
    const passwordHash = await hashPassword(password);
    await write({ username, passwordHash, failedAttempts: 0, lockedUntil: null });
  }

  async function recordFailedAttempt(now: number): Promise<void> {
    const record = await read();
    if (!record) return;
    const failedAttempts = record.failedAttempts + 1;
    const lockedUntil = failedAttempts >= LOCKOUT_THRESHOLD ? now + lockoutDurationMs(failedAttempts) : null;
    await write({ ...record, failedAttempts, lockedUntil });
  }

  async function verifyCredentials(
    username: string,
    password: string,
    now: number = Date.now(),
  ): Promise<VerifyResult> {
    const record = await read();
    if (!record) return { outcome: "no-admin" };

    if (record.lockedUntil !== null && now < record.lockedUntil) {
      return { outcome: "locked", retryAfterMs: record.lockedUntil - now };
    }

    if (record.username !== username) {
      // Verify against the real hash anyway, so a wrong username takes
      // roughly the same time as a wrong password — no username-guessing
      // side channel via response time.
      await verifyPassword(password, record.passwordHash);
      await recordFailedAttempt(now);
      return { outcome: "invalid" };
    }

    const valid = await verifyPassword(password, record.passwordHash);
    if (!valid) {
      await recordFailedAttempt(now);
      return { outcome: "invalid" };
    }

    if (record.failedAttempts > 0 || record.lockedUntil !== null) {
      await write({ ...record, failedAttempts: 0, lockedUntil: null });
    }
    return { outcome: "success" };
  }

  return { hasAdmin, createInitialAdmin, verifyCredentials };
}
