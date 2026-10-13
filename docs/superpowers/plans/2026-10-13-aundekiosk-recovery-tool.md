# AundeKiosk Recovery Tool (Sub-project D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a small, standalone Deno tool (`recovery/`) that lets an admin with root/sudo on the Pi reset a dashboard user's password — or recreate the first admin if `auth.db` is empty — when nobody can log into the dashboard web UI at all.

**Architecture:** A second, independent Deno HTTP server (`recovery/server.ts`, loopback-only, port 8099) that imports the dashboard's own `credential_store.ts` and `audit_log.ts` directly (no duplicated hashing/lockout logic). It is never installed as a systemd service — `install.sh` only drops a thin wrapper (`/usr/local/bin/aundekiosk-recover`) an admin runs manually via `sudo`. The tool has no login of its own; running it already requires root. A self-contained `recovery/public/index.html` (inline CSS/JS, no dependency on `dashboard/public/*`) is the only UI.

**Tech Stack:** Deno/TypeScript (matching `dashboard/`), plain HTML/CSS/JS (no framework, no build step), bash (install wiring + wrapper script).

**Spec:** [docs/superpowers/specs/2026-10-13-aundekiosk-recovery-tool-design.md](../specs/2026-10-13-aundekiosk-recovery-tool-design.md)

## Global Constraints

- No new external dependencies — reuse `dashboard/auth/password.ts`'s existing `npm:hash-wasm@4.11.0` via `credential_store.ts`; never add a second hashing library.
- Password policy stays at exactly 12 characters minimum everywhere (`MIN_PASSWORD_LENGTH`), now defined in exactly one place (`dashboard/auth/password.ts`).
- Audit log entries are English-only regardless of future UI language (spec §6/§9) — matches every existing `auditLog.record(...)` call in the codebase.
- `recovery/` is **never** installed as a systemd service, never enabled, never started automatically — `install.sh` only installs the `aundekiosk-recover` command.
- `recovery/public/index.html` must be fully self-contained (inline CSS and JS, no `<link>`/`<script src>` to any file outside itself) — it must still work if `dashboard/public/*` is damaged or missing.
- `recovery/` directory must end up root-owned (`chown -R root:root`, `chmod -R go-w`), mirroring exactly how `install.sh` already treats `privileged/` — the unprivileged `aundekiosk` dashboard user must never be able to modify code that will later run as root via `sudo aundekiosk-recover`.
- From this plan onward, "run the full Deno test suite" means running it against **both** `dashboard/` and `recovery/` (two separate top-level directories, same `deno test` flags): `deno test --allow-read --allow-write --allow-net --allow-env --allow-run dashboard/ recovery/`.
- Every new bash test file must be added to `tests/run_all.sh`'s file list in the same task that creates it — a prior sub-project in this series shipped a test file that was never wired in and silently never ran; do not repeat that.

## Review Focus

- Resetting a password for a username that does not exist in `auth.db` must return a clear 400, never a crash or a silent no-op (Task 3).
- Resetting the password of a **locked-out** user must also clear `failedAttempts`/`lockedUntil` — otherwise the tool fails at its one job (the user is still locked out after "successfully" resetting) (Task 2).
- Calling create-admin when an admin already exists (e.g. a stale page reloaded after someone else already recovered) must return 409, never overwrite or duplicate (Task 3).
- A missing/too-short `newPassword` on reset must be rejected with the same 12-character policy as every other credential-creating endpoint in the project, not silently accepted (Task 3).
- `GET /status` against a missing or empty `auth.db` (fresh install, or a fully wiped file) must report zero users gracefully, not throw (Task 3 — `credential_store.ts`'s `read()` already treats `NotFound` as `{users: []}`; this task's test pins that this behavior is also correct through the recovery tool's own endpoint).

---

### Task 1: Consolidate MIN_PASSWORD_LENGTH into password.ts

**Files:**
- Modify: `dashboard/auth/password.ts`
- Modify: `dashboard/auth/auth_api.ts`
- Modify: `dashboard/auth/users_api.ts`

**Interfaces:**
- Produces: `export const MIN_PASSWORD_LENGTH = 12;` from `dashboard/auth/password.ts`, importable as `import { MIN_PASSWORD_LENGTH } from "./password.ts";` (same directory) or `import { MIN_PASSWORD_LENGTH } from "../dashboard/auth/password.ts";` (from `recovery/`, used in Task 3).

This is a pure refactor (two already-passing test suites — `dashboard/auth/auth_api_test.ts` and `dashboard/auth/users_api_test.ts` — must still pass unchanged afterward, since the constant's value does not change). No new test is written for this task; the existing suites are the regression check.

- [ ] **Step 1: Add the shared constant to password.ts**

Open `dashboard/auth/password.ts`. Add this line right after the existing `import` line (before `const MEMORY_SIZE_KIB = ...`):

```typescript
// Shared by every endpoint that creates or changes a dashboard
// password (auth_api.ts's initial setup, users_api.ts's create-user,
// and recovery/server.ts's reset/create-admin) — one place, so the
// policy can never drift between them.
export const MIN_PASSWORD_LENGTH = 12;
```

- [ ] **Step 2: Remove the duplicate from auth_api.ts and import the shared one**

In `dashboard/auth/auth_api.ts`, change:

```typescript
import type { createCredentialStore } from "./credential_store.ts";
import type { createSessionStore } from "./session_store.ts";
import type { createRateLimiter } from "./rate_limiter.ts";
import type { createAuditLog } from "./audit_log.ts";
```

to:

```typescript
import type { createCredentialStore } from "./credential_store.ts";
import type { createSessionStore } from "./session_store.ts";
import type { createRateLimiter } from "./rate_limiter.ts";
import type { createAuditLog } from "./audit_log.ts";
import { MIN_PASSWORD_LENGTH } from "./password.ts";
```

Then delete this line (currently right after `const SESSION_COOKIE = "aundekiosk_session";`):

```typescript
const MIN_PASSWORD_LENGTH = 12;
```

- [ ] **Step 3: Remove the duplicate from users_api.ts and import the shared one**

In `dashboard/auth/users_api.ts`, change:

```typescript
import type { createCredentialStore } from "./credential_store.ts";
import type { createStepUpGuard } from "./step_up.ts";
import type { createAuditLog } from "./audit_log.ts";
import { requireStepUp } from "./require_step_up.ts";

const MIN_PASSWORD_LENGTH = 12;
const MAX_USERNAME_LENGTH = 64;
```

to:

```typescript
import type { createCredentialStore } from "./credential_store.ts";
import type { createStepUpGuard } from "./step_up.ts";
import type { createAuditLog } from "./audit_log.ts";
import { requireStepUp } from "./require_step_up.ts";
import { MIN_PASSWORD_LENGTH } from "./password.ts";

const MAX_USERNAME_LENGTH = 64;
```

- [ ] **Step 4: Run the existing auth test suites to confirm nothing broke**

Run: `deno test --allow-read --allow-write --allow-net --allow-env --allow-run dashboard/auth/auth_api_test.ts dashboard/auth/users_api_test.ts`
Expected: All tests pass, identical count to before this task (this is a pure refactor — no test should newly fail or newly pass).

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/password.ts dashboard/auth/auth_api.ts dashboard/auth/users_api.ts
git commit -m "refactor: consolidate MIN_PASSWORD_LENGTH into password.ts"
```

---

### Task 2: Add resetPassword to credential_store.ts

**Files:**
- Modify: `dashboard/auth/credential_store.ts`
- Modify: `dashboard/auth/credential_store_test.ts`

**Interfaces:**
- Consumes: nothing new (uses the module's own existing `read`, `write`, `hashPassword`, `serialize`).
- Produces: `credentialStore.resetPassword(username: string, newPassword: string): Promise<void>` — throws `Error("User '${username}' does not exist.")` if the user isn't found; on success, replaces `passwordHash` with the new hash AND resets `failedAttempts` to `0` and `lockedUntil` to `null`. Later tasks (Task 3) call this as `credentialStore.resetPassword(username, newPassword)`.

- [ ] **Step 1: Write the failing tests**

Add these tests to the end of `dashboard/auth/credential_store_test.ts` (the file already imports `createCredentialStore` and `assertEquals`, and already defines `withTempStore` — reuse both, do not redefine):

```typescript
Deno.test("resetPassword changes the password hash so the new password logs in and the old one no longer does", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "the-old-password");

    await store.resetPassword("admin", "the-new-password-123");

    const withNew = await store.verifyCredentials("admin", "the-new-password-123");
    assertEquals(withNew.outcome, "success");

    const withOld = await store.verifyCredentials("admin", "the-old-password");
    assertEquals(withOld.outcome, "invalid");
  });
});

Deno.test("resetPassword clears a lockout, so a previously locked-out user can log in immediately with the new password", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "the-old-password");

    const now = 5_000_000;
    for (let i = 0; i < 5; i++) {
      await store.verifyCredentials("admin", "wrong-password", now);
    }
    const lockedCheck = await store.verifyCredentials("admin", "the-old-password", now);
    assertEquals(lockedCheck.outcome, "locked");

    await store.resetPassword("admin", "the-new-password-123");

    const afterReset = await store.verifyCredentials("admin", "the-new-password-123", now);
    assertEquals(afterReset.outcome, "success");
  });
});

Deno.test("resetPassword on a username that doesn't exist throws, without touching any other account", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "the-old-password");

    let threw = false;
    try {
      await store.resetPassword("nobody", "the-new-password-123");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);

    const stillWorks = await store.verifyCredentials("admin", "the-old-password");
    assertEquals(stillWorks.outcome, "success");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-net --allow-env --allow-run dashboard/auth/credential_store_test.ts`
Expected: FAIL — `store.resetPassword is not a function` (TypeError) on all three new tests.

- [ ] **Step 3: Implement resetPassword in credential_store.ts**

In `dashboard/auth/credential_store.ts`, add this function right after `deleteUserLocked` (before `listUsersLocked`):

```typescript
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
```

Then add `resetPassword` to the returned object (right after `deleteUser`):

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-net --allow-env --allow-run dashboard/auth/credential_store_test.ts`
Expected: PASS — all tests in the file, including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/credential_store.ts dashboard/auth/credential_store_test.ts
git commit -m "feat: add resetPassword to the credential store, clearing lockout state too"
```

---

### Task 3: Create recovery/server.ts and its tests

**Files:**
- Create: `recovery/server.ts`
- Create: `recovery/server_test.ts`

**Interfaces:**
- Consumes: `createCredentialStore` and `resetPassword`/`createInitialAdmin`/`listUsers` from `dashboard/auth/credential_store.ts` (Task 2); `createAuditLog`/`record` from `dashboard/auth/audit_log.ts`; `createStaticHandler` from `dashboard/static.ts`; `MIN_PASSWORD_LENGTH` from `dashboard/auth/password.ts` (Task 1); `assertEquals` from `dashboard/test_util.ts`.
- Produces: `createHandler(options?: RecoveryHandlerOptions): (req: Request) => Promise<Response>` — the handler Task 4's manual QA and the `import.meta.main` block both use. Also produces `isIdleTimedOut(lastRequestAt: number, now: number, idleMs: number): boolean` and `IDLE_EXIT_MS` (both used only inside this file's own `import.meta.main` block — no other task consumes them, but they are tested directly here since they're pure).

- [ ] **Step 1: Write the failing tests**

Create `recovery/server_test.ts`:

```typescript
import { createHandler, isIdleTimedOut } from "./server.ts";
import { assertEquals } from "../dashboard/test_util.ts";

async function withApi(
  fn: (handle: ReturnType<typeof createHandler>, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
      publicDir: dir,
    });
    await Deno.writeTextFile(`${dir}/index.html`, "<html></html>");
    await fn(handle, dir);
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

Deno.test("GET /status reports zero usernames before any admin exists", async () => {
  await withApi(async (handle) => {
    const res = await handle(new Request("http://localhost/status"));
    const body = await res.json();
    assertEquals(JSON.stringify(body.usernames), JSON.stringify([]));
  });
});

Deno.test("GET /status lists existing usernames after create-admin", async () => {
  await withApi(async (handle) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "a-long-enough-password" }));
    const res = await handle(new Request("http://localhost/status"));
    const body = await res.json();
    assertEquals(JSON.stringify(body.usernames), JSON.stringify(["admin"]));
  });
});

Deno.test("POST /create-admin with a valid username/password creates the first admin", async () => {
  await withApi(async (handle, dir) => {
    const res = await handle(
      jsonRequest("/create-admin", { username: "admin", password: "a-long-enough-password" }),
    );
    assertEquals(res.status, 201);
    const events = await readAuditEvents(dir);
    assertEquals(events.length, 1);
    assertEquals(events[0].event, "admin_created_via_recovery_tool");
    assertEquals(events[0].ok, true);
  });
});

Deno.test("POST /create-admin refuses with 409 once an admin already exists", async () => {
  await withApi(async (handle) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "a-long-enough-password" }));
    const second = await handle(
      jsonRequest("/create-admin", { username: "someone-else", password: "another-long-password" }),
    );
    assertEquals(second.status, 409);
  });
});

Deno.test("POST /create-admin rejects a password shorter than the minimum", async () => {
  await withApi(async (handle) => {
    const res = await handle(jsonRequest("/create-admin", { username: "admin", password: "short" }));
    assertEquals(res.status, 400);
  });
});

Deno.test("POST /reset-password changes an existing user's password and audit-logs ok:true", async () => {
  await withApi(async (handle, dir) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "the-old-password" }));

    const res = await handle(
      jsonRequest("/reset-password", { username: "admin", newPassword: "the-new-password-123" }),
    );
    assertEquals(res.status, 200);

    const events = await readAuditEvents(dir);
    const resetEvent = events.find((e) => e.event === "password_reset_via_recovery_tool");
    assertEquals(resetEvent?.ok, true);
    assertEquals(resetEvent?.username, "admin");
  });
});

Deno.test("POST /reset-password for a username that doesn't exist returns 400 and audit-logs ok:false", async () => {
  await withApi(async (handle, dir) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "the-old-password" }));

    const res = await handle(
      jsonRequest("/reset-password", { username: "nobody", newPassword: "the-new-password-123" }),
    );
    assertEquals(res.status, 400);

    const events = await readAuditEvents(dir);
    const resetEvent = events.find((e) => e.event === "password_reset_via_recovery_tool");
    assertEquals(resetEvent?.ok, false);
  });
});

Deno.test("POST /reset-password rejects a newPassword shorter than the minimum", async () => {
  await withApi(async (handle) => {
    await handle(jsonRequest("/create-admin", { username: "admin", password: "the-old-password" }));
    const res = await handle(jsonRequest("/reset-password", { username: "admin", newPassword: "short" }));
    assertEquals(res.status, 400);
  });
});

Deno.test("isIdleTimedOut is false right after a request", () => {
  assertEquals(isIdleTimedOut(1_000, 1_000, 600_000), false);
});

Deno.test("isIdleTimedOut is false just before the idle threshold", () => {
  assertEquals(isIdleTimedOut(1_000, 1_000 + 599_999, 600_000), false);
});

Deno.test("isIdleTimedOut is true once the idle threshold is reached", () => {
  assertEquals(isIdleTimedOut(1_000, 1_000 + 600_000, 600_000), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-read --allow-write --allow-net --allow-env --allow-run recovery/server_test.ts`
Expected: FAIL — `Cannot find module 'file:///.../recovery/server.ts'` (the file doesn't exist yet).

- [ ] **Step 3: Implement recovery/server.ts**

Create `recovery/server.ts`:

```typescript
import { createCredentialStore } from "../dashboard/auth/credential_store.ts";
import { createAuditLog } from "../dashboard/auth/audit_log.ts";
import { createStaticHandler } from "../dashboard/static.ts";
import { MIN_PASSWORD_LENGTH } from "../dashboard/auth/password.ts";

const DEFAULT_AUTH_STORE_PATH = "/opt/aundekiosk/auth.db";
const DEFAULT_AUDIT_LOG_PATH = "/opt/aundekiosk/audit.log";
const DEFAULT_PUBLIC_DIR = `${import.meta.dirname}/public`;
const DEFAULT_PORT = 8099;
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 1024;
export const IDLE_EXIT_MS = 10 * 60 * 1000;

export interface RecoveryHandlerOptions {
  authStorePath?: string;
  auditLogPath?: string;
  publicDir?: string;
}

function validateUsername(value: unknown): { username: string } | { error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: "Username is required." };
  }
  if (value.length > MAX_USERNAME_LENGTH) {
    return { error: `Username must be at most ${MAX_USERNAME_LENGTH} characters.` };
  }
  return { username: value.trim() };
}

function validatePassword(value: unknown): { password: string } | { error: string } {
  if (typeof value !== "string" || value.length === 0) {
    return { error: "Password is required." };
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  return { password: value };
}

// isIdleTimedOut/IDLE_EXIT_MS are only ever wired up inside this file's
// own import.meta.main block below (never imported by another module) —
// extracted as a pure function anyway so the 10-minute auto-exit safety
// net (see design spec §4) has a test that doesn't require a real timer.
export function isIdleTimedOut(lastRequestAt: number, now: number, idleMs: number): boolean {
  return now - lastRequestAt >= idleMs;
}

export function createHandler(options: RecoveryHandlerOptions = {}) {
  const authStorePath = options.authStorePath ?? DEFAULT_AUTH_STORE_PATH;
  const auditLogPath = options.auditLogPath ?? DEFAULT_AUDIT_LOG_PATH;
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;

  const credentialStore = createCredentialStore({ storePath: authStorePath });
  const auditLog = createAuditLog({ logPath: auditLogPath });
  const serveStatic = createStaticHandler(publicDir);

  async function handleStatus(): Promise<Response> {
    const users = await credentialStore.listUsers();
    return Response.json({ usernames: users.map((u) => u.username) });
  }

  async function handleResetPassword(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { username: rawUsername, newPassword } = body as Record<string, unknown>;

    const usernameResult = validateUsername(rawUsername);
    if ("error" in usernameResult) {
      return new Response(usernameResult.error, { status: 400 });
    }
    const passwordResult = validatePassword(newPassword);
    if ("error" in passwordResult) {
      return new Response(passwordResult.error, { status: 400 });
    }

    try {
      await credentialStore.resetPassword(usernameResult.username, passwordResult.password);
    } catch (error) {
      await auditLog.record("password_reset_via_recovery_tool", { username: usernameResult.username, ok: false });
      return new Response(error instanceof Error ? error.message : "Could not reset password.", { status: 400 });
    }

    await auditLog.record("password_reset_via_recovery_tool", { username: usernameResult.username, ok: true });
    return new Response("Password reset.", { status: 200 });
  }

  async function handleCreateAdmin(req: Request): Promise<Response> {
    const existingUsers = await credentialStore.listUsers();
    if (existingUsers.length > 0) {
      return new Response("An admin already exists; use password reset instead.", { status: 409 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { username: rawUsername, password: rawPassword } = body as Record<string, unknown>;

    const usernameResult = validateUsername(rawUsername);
    if ("error" in usernameResult) {
      return new Response(usernameResult.error, { status: 400 });
    }
    const passwordResult = validatePassword(rawPassword);
    if ("error" in passwordResult) {
      return new Response(passwordResult.error, { status: 400 });
    }

    try {
      await credentialStore.createInitialAdmin(usernameResult.username, passwordResult.password);
    } catch {
      // Lost a race against a concurrent create-admin request — same
      // "someone already got there first" outcome as the pre-check above.
      return new Response("An admin already exists; use password reset instead.", { status: 409 });
    }

    await auditLog.record("admin_created_via_recovery_tool", { username: usernameResult.username, ok: true });
    return new Response("Admin created.", { status: 201 });
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/status" && req.method === "GET") {
      return handleStatus();
    }
    if (url.pathname === "/reset-password" && req.method === "POST") {
      return handleResetPassword(req);
    }
    if (url.pathname === "/create-admin" && req.method === "POST") {
      return handleCreateAdmin(req);
    }
    return serveStatic(url.pathname);
  };
}

if (import.meta.main) {
  const handler = createHandler();
  let lastRequestAt = Date.now();

  setInterval(() => {
    if (isIdleTimedOut(lastRequestAt, Date.now(), IDLE_EXIT_MS)) {
      console.log("AundeKiosk recovery tool: idle for 10 minutes, exiting.");
      Deno.exit(0);
    }
  }, 30_000);

  console.log(`AundeKiosk recovery tool listening on http://127.0.0.1:${DEFAULT_PORT}/ ...`);
  await Deno.serve({ port: DEFAULT_PORT, hostname: "127.0.0.1" }, (req) => {
    lastRequestAt = Date.now();
    return handler(req);
  }).finished;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-read --allow-write --allow-net --allow-env --allow-run recovery/server_test.ts`
Expected: PASS — all 11 tests.

- [ ] **Step 5: Run the full Deno suite (both directories) to confirm nothing else broke**

Run: `deno test --allow-read --allow-write --allow-net --allow-env --allow-run dashboard/ recovery/`
Expected: PASS — every test in both directories, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add recovery/server.ts recovery/server_test.ts
git commit -m "feat: add the standalone recovery tool's HTTP server"
```

---

### Task 4: Create recovery/public/index.html

**Files:**
- Create: `recovery/public/index.html`

**Interfaces:**
- Consumes: `GET /status` → `{usernames: string[]}`; `POST /create-admin` body `{username, password}`; `POST /reset-password` body `{username, newPassword}` (all from Task 3's `recovery/server.ts`).
- Produces: nothing other tasks consume — this is the tool's only UI.

This file is DOM-dependent and is manually QA'd in a real browser (same project convention as every other dashboard UI change — see `dashboard/public/index.html`'s own panels) rather than Deno-tested. No automated test is written for this task; Step 2 below is the verification instead of a test run.

- [ ] **Step 1: Write the self-contained page**

Create `recovery/public/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AundeKiosk Recovery Tool</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1a1a; color: #eee; max-width: 480px; margin: 40px auto; padding: 0 16px; }
  h1 { font-size: 1.3rem; }
  p.hint { color: #aaa; font-size: 0.9rem; }
  label { display: block; margin-top: 12px; font-size: 0.9rem; }
  input, select { width: 100%; box-sizing: border-box; padding: 8px; margin-top: 4px; background: #2a2a2a; color: #eee; border: 1px solid #444; border-radius: 4px; }
  button { margin-top: 16px; padding: 10px 16px; background: #c0392b; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
  #message { margin-top: 16px; padding: 10px; border-radius: 4px; display: none; }
  #message.success { display: block; background: #1e4620; color: #9fe39f; }
  #message.error { display: block; background: #4a1f1f; color: #f29c9c; }
</style>
</head>
<body>
<h1>AundeKiosk Recovery Tool</h1>
<p class="hint">
  This tool is only reachable at 127.0.0.1 and requires root to have started it.
  It directly edits the dashboard's own credential file — there is no login here.
</p>

<div id="reset-view" hidden>
  <label for="reset-username">User</label>
  <select id="reset-username"></select>
  <label for="reset-password">New password (min 12 characters)</label>
  <input id="reset-password" type="password" />
  <button id="reset-button" type="button">Reset password</button>
</div>

<div id="create-view" hidden>
  <p class="hint">No dashboard users exist yet — create the first admin account.</p>
  <label for="create-username">Username</label>
  <input id="create-username" type="text" />
  <label for="create-password">Password (min 12 characters)</label>
  <input id="create-password" type="password" />
  <button id="create-button" type="button">Create admin</button>
</div>

<div id="message"></div>

<script>
  function showMessage(text, ok) {
    const el = document.getElementById("message");
    el.textContent = text;
    el.className = ok ? "success" : "error";
  }

  async function loadStatus() {
    const res = await fetch("/status");
    const body = await res.json();
    const resetView = document.getElementById("reset-view");
    const createView = document.getElementById("create-view");
    if (body.usernames.length > 0) {
      resetView.hidden = false;
      createView.hidden = true;
      const select = document.getElementById("reset-username");
      select.innerHTML = "";
      for (const username of body.usernames) {
        const option = document.createElement("option");
        option.value = username;
        option.textContent = username;
        select.appendChild(option);
      }
    } else {
      resetView.hidden = true;
      createView.hidden = false;
    }
  }

  document.getElementById("reset-button").addEventListener("click", async () => {
    const username = document.getElementById("reset-username").value;
    const newPassword = document.getElementById("reset-password").value;
    const res = await fetch("/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, newPassword }),
    });
    const text = await res.text();
    showMessage(text, res.ok);
    if (res.ok) document.getElementById("reset-password").value = "";
  });

  document.getElementById("create-button").addEventListener("click", async () => {
    const username = document.getElementById("create-username").value;
    const password = document.getElementById("create-password").value;
    const res = await fetch("/create-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    showMessage(text, res.ok);
    if (res.ok) await loadStatus();
  });

  loadStatus();
</script>
</body>
</html>
```

- [ ] **Step 2: Manually verify in the browser pane**

Start `recovery/server.ts` locally against a temp auth.db (e.g. a short throwaway Deno script or `deno run --allow-read --allow-write --allow-net=127.0.0.1:8099 recovery/server.ts` with `DEFAULT_AUTH_STORE_PATH`/`DEFAULT_AUDIT_LOG_PATH` temporarily pointed at a scratch directory via the same `.claude/launch.json` pattern already used for `dashboard-dev`), open it in the Browser pane, and confirm:
- With no `auth.db`: the create-admin form shows, not the reset form.
- After creating an admin: reloading shows the reset form with that username in the dropdown.
- Resetting the password, then checking `audit.log`, shows a `password_reset_via_recovery_tool` entry with `ok:true`.
- Submitting a password under 12 characters shows the red error message, not a silent failure.

Expected: all four behaviors match.

- [ ] **Step 3: Commit**

```bash
git add recovery/public/index.html
git commit -m "feat: add the recovery tool's self-contained single-page UI"
```

---

### Task 5: Create the aundekiosk-recover wrapper script and its test

**Files:**
- Create: `scripts/setup/aundekiosk-recover-wrapper.sh`
- Create: `tests/setup/aundekiosk_recover_wrapper_test.sh`
- Modify: `tests/run_all.sh`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (it execs `deno run .../recovery/server.ts` as a subprocess — Task 3's file, referenced only by path, not imported).
- Produces: `/usr/local/bin/aundekiosk-recover` is what Task 6's `install.sh` step installs FROM (`scripts/setup/aundekiosk-recover-wrapper.sh` is the source file Task 6 copies).

- [ ] **Step 1: Write the failing test**

Create `tests/setup/aundekiosk_recover_wrapper_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

WRAPPER="$SCRIPT_DIR/../../scripts/setup/aundekiosk-recover-wrapper.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/deno" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_DENO_LOG"
exit 0
EOF
chmod +x "$FAKE_BIN/deno"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_DENO_LOG="$WORKDIR/deno.log"

bash "$WRAPPER" > "$WORKDIR/output.txt" 2>&1
assert_status 0 $? "aundekiosk-recover-wrapper.sh exits 0 when deno exits 0"

grep -q "run" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh invokes 'deno run'"

grep -qF -- "--allow-net=127.0.0.1:8099" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh only allows network access on loopback, port 8099"

grep -qF -- "--allow-read=/opt/aundekiosk" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh only allows reading under /opt/aundekiosk"

grep -qF -- "--allow-write=/opt/aundekiosk" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh only allows writing under /opt/aundekiosk"

grep -qF -- "--cached-only" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh never reaches the network for dependencies at runtime"

grep -qF "/opt/aundekiosk/recovery/server.ts" "$WORKDIR/deno.log"
assert_status 0 $? "aundekiosk-recover-wrapper.sh runs the recovery tool's server.ts from the installed path"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash tests/setup/aundekiosk_recover_wrapper_test.sh`
Expected: FAIL — `No such file or directory` (the wrapper script doesn't exist yet), every assertion reports NOT OK.

- [ ] **Step 3: Write the wrapper script**

Create `scripts/setup/aundekiosk-recover-wrapper.sh`:

```bash
#!/usr/bin/env bash
# Standalone recovery tool for AundeKiosk's dashboard credentials.
# Never installed as a systemd service — run this manually (as root,
# e.g. "sudo aundekiosk-recover") only when nobody can log into the
# dashboard at all. Binds to 127.0.0.1 only: open it from the Pi's own
# browser, or via an SSH port-forward
# (ssh -L 8099:localhost:8099 pi@<this-pi>).
#
# auth.db is owned by the unprivileged 'aundekiosk' user, mode 0600 —
# running this without root/sudo fails with a plain permission error
# from Deno itself, which is enforcement enough; this script adds none
# of its own.
set -euo pipefail

export DENO_DIR="/opt/aundekiosk/.deno"
exec /usr/local/bin/deno run \
    --cached-only \
    --lock=/opt/aundekiosk/dashboard/deno.lock \
    --allow-net=127.0.0.1:8099 \
    --allow-read=/opt/aundekiosk \
    --allow-write=/opt/aundekiosk \
    /opt/aundekiosk/recovery/server.ts
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash tests/setup/aundekiosk_recover_wrapper_test.sh`
Expected: PASS — all 6 assertions, "6 passed, 0 failed".

- [ ] **Step 5: Register the new test file in tests/run_all.sh**

In `tests/run_all.sh`, add this line right after `"$SCRIPT_DIR/privileged/apt_upgrade_test.sh" \` (keep the trailing ` \` continuation on both lines):

```
  "$SCRIPT_DIR/setup/aundekiosk_recover_wrapper_test.sh" \
```

So that section of the `for t in \ ... ; do` list reads:

```
  "$SCRIPT_DIR/privileged/apt_upgrade_test.sh" \
  "$SCRIPT_DIR/setup/aundekiosk_recover_wrapper_test.sh" \
  "$SCRIPT_DIR/services/templates_test.sh" \
```

- [ ] **Step 6: Run the full bash suite to confirm it's picked up and nothing else broke**

Run: `bash tests/run_all.sh`
Expected: "All bash test suites passed." (the new file's 6 assertions are included in the total).

- [ ] **Step 7: Commit**

```bash
git add scripts/setup/aundekiosk-recover-wrapper.sh tests/setup/aundekiosk_recover_wrapper_test.sh tests/run_all.sh
git commit -m "feat: add the aundekiosk-recover wrapper script"
```

---

### Task 6: Wire install.sh to install the recovery tool

**Files:**
- Modify: `scripts/setup/install.sh`
- Modify: `tests/setup/install_test.sh`

**Interfaces:**
- Consumes: `scripts/setup/aundekiosk-recover-wrapper.sh` (Task 5, copied by path — not imported).
- Produces: nothing other tasks consume — this is the final wiring task.

- [ ] **Step 1: Write the failing tests**

Add these to the end of `tests/setup/install_test.sh` (before the final `assert_summary`):

```bash
# The recovery tool (sub-project D) is a standalone command, never a
# systemd service — this only installs the wrapper binary, nothing
# that starts automatically.
grep -qE 'install -m 0755 "\$AUNDEKIOSK_INSTALL_DIR/scripts/setup/aundekiosk-recover-wrapper\.sh" /usr/local/bin/aundekiosk-recover' "$INSTALL_SH"
assert_status 0 $? "install.sh installs the aundekiosk-recover wrapper to /usr/local/bin"

# Same reasoning as the existing "privileged/" ownership hardening
# (Critical C2, see the chown -R root:root privileged check above): the
# unprivileged aundekiosk dashboard user must never be able to modify
# code that will later run as root via "sudo aundekiosk-recover".
grep -qE 'chown -R root:root "\$AUNDEKIOSK_INSTALL_DIR/recovery"' "$INSTALL_SH"
assert_status 0 $? "install.sh makes the recovery/ directory root-owned, not dashboard-owned"

grep -qE 'chmod -R go-w "\$AUNDEKIOSK_INSTALL_DIR/recovery"' "$INSTALL_SH"
assert_status 0 $? "install.sh removes group/other write access from the recovery/ directory"

# install.sh must never enable or start a recovery-tool service — it
# has none; this pins the negative as a safety net against someone
# later adding one by mistake.
! grep -qi "aundekiosk-recover.*\.service\|aundekiosk-recovery\.service" "$INSTALL_SH"
assert_status 0 $? "install.sh never installs/enables a systemd service for the recovery tool"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bash tests/setup/install_test.sh`
Expected: FAIL on the 3 new positive assertions (NOT OK — install.sh doesn't have these lines yet); the negative assertion (no service) already passes since nothing matches yet.

- [ ] **Step 3: Wire install.sh**

In `scripts/setup/install.sh`, change:

```bash
msg "$INFO" "Setting directory ownership (aundekiosk owns the install tree so it can write config.json; root reclaims 'privileged' so a dashboard-level bug can never rewrite a script sudo will run as root)..."
chown -R aundekiosk:aundekiosk "$AUNDEKIOSK_INSTALL_DIR"
chown -R root:root "$AUNDEKIOSK_INSTALL_DIR/privileged"
chmod -R go-w "$AUNDEKIOSK_INSTALL_DIR/privileged"
```

to:

```bash
msg "$INFO" "Setting directory ownership (aundekiosk owns the install tree so it can write config.json; root reclaims 'privileged' and 'recovery' so a dashboard-level bug can never rewrite a script sudo/root will run)..."
chown -R aundekiosk:aundekiosk "$AUNDEKIOSK_INSTALL_DIR"
chown -R root:root "$AUNDEKIOSK_INSTALL_DIR/privileged"
chmod -R go-w "$AUNDEKIOSK_INSTALL_DIR/privileged"
chown -R root:root "$AUNDEKIOSK_INSTALL_DIR/recovery"
chmod -R go-w "$AUNDEKIOSK_INSTALL_DIR/recovery"
```

Then, right after the existing sudoers block (immediately after this existing line: `install -m 0440 "$SUDOERS_SRC" "$SUDOERS_DST"`), add:

```bash

msg "$INFO" "Installing the aundekiosk-recover command (standalone password-recovery tool; never installed as a service)..."
install -m 0755 "$AUNDEKIOSK_INSTALL_DIR/scripts/setup/aundekiosk-recover-wrapper.sh" /usr/local/bin/aundekiosk-recover
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash tests/setup/install_test.sh`
Expected: PASS — all assertions, including the 4 new ones.

- [ ] **Step 5: Run the full bash and Deno suites one more time**

Run: `bash tests/run_all.sh`
Expected: "All bash test suites passed."

Run: `deno test --allow-read --allow-write --allow-net --allow-env --allow-run dashboard/ recovery/`
Expected: PASS, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add scripts/setup/install.sh tests/setup/install_test.sh
git commit -m "feat: install the aundekiosk-recover command and harden recovery/ ownership"
```

---

## Deployment Note (not a task — for whoever executes this plan)

This plan does not include a deploy/verify-on-the-real-Pi step as one of its numbered tasks, because every prior sub-project in this series (A, B, C) deployed and verified on the real production Pi as a final step outside the plan itself, using `scripts/setup/update.sh` over SSH, following the same pattern: push → `sudo bash update.sh` on the Pi → check `systemctl is-active` on all 4 services → confirm `/usr/local/bin/aundekiosk-recover` exists with the right permissions. Do the same here once all 6 tasks are complete and the final review has passed. Do not actually run `aundekiosk-recover` against the live `auth.db` as part of verification — its only safe real-world use is a genuine lockout, not a routine check (structural checks, same as every other sub-project's production verification: service health, file presence/permissions, confirming `recovery/` is root-owned).
