import { hashPassword, verifyPassword } from "./password.ts";

export interface UserRecord {
  username: string;
  email: string | null;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: number | null;
}

export type PublicUserRecord = Omit<UserRecord, "passwordHash">;

interface StoreFile {
  users: UserRecord[];
}

// The on-disk shape createInitialAdmin wrote before multi-user support —
// one bare record, not wrapped in { users: [...] }. A Pi already running
// in production has a real admin account in exactly this shape, so
// reading it (not a separate migration step) is how that account stays
// usable going forward.
interface LegacySingleAdminFile {
  username: string;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: number | null;
}

function isLegacyFormat(value: unknown): value is LegacySingleAdminFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "username" in value &&
    "passwordHash" in value &&
    !("users" in value)
  );
}

export interface CredentialStoreOptions {
  storePath: string;
}

export type VerifyResult =
  | { outcome: "success" }
  | { outcome: "locked"; retryAfterMs: number }
  | { outcome: "invalid"; justLocked: boolean }
  | { outcome: "no-admin" };

// Lockout doubles starting at 1 minute (on the 5th failure), capped at 30
// minutes, so repeated brute-forcing gets slower rather than permanently
// locking an account out.
const LOCKOUT_THRESHOLD = 5;
const ONE_MINUTE_MS = 60_000;
const LOCKOUT_CAP_MS = 30 * ONE_MINUTE_MS;

function lockoutDurationMs(failedAttempts: number): number {
  const exponent = Math.max(0, failedAttempts - LOCKOUT_THRESHOLD);
  return Math.min(ONE_MINUTE_MS * 2 ** exponent, LOCKOUT_CAP_MS);
}

export function createCredentialStore(opts: CredentialStoreOptions) {
  const { storePath } = opts;

  // Every public method that reads-then-writes the store runs through this
  // queue, one at a time. Without it, concurrent requests (e.g. a batch of
  // parallel login guesses, or two first-run setup submissions) each read
  // the record before any of the others' writes land, so the last write
  // wins and silently drops the others — defeating the lockout counter and
  // letting two "first" admins both succeed.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(job: () => Promise<T>): Promise<T> {
    const result = queue.then(job, job);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function read(): Promise<StoreFile> {
    let text: string;
    try {
      text = await Deno.readTextFile(storePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { users: [] };
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (isLegacyFormat(parsed)) {
      return {
        users: [{
          username: parsed.username,
          email: null,
          passwordHash: parsed.passwordHash,
          failedAttempts: parsed.failedAttempts,
          lockedUntil: parsed.lockedUntil,
        }],
      };
    }
    return parsed as StoreFile;
  }

  async function write(file: StoreFile): Promise<void> {
    const tmpPath = `${storePath}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    await Deno.rename(tmpPath, storePath);
  }

  async function hasAdmin(): Promise<boolean> {
    return (await read()).users.length > 0;
  }

  async function createUserLocked(username: string, password: string, email: string | null): Promise<void> {
    const file = await read();
    if (file.users.some((u) => u.username === username)) {
      throw new Error(`User '${username}' already exists.`);
    }
    const passwordHash = await hashPassword(password);
    file.users.push({ username, email, passwordHash, failedAttempts: 0, lockedUntil: null });
    await write(file);
  }

  async function createInitialAdminLocked(username: string, password: string): Promise<void> {
    if ((await read()).users.length > 0) {
      throw new Error("Admin already configured.");
    }
    await createUserLocked(username, password, null);
  }

  async function deleteUserLocked(username: string): Promise<void> {
    const file = await read();
    if (file.users.length <= 1) {
      throw new Error("Cannot delete the last remaining user — it would lock everyone out.");
    }
    const next = file.users.filter((u) => u.username !== username);
    if (next.length === file.users.length) {
      throw new Error(`User '${username}' does not exist.`);
    }
    await write({ users: next });
  }

  async function resetPasswordLocked(username: string, newPassword: string): Promise<void> {
    const file = await read();
    const index = file.users.findIndex((u) => u.username === username);
    if (index === -1) {
      throw new Error(`User '${username}' does not exist.`);
    }
    const passwordHash = await hashPassword(newPassword);
    // Clearing failedAttempts/lockedUntil here (not just the hash) is
    // the whole point for a recovery tool: a user who got locked out is
    // still locked out after a password reset unless this is cleared
    // too, defeating the one thing the tool exists to fix.
    file.users[index] = { ...file.users[index], passwordHash, failedAttempts: 0, lockedUntil: null };
    await write(file);
  }

  async function listUsersLocked(): Promise<PublicUserRecord[]> {
    const file = await read();
    return file.users.map(({ passwordHash: _passwordHash, ...rest }) => rest);
  }

  // Returns true only the moment a failure crosses the lockout threshold
  // (so callers can audit-log the lockout itself, not just the plain
  // failure), false for every attempt before or after that transition.
  async function recordFailedAttempt(username: string, now: number): Promise<boolean> {
    const file = await read();
    const index = file.users.findIndex((u) => u.username === username);
    if (index === -1) return false;
    const user = file.users[index];
    const wasLocked = user.lockedUntil !== null;
    const failedAttempts = user.failedAttempts + 1;
    const lockedUntil = failedAttempts >= LOCKOUT_THRESHOLD ? now + lockoutDurationMs(failedAttempts) : null;
    file.users[index] = { ...user, failedAttempts, lockedUntil };
    await write(file);
    return lockedUntil !== null && !wasLocked;
  }

  async function clearFailuresIfAny(username: string, user: UserRecord): Promise<void> {
    if (user.failedAttempts === 0 && user.lockedUntil === null) return;
    const file = await read();
    const index = file.users.findIndex((u) => u.username === username);
    if (index === -1) return;
    file.users[index] = { ...file.users[index], failedAttempts: 0, lockedUntil: null };
    await write(file);
  }

  async function verifyCredentialsLocked(
    username: string,
    password: string,
    now: number,
  ): Promise<VerifyResult> {
    const file = await read();
    if (file.users.length === 0) return { outcome: "no-admin" };

    const user = file.users.find((u) => u.username === username);
    if (!user) {
      // Verify against SOME real hash anyway, so a wrong username takes
      // roughly the same time as a wrong password — no username-guessing
      // side channel via response time.
      await verifyPassword(password, file.users[0].passwordHash);
      return { outcome: "invalid", justLocked: false };
    }

    if (user.lockedUntil !== null && now < user.lockedUntil) {
      return { outcome: "locked", retryAfterMs: user.lockedUntil - now };
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      const justLocked = await recordFailedAttempt(username, now);
      return { outcome: "invalid", justLocked };
    }

    await clearFailuresIfAny(username, user);
    return { outcome: "success" };
  }

  return {
    hasAdmin,
    createInitialAdmin: (username: string, password: string) =>
      serialize(() => createInitialAdminLocked(username, password)),
    createUser: (username: string, password: string, email: string | null) =>
      serialize(() => createUserLocked(username, password, email)),
    deleteUser: (username: string) => serialize(() => deleteUserLocked(username)),
    resetPassword: (username: string, newPassword: string) =>
      serialize(() => resetPasswordLocked(username, newPassword)),
    listUsers: () => serialize(() => listUsersLocked()),
    verifyCredentials: (username: string, password: string, now: number = Date.now()) =>
      serialize(() => verifyCredentialsLocked(username, password, now)),
  };
}
