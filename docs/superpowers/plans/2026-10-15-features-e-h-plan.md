# AundeKiosk Features E–H Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user roles (admin vs viewer), device status display, configurable scheduled reboot, and automatic config rollback on crash loop to the AundeKiosk dashboard.

**Architecture:** Role is stored in `credential_store.ts` → read at login → stored in `session_store.ts` → returned by `requireSession` → checked by a new `requireAdmin()` helper in `server.ts`. All other features are new API modules wired into the same handler. Privileged scripts follow the existing pattern (JSON via stdin, fake bin in tests).

**Tech Stack:** Deno/TypeScript (dashboard), Bash (privileged scripts), systemd units

**Spec:** `docs/superpowers/specs/2026-10-15-features-e-h-design.md`

## Global Constraints

- Deno test command (from `dashboard/`): `deno test --allow-read --allow-write --allow-env .`
- Shell test command (from project root): `bash tests/privileged/<test>.sh`
- All new shell scripts: `set -euo pipefail`, source `privileged/lib.sh` if they validate input
- Privileged scripts accept JSON via stdin (not CLI args) for structured input; single-word args for simple commands (matching existing scripts)
- New sudoers lines: add to `privileged/sudoers.d/aundekiosk`; update `tests/privileged/sudoers_test.sh`
- Locale keys must be added to all three files: `tr.json`, `en.json`, `de.json`
- Backward compatibility: legacy `auth.db` files without `role` field treat the user as `"admin"`
- `dashboard/deno.json` test glob includes all `*_test.ts` files in all subdirs

## Review Focus

1. **Legacy login session role**: a Pi already running has auth.db in old format (no `role`). After upgrade, login must succeed and the session role must be `"admin"`, not throw or produce undefined. → Tested in Task 1 (credential_store_test) and Task 2 (auth_api_test).
2. **Viewer 403 vs 401**: a viewer calling `POST /hostname-config` must get 403 (session exists, wrong role), not 401 (no session) — the distinction matters for UI handling. → Tested in Task 3.
3. **`manage-reboot-timer.sh` time injection safety**: the HH:MM values are interpolated into the timer file's `OnCalendar=` line; a value like `03:00\nExecStart=malicious` must be rejected before it reaches the file write. → Tested in Task 5 (invalid time cases).
4. **`recover-config.sh` no-backup path**: if `/opt/aundekiosk/config.json.backup` does not exist, the script must exit 1 with a clear message, never attempt to restore a missing or partial file. → Tested in Task 8.
5. **Dashboard `--allow-read` for new paths**: `GET /device-info` reads `/etc/dhcpcd.conf` and `/etc/resolv.conf`; `GET /reboot-schedule` reads `/etc/systemd/system/aundekiosk-reboot.timer` — all outside `/opt/aundekiosk`. If `aundekiosk-dashboard.service.template` is not updated, these endpoints crash in production with NotCapable. → Verified in `tests/services/templates_test.sh` in Task 6.

---

## Task 1: Credential store and session store role field

**Files:**
- Modify: `dashboard/auth/credential_store.ts`
- Modify: `dashboard/auth/session_store.ts`
- Modify: `dashboard/auth/credential_store_test.ts`
- Modify: `dashboard/auth/session_store_test.ts` (or create if test file does not exist yet)

**Interfaces:**
- Consumes: nothing from other tasks
- Produces:
  - `UserRecord.role: "admin" | "viewer"` (with fallback for legacy records)
  - `credentialStore.createUser(username, password, email, role)` — role param added
  - `credentialStore.getUserRole(username): Promise<"admin" | "viewer" | null>` — new
  - `sessionStore.createSession(username, role, now?)` — role param added
  - `sessionStore.touch(token, now?) → { username, role } | null` — role in return type

- [ ] **Step 1: Write failing test — credential store role**

In `dashboard/auth/credential_store_test.ts`, add:

```typescript
Deno.test("createUser stores viewer role and listUsers returns it", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    await store.createUser("viewer1", "another-long-pass", null, "viewer");
    const users = await store.listUsers();
    const v = users.find((u) => u.username === "viewer1");
    assertEquals(v?.role, "viewer");
  });
});

Deno.test("createInitialAdmin always produces an admin role", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const users = await store.listUsers();
    assertEquals(users[0].role, "admin");
  });
});

Deno.test("getUserRole returns admin for legacy record without role field", async () => {
  await withTempStore(async (storePath) => {
    // Write a legacy-format file (flat object, no role field)
    await Deno.writeTextFile(
      storePath,
      JSON.stringify({
        username: "admin",
        passwordHash: "irrelevant",
        failedAttempts: 0,
        lockedUntil: null,
      }),
    );
    const store = createCredentialStore({ storePath });
    assertEquals(await store.getUserRole("admin"), "admin");
  });
});

Deno.test("getUserRole returns null for unknown user", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    assertEquals(await store.getUserRole("nobody"), null);
  });
});
```

- [ ] **Step 2: Run test — confirm FAIL**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env auth/credential_store_test.ts
```
Expected: FAIL — `createUser` takes 3 args, `getUserRole` does not exist, role missing

- [ ] **Step 3: Implement credential_store.ts changes**

Add `role: "admin" | "viewer"` to `UserRecord`. Update `isLegacyFormat` path to set `role: "admin"`. Add `getUserRoleLocked`. Update `createUserLocked` and `createUser` to accept `role: "admin" | "viewer" = "admin"`. When reading new-format records, default absent `role` to `"admin"`.

Key changes:
```typescript
interface UserRecord {
  username: string;
  email: string | null;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: number | null;
  role: "admin" | "viewer";  // add
}

// In read(), when parsing new-format users:
file.users = parsed.users.map((u: UserRecord) => ({
  ...u,
  role: (u.role === "admin" || u.role === "viewer") ? u.role : "admin",
}));

// createUserLocked signature change:
async function createUserLocked(
  username: string, password: string, email: string | null,
  role: "admin" | "viewer" = "admin",
): Promise<void> {
  // ...
  file.users.push({ username, email, passwordHash, failedAttempts: 0, lockedUntil: null, role });
  // ...
}

// createInitialAdminLocked: no signature change — always admin
async function createInitialAdminLocked(username: string, password: string): Promise<void> {
  // ...
  await createUserLocked(username, password, null, "admin");
}

// new:
async function getUserRoleLocked(username: string): Promise<"admin" | "viewer" | null> {
  const file = await read();
  const user = file.users.find((u) => u.username === username);
  if (!user) return null;
  return user.role;
}

// expose in return object:
return {
  // ...existing...
  createUser: (username, password, email, role: "admin" | "viewer" = "admin") =>
    serialize(() => createUserLocked(username, password, email, role)),
  getUserRole: (username: string) => serialize(() => getUserRoleLocked(username)),
};
```

- [ ] **Step 4: Write failing test — session store role**

In `dashboard/auth/session_store_test.ts` (create if absent):

```typescript
import { createSessionStore } from "./session_store.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("createSession with viewer role — touch returns viewer role", () => {
  const store = createSessionStore({ idleTimeoutMs: 60_000 });
  const token = store.createSession("alice", "viewer");
  const session = store.touch(token);
  assertEquals(session?.username, "alice");
  assertEquals(session?.role, "viewer");
});

Deno.test("createSession with admin role — touch returns admin role", () => {
  const store = createSessionStore({ idleTimeoutMs: 60_000 });
  const token = store.createSession("bob", "admin");
  assertEquals(store.touch(token)?.role, "admin");
});

Deno.test("touch returns null for an expired session", () => {
  const store = createSessionStore({ idleTimeoutMs: 1_000 });
  const token = store.createSession("charlie", "admin", 0);
  assertEquals(store.touch(token, 2_000), null);
});
```

- [ ] **Step 5: Run session store test — confirm FAIL**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env auth/session_store_test.ts
```
Expected: FAIL — `createSession` takes 1 arg, `touch` returns no role

- [ ] **Step 6: Implement session_store.ts changes**

```typescript
interface SessionRecord {
  username: string;
  role: "admin" | "viewer";   // add
  lastActivityAt: number;
}

function createSession(username: string, role: "admin" | "viewer", now: number = Date.now()): string {
  const token = randomToken();
  sessions.set(token, { username, role, lastActivityAt: now });
  return token;
}

function touch(token: string, now: number = Date.now()): { username: string; role: "admin" | "viewer" } | null {
  // ...same expiry logic...
  return { username: record.username, role: record.role };
}
```

- [ ] **Step 7: Run all credential + session tests — confirm PASS**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env auth/credential_store_test.ts auth/session_store_test.ts
```
Expected: all PASS

- [ ] **Step 8: Run full suite to catch regressions**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env .
```
Expected: all existing tests PASS (auth_api_test.ts will need minor update — `createSession` call gains role arg)

> Note: `auth_api.ts` currently calls `sessionStore.createSession(username)` — this now requires a role arg. Fix the call to `sessionStore.createSession(username, "admin")` as a temporary shim in `auth_api.ts` so the suite passes; the real fix is in Task 2.

- [ ] **Step 9: Commit**

```bash
git add dashboard/auth/credential_store.ts dashboard/auth/session_store.ts \
  dashboard/auth/credential_store_test.ts dashboard/auth/session_store_test.ts
git commit -m "feat(auth): add role field to UserRecord and SessionRecord

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Session role propagation through auth_api

**Files:**
- Modify: `dashboard/auth/auth_api.ts`
- Modify: `dashboard/auth/auth_api_test.ts`

**Interfaces:**
- Consumes: `credentialStore.getUserRole` (Task 1), `sessionStore.createSession(username, role)` (Task 1)
- Produces:
  - `authApi.requireSession(req) → { username: string; role: "admin" | "viewer" } | null` — role now included
  - The temporary shim from Task 1 Step 9 is replaced by the real implementation here

- [ ] **Step 1: Write failing tests**

In `dashboard/auth/auth_api_test.ts`, add:

```typescript
Deno.test("requireSession after admin login returns admin role", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const api = createAuthApi({
      credentialStore: store,
      sessionStore: createSessionStore({ idleTimeoutMs: 30 * 60_000 }),
      rateLimiter: createRateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
      auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
    });
    const loginRes = await api.handleLogin(
      new Request("http://localhost/api/login", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
        headers: { "Content-Type": "application/json" },
      }),
      TEST_IP,
    );
    const cookie = loginRes.headers.get("set-cookie")!;
    const session = api.requireSession(
      new Request("http://localhost/", { headers: { cookie } }),
    );
    assertEquals(session?.role, "admin");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("requireSession after viewer login returns viewer role", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    await store.createUser("viewer1", "viewer-long-pass-12", null, "viewer");
    const api = createAuthApi({
      credentialStore: store,
      sessionStore: createSessionStore({ idleTimeoutMs: 30 * 60_000 }),
      rateLimiter: createRateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
      auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
    });
    const loginRes = await api.handleLogin(
      new Request("http://localhost/api/login", {
        method: "POST",
        body: JSON.stringify({ username: "viewer1", password: "viewer-long-pass-12" }),
        headers: { "Content-Type": "application/json" },
      }),
      TEST_IP,
    );
    const cookie = loginRes.headers.get("set-cookie")!;
    const session = api.requireSession(
      new Request("http://localhost/", { headers: { cookie } }),
    );
    assertEquals(session?.role, "viewer");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

- [ ] **Step 2: Run test — confirm FAIL**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env auth/auth_api_test.ts
```
Expected: FAIL — `requireSession` still returns `{ username }` only

- [ ] **Step 3: Implement auth_api.ts changes**

In `handleLogin`, after the successful `verifyCredentials` call:
```typescript
const role = (await credentialStore.getUserRole(username)) ?? "admin";
const token = sessionStore.createSession(username, role);
```

Remove the temporary shim added in Task 1 (which was `createSession(username, "admin")`).

Update `requireSession` return type:
```typescript
function requireSession(req: Request): { username: string; role: "admin" | "viewer" } | null {
  const token = readSessionToken(req);
  if (!token) return null;
  return sessionStore.touch(token);
}
```

- [ ] **Step 4: Run test and full suite — confirm PASS**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env .
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/auth_api.ts dashboard/auth/auth_api_test.ts
git commit -m "feat(auth): propagate role through session at login time

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Role enforcement in users_api and server routing

**Files:**
- Modify: `dashboard/auth/users_api.ts`
- Modify: `dashboard/auth/users_api_test.ts`
- Modify: `dashboard/server.ts`
- Modify: `dashboard/server_test.ts`
- Modify: `dashboard/public/locales/tr.json`
- Modify: `dashboard/public/locales/en.json`
- Modify: `dashboard/public/locales/de.json`

**Interfaces:**
- Consumes: `requireSession → { username, role }` (Task 2)
- Produces:
  - `usersApi.handleCreate` accepts `role?: "admin" | "viewer"` in body (defaults to `"admin"`)
  - `usersApi.handleList` returns `role` per user
  - `requireAdmin(req): { username, role: "admin" } | Response` — new helper, internal to `server.ts`
  - All admin-only routes return 403 for viewer sessions

- [ ] **Step 1: Write failing tests — users_api role**

In `dashboard/auth/users_api_test.ts`, add:

```typescript
Deno.test("handleCreate stores viewer role when role:viewer is passed", async () => {
  await withUsersApi(async (api, store) => {
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const res = await api.handleCreate(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({
          username: "viewer1",
          password: "viewer-long-pass-12",
          email: null,
          confirmPassword: "a-long-enough-password",
          role: "viewer",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", TEST_IP,
    );
    assertEquals(res.status, 201);
    const users = await store.listUsers();
    assertEquals(users.find((u) => u.username === "viewer1")?.role, "viewer");
  });
});

Deno.test("handleCreate defaults to admin role when role is omitted", async () => {
  await withUsersApi(async (api, store) => {
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const res = await api.handleCreate(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({
          username: "user2",
          password: "user2-long-pass-12",
          email: null,
          confirmPassword: "a-long-enough-password",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", TEST_IP,
    );
    assertEquals(res.status, 201);
    const users = await store.listUsers();
    assertEquals(users.find((u) => u.username === "user2")?.role, "admin");
  });
});

Deno.test("handleCreate rejects an invalid role value", async () => {
  await withUsersApi(async (api, store) => {
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const res = await api.handleCreate(
      new Request("http://localhost/users", {
        method: "POST",
        body: JSON.stringify({
          username: "bad",
          password: "bad-long-pass-12",
          email: null,
          confirmPassword: "a-long-enough-password",
          role: "superadmin",
        }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", TEST_IP,
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("handleList returns role for each user", async () => {
  await withUsersApi(async (api, store) => {
    await store.createInitialAdmin("admin", "a-long-enough-password");
    await store.createUser("viewer1", "viewer-long-pass-12", null, "viewer");
    const res = await api.handleList();
    const data = await res.json() as Array<{ username: string; role: string }>;
    assertEquals(data.find((u) => u.username === "admin")?.role, "admin");
    assertEquals(data.find((u) => u.username === "viewer1")?.role, "viewer");
  });
});
```

Note: `withUsersApi` helper (add to test file) must expose the `credentialStore` so tests can call `createInitialAdmin` directly:

```typescript
async function withUsersApi(
  fn: (api: ReturnType<typeof createUsersApi>, store: ReturnType<typeof createCredentialStore>) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    const api = createUsersApi({
      credentialStore: store,
      stepUpGuard: createStepUpGuard({
        credentialStore: store,
        auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
      }),
      auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
    });
    await fn(api, store);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
```

- [ ] **Step 2: Run test — confirm FAIL**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env auth/users_api_test.ts
```

- [ ] **Step 3: Implement users_api.ts role handling**

In `handleCreate`:
```typescript
const { username: newUsername, password, email, confirmPassword, role } = body as Record<string, unknown>;
// after validation of other fields:
if (role !== undefined && role !== "admin" && role !== "viewer") {
  return new Response("role must be 'admin' or 'viewer'.", { status: 400 });
}
const userRole: "admin" | "viewer" = (role as "admin" | "viewer") ?? "admin";
// pass userRole to credentialStore.createUser:
await credentialStore.createUser(newUsername.trim(), password, email ?? null, userRole);
```

`handleList` already calls `credentialStore.listUsers()` which now includes `role` — no change needed there.

- [ ] **Step 4: Write failing test — server.ts viewer enforcement**

In `dashboard/server_test.ts`, add a helper and tests:

```typescript
async function loginAs(
  handle: Awaited<ReturnType<typeof createHandler>>,
  authStorePath: string,
  username: string,
  password: string,
  role: "admin" | "viewer",
): Promise<string> {
  // Create user directly via credential store
  const store = createCredentialStore({ storePath: authStorePath });
  if (username === "admin") {
    await store.createInitialAdmin(username, password);
  } else {
    // admin must exist first — createInitialAdmin was called before
    await store.createUser(username, password, null, role);
  }
  const loginRes = await handle(
    new Request("http://localhost/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  return loginRes.headers.get("set-cookie")!;
}

Deno.test("viewer session gets 403 on admin-only POST /hostname-config", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const adminCookie = await loginAs(handle, `${dir}/auth.db`, "admin", "a-long-enough-password", "admin");
    // Create viewer user now that admin exists
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    await store.createUser("viewer1", "viewer-long-pass-12", null, "viewer");
    const viewerCookie = await loginAs(
      handle, `${dir}/auth.db`, "viewer1", "viewer-long-pass-12", "viewer"
    );
    // viewer calling admin-only route → 403
    const res = await handle(
      new Request("http://localhost/hostname-config", {
        method: "POST",
        body: JSON.stringify({ hostname: "newname", confirmPassword: "viewer-long-pass-12" }),
        headers: { "Content-Type": "application/json", cookie: viewerCookie },
      }),
    );
    assertEquals(res.status, 403);
    // admin calling same route → not 403 (may fail for other reasons, but not auth)
    const adminRes = await handle(
      new Request("http://localhost/hostname-config", {
        method: "POST",
        body: JSON.stringify({ hostname: "newname", confirmPassword: "a-long-enough-password" }),
        headers: { "Content-Type": "application/json", cookie: adminCookie },
      }),
    );
    // Will throw from runPrivilegedChange (not wired in test) — but the auth check passed if status != 403
    assertEquals(adminRes.status === 403, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("viewer session can access GET /config (viewer-allowed route)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const adminCookie = await loginAs(handle, `${dir}/auth.db`, "admin", "a-long-enough-password", "admin");
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    await store.createUser("viewer1", "viewer-long-pass-12", null, "viewer");
    const viewerCookie = await loginAs(handle, `${dir}/auth.db`, "viewer1", "viewer-long-pass-12", "viewer");
    const res = await handle(
      new Request("http://localhost/config", { headers: { cookie: viewerCookie } }),
    );
    assertEquals(res.status, 200);
    void adminCookie;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

Add the `createCredentialStore` import to `server_test.ts`:
```typescript
import { createCredentialStore } from "./auth/credential_store.ts";
```

- [ ] **Step 5: Run test — confirm FAIL**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env server_test.ts
```

- [ ] **Step 6: Implement server.ts requireAdmin helper and route updates**

Add inside `createHandler`, after the `authApi` definition:

```typescript
function requireAdmin(req: Request): { username: string; role: "admin" } | Response {
  const session = authApi.requireSession(req);
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (session.role !== "admin") return new Response("Forbidden", { status: 403 });
  return session as { username: string; role: "admin" };
}
```

Then update every route that was `requireSession` + admin action:
- `/ssh-config`, `/os-password`, `/network-config`, `/network-confirm`, `/snmp-config`, `/vnc-config`, `/hostname-config` → change to use `requireAdmin` with the early-return pattern:

```typescript
if (url.pathname === "/hostname-config" && req.method === "POST") {
  const session = requireAdmin(req);
  if (session instanceof Response) return session;
  return hostnameApi.handleChange(req, session.username, ip);
}
```

Routes that stay as `requireSession` (viewer-allowed):
- `GET /config`, `POST /config`
- `GET /monitor-events` (read-only; viewers can see the monitor stream)

Routes that use `requireAdmin`:
- All POST/write endpoints
- `GET /users`, `POST /users`, `POST /users-delete`
- `GET /service-status`, `POST /service-control`
- `GET /audit-log`
- `GET /monitor-config`, `POST /monitor-config`
- `GET /apt-upgrade/status`, `POST /apt-upgrade/start`
- `GET /remote-access-status`

- [ ] **Step 7: Add locale keys (all three files)**

In `tr.json`, `en.json`, `de.json`, add:
```json
"users_role_label": "Rol",
"users_role_admin": "Yönetici",
"users_role_viewer": "Görüntüleyici"
```
(English: `"Role"`, `"Admin"`, `"Viewer"` — German: `"Rolle"`, `"Administrator"`, `"Betrachter"`)

- [ ] **Step 8: Run full suite — confirm PASS**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env .
```

- [ ] **Step 9: Commit**

```bash
git add dashboard/auth/users_api.ts dashboard/auth/users_api_test.ts \
  dashboard/server.ts dashboard/server_test.ts \
  dashboard/public/locales/tr.json dashboard/public/locales/en.json dashboard/public/locales/de.json
git commit -m "feat(auth): enforce admin/viewer roles on all dashboard routes

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Device info API (hostname + network status display)

**Files:**
- Create: `dashboard/device_info_api.ts`
- Create: `dashboard/device_info_api_test.ts`
- Modify: `dashboard/server.ts`
- Modify: `services/aundekiosk-dashboard.service.template`
- Modify: `tests/services/templates_test.sh`
- Modify: `dashboard/public/locales/tr.json`, `en.json`, `de.json`

**Interfaces:**
- Consumes: nothing from other tasks
- Produces: `GET /device-info → { hostname, interfaces: [...] }` — any authenticated session (admin or viewer)

- [ ] **Step 1: Write failing test**

Create `dashboard/device_info_api_test.ts`:

```typescript
import { createDeviceInfoApi } from "./device_info_api.ts";
import { assertEquals } from "./test_util.ts";

function makeApi(cmds: Record<string, string>, files: Record<string, string>) {
  return createDeviceInfoApi({
    runCommand: async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      const result = cmds[key];
      if (result === undefined) throw new Error(`Unexpected command: ${key}`);
      return result;
    },
    readFile: async (path) => {
      const result = files[path];
      if (result === undefined) {
        const e = new Deno.errors.NotFound(`${path} not found`);
        throw e;
      }
      return result;
    },
  });
}

Deno.test("handleGet returns hostname from hostname command", async () => {
  const api = makeApi(
    {
      "hostname": "kiosk-01",
      "ip -4 -json addr": "[]",
    },
    {},
  );
  const res = await api.handleGet();
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.hostname, "kiosk-01");
});

Deno.test("handleGet parses eth0 DHCP address from ip addr output", async () => {
  const ipOutput = JSON.stringify([
    {
      ifname: "eth0",
      addr_info: [{ family: "inet", local: "192.168.14.160", prefixlen: 24 }],
    },
  ]);
  const routeOutput = "default via 192.168.14.1 dev eth0 proto dhcp src 192.168.14.160 metric 100\n";
  const resolvConf = "nameserver 192.168.14.1\nnameserver 8.8.8.8\n";
  const dhcpcdConf = "# no static entries\n";

  const api = makeApi(
    {
      "hostname": "kiosk-01",
      "ip -4 -json addr": ipOutput,
      "ip -4 route show default dev eth0": routeOutput,
    },
    {
      "/etc/resolv.conf": resolvConf,
      "/etc/dhcpcd.conf": dhcpcdConf,
    },
  );

  const res = await api.handleGet();
  assertEquals(res.status, 200);
  const data = await res.json();
  const eth0 = data.interfaces[0];
  assertEquals(eth0.name, "eth0");
  assertEquals(eth0.mode, "dhcp");
  assertEquals(eth0.address, "192.168.14.160");
  assertEquals(eth0.prefix, 24);
  assertEquals(eth0.gateway, "192.168.14.1");
  assertEquals(eth0.dns, ["192.168.14.1", "8.8.8.8"]);
});

Deno.test("handleGet reports static mode when dhcpcd.conf has static entry for interface", async () => {
  const ipOutput = JSON.stringify([
    {
      ifname: "eth0",
      addr_info: [{ family: "inet", local: "192.168.14.50", prefixlen: 24 }],
    },
  ]);
  const dhcpcdConf = "interface eth0\nstatic ip_address=192.168.14.50/24\nstatic routers=192.168.14.1\n";

  const api = makeApi(
    {
      "hostname": "kiosk-02",
      "ip -4 -json addr": ipOutput,
      "ip -4 route show default dev eth0": "default via 192.168.14.1 dev eth0\n",
    },
    {
      "/etc/resolv.conf": "nameserver 8.8.8.8\n",
      "/etc/dhcpcd.conf": dhcpcdConf,
    },
  );

  const res = await api.handleGet();
  const data = await res.json();
  assertEquals(data.interfaces[0].mode, "static");
});

Deno.test("handleGet returns 200 with empty interfaces when ip addr returns no inet entries", async () => {
  const api = makeApi(
    { "hostname": "kiosk-03", "ip -4 -json addr": "[]" },
    {},
  );
  const res = await api.handleGet();
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.interfaces.length, 0);
});
```

- [ ] **Step 2: Run test — confirm FAIL**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env device_info_api_test.ts
```

- [ ] **Step 3: Implement device_info_api.ts**

```typescript
export interface DeviceInfoApiOptions {
  runCommand: (cmd: string, args: string[]) => Promise<string>;
  readFile: (path: string) => Promise<string>;
}

interface IpAddrEntry {
  ifname: string;
  addr_info: { family: string; local: string; prefixlen: number }[];
}

export function createDeviceInfoApi(opts: DeviceInfoApiOptions) {
  const { runCommand, readFile } = opts;

  async function getHostname(): Promise<string> {
    return (await runCommand("hostname", [])).trim();
  }

  async function getGateway(ifname: string): Promise<string | null> {
    try {
      const out = await runCommand("ip", ["-4", "route", "show", "default", "dev", ifname]);
      const m = out.match(/default via (\S+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  async function getDns(): Promise<string[]> {
    try {
      const content = await readFile("/etc/resolv.conf");
      return content
        .split("\n")
        .filter((l) => l.startsWith("nameserver "))
        .map((l) => l.replace("nameserver ", "").trim())
        .filter((s) => s.length > 0);
    } catch {
      return [];
    }
  }

  async function isStatic(ifname: string): Promise<boolean> {
    try {
      const content = await readFile("/etc/dhcpcd.conf");
      // A block starting with "interface <ifname>" that contains "static ip_address="
      const escaped = ifname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`interface\\s+${escaped}[\\s\\S]*?static\\s+ip_address=`, "m").test(content);
    } catch {
      return false;
    }
  }

  async function handleGet(): Promise<Response> {
    try {
      const [hostname, ipJson] = await Promise.all([
        getHostname(),
        runCommand("ip", ["-4", "-json", "addr"]),
      ]);

      let entries: IpAddrEntry[] = [];
      try {
        entries = JSON.parse(ipJson) as IpAddrEntry[];
      } catch {
        entries = [];
      }

      const dns = await getDns();

      const interfaces = await Promise.all(
        entries
          .filter((e) => e.addr_info.some((a) => a.family === "inet"))
          .map(async (e) => {
            const inet = e.addr_info.find((a) => a.family === "inet");
            const [gateway, staticMode] = await Promise.all([
              getGateway(e.ifname),
              isStatic(e.ifname),
            ]);
            return {
              name: e.ifname,
              mode: staticMode ? "static" : "dhcp",
              address: inet?.local ?? null,
              prefix: inet?.prefixlen ?? null,
              gateway,
              dns,
            };
          }),
      );

      return Response.json({ hostname, interfaces });
    } catch (error) {
      console.error("device-info error:", error);
      return new Response("Could not read device info.", { status: 500 });
    }
  }

  return { handleGet };
}
```

- [ ] **Step 4: Wire into server.ts**

Add import and create the API in `createHandler`:
```typescript
import { createDeviceInfoApi } from "./device_info_api.ts";

// Inside createHandler:
const deviceInfoApi = createDeviceInfoApi({
  runCommand: async (cmd, args) => {
    const c = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" });
    const { stdout } = await c.output();
    return new TextDecoder().decode(stdout);
  },
  readFile: (path) => Deno.readTextFile(path),
});

// In the routing block (after existing routes, before static handler):
if (url.pathname === "/device-info" && req.method === "GET") {
  if (!authApi.requireSession(req)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return deviceInfoApi.handleGet();
}
```

- [ ] **Step 5: Update dashboard service template**

In `services/aundekiosk-dashboard.service.template`, extend `--allow-run` and `--allow-read`:

```
--allow-run=sudo,systemctl,hostname,ip
--allow-read=/opt/aundekiosk,/var/run/reboot-required,/etc/dhcpcd.conf,/etc/resolv.conf,/etc/systemd/system/aundekiosk-reboot.timer
```

(The `/etc/systemd/system/aundekiosk-reboot.timer` read is needed for Task 6's `GET /reboot-schedule`.)

- [ ] **Step 6: Update templates_test.sh for new allow-run entries**

In `tests/services/templates_test.sh`, the existing check for `--allow-run=sudo,systemctl` must be updated to also accept `hostname` and `ip` in the list:

```bash
DASHBOARD_ALLOW_RUN=$(grep -o "allow-run=[^ ]*" "$SERVICES_DIR/aundekiosk-dashboard.service.template" | cut -d= -f2)

for cmd in sudo systemctl hostname ip; do
  case ",$DASHBOARD_ALLOW_RUN," in
    *",$cmd,"*)
      assert_eq "granted" "granted" "aundekiosk-dashboard.service.template --allow-run includes $cmd"
      ;;
    *)
      assert_eq "granted" "missing" "aundekiosk-dashboard.service.template --allow-run includes $cmd"
      ;;
  esac
done
```

Remove or update the old `allow-run=sudo,systemctl` pair check that would now fail.

- [ ] **Step 7: Add locale keys**

`tr.json`: `"device_info_heading": "Cihaz Durumu"`, `"device_info_hostname_label": "Cihaz Adı"`, `"device_info_mode_dhcp": "DHCP"`, `"device_info_mode_static": "Statik"`, `"device_info_mode_unknown": "Bilinmiyor"`, `"device_info_address_label": "IP Adresi"`, `"device_info_gateway_label": "Ağ Geçidi"`, `"device_info_dns_label": "DNS"`, `"device_info_loading": "Yükleniyor…"`, `"device_info_unavailable": "Bilgi alınamadı"`

`en.json` equivalents in English, `de.json` in German.

- [ ] **Step 8: Run full suite (Deno + templates test)**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env .
bash tests/services/templates_test.sh
```
Expected: all PASS

- [ ] **Step 9: Commit**

```bash
git add dashboard/device_info_api.ts dashboard/device_info_api_test.ts \
  dashboard/server.ts services/aundekiosk-dashboard.service.template \
  tests/services/templates_test.sh \
  dashboard/public/locales/tr.json dashboard/public/locales/en.json dashboard/public/locales/de.json
git commit -m "feat: add device info endpoint (hostname + network status)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Scheduled reboot — privileged script and systemd templates

**Files:**
- Create: `privileged/manage-reboot-timer.sh`
- Create: `tests/privileged/manage_reboot_timer_test.sh`
- Create: `services/aundekiosk-reboot.service.template`
- Modify: `privileged/sudoers.d/aundekiosk`
- Modify: `tests/privileged/sudoers_test.sh`

**Interfaces:**
- Consumes: nothing from other tasks
- Produces:
  - `privileged/manage-reboot-timer.sh` — reads `{ "action": "enable", "time": "HH:MM" }` or `{ "action": "disable" }` from stdin
  - Creates/removes `/etc/systemd/system/aundekiosk-reboot.{timer,service}`
  - Sudoers: `aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/manage-reboot-timer.sh`

- [ ] **Step 1: Write failing test**

Create `tests/privileged/manage_reboot_timer_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/manage-reboot-timer.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$WORKDIR/systemctl.log"
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_TIMER_FILE="$WORKDIR/aundekiosk-reboot.timer"
export AUNDEKIOSK_TEST_SERVICE_FILE="$WORKDIR/aundekiosk-reboot.service"
export WORKDIR

# Case 1: enable with valid time writes timer file with correct OnCalendar
echo '{"action":"enable","time":"03:00"}' | bash "$HELPER"
assert_status 0 $? "manage-reboot-timer.sh enable exits 0"

grep -q "^OnCalendar=\*-\*-\* 03:00:00$" "$AUNDEKIOSK_TEST_TIMER_FILE"
assert_status 0 $? "timer file contains the correct OnCalendar line"

[ -f "$AUNDEKIOSK_TEST_SERVICE_FILE" ]
assert_status 0 $? "service file is created alongside the timer file"

grep -q "daemon-reload" "$WORKDIR/systemctl.log"
assert_status 0 $? "systemctl daemon-reload was called"

grep -q "enable --now aundekiosk-reboot.timer" "$WORKDIR/systemctl.log"
assert_status 0 $? "systemctl enables the timer"

# Case 2: enable with invalid time (25:00) exits 1
: > "$WORKDIR/systemctl.log"
echo '{"action":"enable","time":"25:00"}' | bash "$HELPER"
assert_status 1 $? "manage-reboot-timer.sh rejects hour 25"

[ ! -f "$AUNDEKIOSK_TEST_TIMER_FILE" ] || grep -qv "25:00" "$AUNDEKIOSK_TEST_TIMER_FILE"
assert_status 0 $? "invalid time does not produce a timer file with 25:00"

# Case 3: enable with newline injection attempt exits 1 (HH:MM pattern disallows it)
echo '{"action":"enable","time":"03:00\nExecStart=evil"}' | bash "$HELPER"
assert_status 1 $? "manage-reboot-timer.sh rejects time with embedded newline"

# Case 4: disable removes files and calls systemctl
echo '{"action":"enable","time":"04:00"}' | bash "$HELPER"  # re-enable so files exist
echo '{"action":"disable"}' | bash "$HELPER"
assert_status 0 $? "disable exits 0"

[ ! -f "$AUNDEKIOSK_TEST_TIMER_FILE" ]
assert_status 0 $? "timer file is removed after disable"

[ ! -f "$AUNDEKIOSK_TEST_SERVICE_FILE" ]
assert_status 0 $? "service file is removed after disable"

# Case 5: unknown action exits 1
echo '{"action":"unknown"}' | bash "$HELPER"
assert_status 1 $? "unknown action exits 1"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Run test — confirm FAIL**

```bash
bash tests/privileged/manage_reboot_timer_test.sh
```
Expected: FAIL — script does not exist

- [ ] **Step 3: Implement manage-reboot-timer.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

TIMER_FILE="${AUNDEKIOSK_TEST_TIMER_FILE:-/etc/systemd/system/aundekiosk-reboot.timer}"
SERVICE_FILE="${AUNDEKIOSK_TEST_SERVICE_FILE:-/etc/systemd/system/aundekiosk-reboot.service}"

INPUT=$(cat)
action=$(printf '%s' "$INPUT" | jq -r '.action // empty' 2>/dev/null || true)
time_val=$(printf '%s' "$INPUT" | jq -r '.time // empty' 2>/dev/null || true)

is_valid_hhmm() {
  [[ "$1" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]
}

case "$action" in
  enable)
    if ! is_valid_hhmm "${time_val:-}"; then
      echo "Invalid time '${time_val:-}'. Expected HH:MM (00:00-23:59)." >&2
      exit 1
    fi
    HH="${time_val%%:*}"
    MM="${time_val##*:}"

    cat > "$TIMER_FILE" <<TIMER_EOF
[Unit]
Description=AundeKiosk scheduled daily reboot

[Timer]
OnCalendar=*-*-* ${HH}:${MM}:00
Persistent=true

[Install]
WantedBy=timers.target
TIMER_EOF

    cat > "$SERVICE_FILE" <<'SERVICE_EOF'
[Unit]
Description=AundeKiosk scheduled reboot

[Service]
Type=oneshot
ExecStart=/sbin/reboot
SERVICE_EOF

    systemctl daemon-reload
    systemctl enable --now aundekiosk-reboot.timer
    ;;

  disable)
    systemctl disable --now aundekiosk-reboot.timer 2>/dev/null || true
    rm -f "$TIMER_FILE" "$SERVICE_FILE"
    systemctl daemon-reload
    ;;

  *)
    echo "Unknown action '${action:-}'. Use 'enable' or 'disable'." >&2
    exit 1
    ;;
esac
```

- [ ] **Step 4: Create services/aundekiosk-reboot.service.template**

```ini
[Unit]
Description=AundeKiosk scheduled reboot

[Service]
Type=oneshot
ExecStart=/sbin/reboot
```

(This is documentation; the actual file is written by manage-reboot-timer.sh. It does NOT need to be installed by install.sh.)

- [ ] **Step 5: Update sudoers file**

In `privileged/sudoers.d/aundekiosk`, add:
```
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/manage-reboot-timer.sh
```

- [ ] **Step 6: Update sudoers_test.sh**

Add to `tests/privileged/sudoers_test.sh`:
```bash
grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/manage-reboot-timer.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the manage-reboot-timer.sh line"
```

- [ ] **Step 7: Run tests — confirm PASS**

```bash
chmod +x privileged/manage-reboot-timer.sh
bash tests/privileged/manage_reboot_timer_test.sh
bash tests/privileged/sudoers_test.sh
```
Expected: all PASS

- [ ] **Step 8: Commit**

```bash
git add privileged/manage-reboot-timer.sh tests/privileged/manage_reboot_timer_test.sh \
  services/aundekiosk-reboot.service.template \
  privileged/sudoers.d/aundekiosk tests/privileged/sudoers_test.sh
git commit -m "feat: add manage-reboot-timer.sh privileged script for daily reboot scheduling

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Scheduled reboot API

**Files:**
- Create: `dashboard/reboot_schedule_api.ts`
- Create: `dashboard/reboot_schedule_api_test.ts`
- Modify: `dashboard/server.ts`
- Modify: `dashboard/public/locales/tr.json`, `en.json`, `de.json`

**Interfaces:**
- Consumes: `requireAdmin` from Task 3
- Produces:
  - `GET /reboot-schedule` → `{ enabled: boolean, time: string | null }` — any authenticated session
  - `POST /reboot-schedule` → enable/update timer — admin + step-up
  - `DELETE /reboot-schedule` → disable — admin + step-up

- [ ] **Step 1: Write failing test**

Create `dashboard/reboot_schedule_api_test.ts`:

```typescript
import { createRebootScheduleApi } from "./reboot_schedule_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createStepUpGuard } from "./auth/step_up.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { assertEquals } from "./test_util.ts";

async function withApi(
  timerContent: string | null,
  fn: (
    api: ReturnType<typeof createRebootScheduleApi>,
    calls: string[],
  ) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const calls: string[] = [];
  try {
    const store = createCredentialStore({ storePath: `${dir}/auth.db` });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const api = createRebootScheduleApi({
      stepUpGuard: createStepUpGuard({
        credentialStore: store,
        auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
      }),
      auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
      runPrivilegedManage: async (payload) => {
        calls.push(JSON.stringify(payload));
      },
      readTimerFile: async () => {
        if (timerContent === null) throw new Deno.errors.NotFound("not found");
        return timerContent;
      },
    });
    await fn(api, calls);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("handleGet returns enabled:true and time when timer file exists", async () => {
  const content = "[Timer]\nOnCalendar=*-*-* 03:00:00\nPersistent=true\n";
  await withApi(content, async (api) => {
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.enabled, true);
    assertEquals(data.time, "03:00");
  });
});

Deno.test("handleGet returns enabled:false when timer file does not exist", async () => {
  await withApi(null, async (api) => {
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.enabled, false);
    assertEquals(data.time, null);
  });
});

Deno.test("handleSet calls runPrivilegedManage with enable+time on valid input", async () => {
  await withApi(null, async (api, calls) => {
    const res = await api.handleSet(
      new Request("http://localhost/reboot-schedule", {
        method: "POST",
        body: JSON.stringify({ time: "03:00", confirmPassword: "a-long-enough-password" }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", "127.0.0.1",
    );
    assertEquals(res.status, 200);
    assertEquals(calls.length, 1);
    assertEquals(JSON.parse(calls[0]).action, "enable");
    assertEquals(JSON.parse(calls[0]).time, "03:00");
  });
});

Deno.test("handleSet rejects invalid time format", async () => {
  await withApi(null, async (api) => {
    const res = await api.handleSet(
      new Request("http://localhost/reboot-schedule", {
        method: "POST",
        body: JSON.stringify({ time: "25:00", confirmPassword: "a-long-enough-password" }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", "127.0.0.1",
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("handleDelete calls runPrivilegedManage with disable", async () => {
  const content = "[Timer]\nOnCalendar=*-*-* 03:00:00\n";
  await withApi(content, async (api, calls) => {
    const res = await api.handleDelete(
      new Request("http://localhost/reboot-schedule", {
        method: "DELETE",
        body: JSON.stringify({ confirmPassword: "a-long-enough-password" }),
        headers: { "Content-Type": "application/json" },
      }),
      "admin", "127.0.0.1",
    );
    assertEquals(res.status, 200);
    assertEquals(JSON.parse(calls[0]).action, "disable");
  });
});
```

- [ ] **Step 2: Run test — confirm FAIL**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env reboot_schedule_api_test.ts
```

- [ ] **Step 3: Implement reboot_schedule_api.ts**

```typescript
import type { createStepUpGuard } from "./auth/step_up.ts";
import type { createAuditLog } from "./auth/audit_log.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ONCALENDAR_PATTERN = /^OnCalendar=\*-\*-\* (\d{2}:\d{2}):\d{2}$/m;

export interface RebootScheduleApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  auditLog: ReturnType<typeof createAuditLog>;
  runPrivilegedManage: (payload: { action: string; time?: string }) => Promise<void>;
  readTimerFile: () => Promise<string>;
}

export function createRebootScheduleApi(opts: RebootScheduleApiOptions) {
  const { stepUpGuard, auditLog, runPrivilegedManage, readTimerFile } = opts;

  async function handleGet(): Promise<Response> {
    try {
      const content = await readTimerFile();
      const match = content.match(ONCALENDAR_PATTERN);
      return Response.json(match
        ? { enabled: true, time: match[1] }
        : { enabled: false, time: null });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return Response.json({ enabled: false, time: null });
      }
      throw error;
    }
  }

  async function handleSet(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try { body = await req.json(); } catch { return new Response("Invalid JSON.", { status: 400 }); }
    const { time, confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) return new Response(stepUp.message, { status: stepUp.status });

    if (typeof time !== "string" || !TIME_PATTERN.test(time)) {
      return new Response("time must be HH:MM (00:00-23:59).", { status: 400 });
    }

    await runPrivilegedManage({ action: "enable", time });
    await auditLog.record("reboot_schedule_enabled", { username, ip, time, ok: true });
    return new Response(`Reboot scheduled at ${time} daily.`, { status: 200 });
  }

  async function handleDelete(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try { body = await req.json(); } catch { return new Response("Invalid JSON.", { status: 400 }); }
    const { confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) return new Response(stepUp.message, { status: stepUp.status });

    await runPrivilegedManage({ action: "disable" });
    await auditLog.record("reboot_schedule_disabled", { username, ip, ok: true });
    return new Response("Scheduled reboot disabled.", { status: 200 });
  }

  return { handleGet, handleSet, handleDelete };
}
```

- [ ] **Step 4: Wire into server.ts**

Add import and instance in `createHandler`. Default timer path:

```typescript
const DEFAULT_REBOOT_TIMER_PATH = "/etc/systemd/system/aundekiosk-reboot.timer";

// In HandlerOptions:
rebootTimerPath?: string;

// In createHandler:
const rebootTimerPath = options.rebootTimerPath ?? DEFAULT_REBOOT_TIMER_PATH;

import { createRebootScheduleApi } from "./reboot_schedule_api.ts";

const rebootScheduleApi = createRebootScheduleApi({
  stepUpGuard: createStepUpGuard({
    credentialStore: createCredentialStore({ storePath: authStorePath }),
    auditLog: createAuditLog({ logPath: auditLogPath }),
  }),
  auditLog: createAuditLog({ logPath: auditLogPath }),
  runPrivilegedManage: async (payload) => {
    await runPrivilegedCommand(
      "sudo",
      ["/opt/aundekiosk/privileged/manage-reboot-timer.sh"],
      JSON.stringify(payload),
    );
  },
  readTimerFile: () => Deno.readTextFile(rebootTimerPath),
});
```

Routes:
```typescript
if (url.pathname === "/reboot-schedule") {
  if (req.method === "GET") {
    if (!authApi.requireSession(req)) return new Response("Unauthorized", { status: 401 });
    return rebootScheduleApi.handleGet();
  }
  if (req.method === "POST") {
    const session = requireAdmin(req);
    if (session instanceof Response) return session;
    return rebootScheduleApi.handleSet(req, session.username, ip);
  }
  if (req.method === "DELETE") {
    const session = requireAdmin(req);
    if (session instanceof Response) return session;
    return rebootScheduleApi.handleDelete(req, session.username, ip);
  }
  return new Response("Method Not Allowed", { status: 405 });
}
```

- [ ] **Step 5: Add audit log locale keys to all three locale files**

`tr.json`: `"audit_event_reboot_schedule_enabled": "{username} günlük yeniden başlatmayı {time} olarak ayarladı ({status}) (IP: {ip})"`, `"audit_event_reboot_schedule_disabled": "{username} planlı yeniden başlatmayı devre dışı bıraktı ({status}) (IP: {ip})"`

Add matching keys in `en.json` and `de.json`.

Also add UI keys: `"reboot_schedule_heading"`, `"reboot_schedule_enabled_label"`, `"reboot_schedule_time_label"`, `"reboot_schedule_save_button"`, `"reboot_schedule_disable_button"`, `"reboot_schedule_next_hint"`, `"reboot_schedule_disabled_hint"` in all three files.

- [ ] **Step 6: Run full suite — confirm PASS**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env .
bash tests/services/templates_test.sh
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/reboot_schedule_api.ts dashboard/reboot_schedule_api_test.ts \
  dashboard/server.ts \
  dashboard/public/locales/tr.json dashboard/public/locales/en.json dashboard/public/locales/de.json
git commit -m "feat: add scheduled reboot API (GET/POST/DELETE /reboot-schedule)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Config backup on save and backup info endpoint

**Files:**
- Modify: `dashboard/config_api.ts`
- Modify: `dashboard/config_api_test.ts`
- Modify: `dashboard/server.ts`
- Modify: `dashboard/public/locales/tr.json`, `en.json`, `de.json`

**Interfaces:**
- Consumes: nothing from other tasks
- Produces:
  - `configApi.handlePost` writes `<configPath>.backup` atomically after each successful save
  - `configApi.handleBackupInfo()` — new method; returns `{ hasBackup, backupAgeSeconds }`
  - `GET /config-backup-info` → any authenticated session

- [ ] **Step 1: Write failing tests**

In `dashboard/config_api_test.ts`, add:

```typescript
Deno.test("handlePost writes a backup file alongside config.json after a successful save", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/config.json.sample` });
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const body = JSON.stringify({ urls: [{ url: "https://example.com", duration: 10, cycles: 0 }] });
    const res = await api.handlePost(new Request("http://localhost/config", {
      method: "POST", body, headers: { "Content-Type": "application/json" },
    }));
    assertEquals(res.status, 200);
    const backup = await Deno.readTextFile(`${configPath}.backup`);
    const parsed = JSON.parse(backup);
    assertEquals(parsed.urls[0].url, "https://example.com");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("handlePost does not write a backup when the save fails (invalid JSON)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/config.json.sample` });
    const res = await api.handlePost(new Request("http://localhost/config", {
      method: "POST", body: "not json",
    }));
    assertEquals(res.status, 400);
    let threw = false;
    try { await Deno.stat(`${configPath}.backup`); } catch { threw = true; }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("handleBackupInfo returns hasBackup:false before any save", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const api = createConfigApi({ configPath: `${dir}/config.json`, samplePath: `${dir}/config.json.sample` });
    const res = await api.handleBackupInfo();
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.hasBackup, false);
    assertEquals(data.backupAgeSeconds, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("handleBackupInfo returns hasBackup:true after a save", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/config.json.sample` });
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    await api.handlePost(new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [] }),
      headers: { "Content-Type": "application/json" },
    }));
    const res = await api.handleBackupInfo();
    const data = await res.json();
    assertEquals(data.hasBackup, true);
    assertEquals(typeof data.backupAgeSeconds, "number");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

- [ ] **Step 2: Run test — confirm FAIL**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env config_api_test.ts
```

- [ ] **Step 3: Implement config_api.ts changes**

After the `await Deno.rename(tmpPath, configPath)` line in `handlePost`, add:

```typescript
// Best-effort backup — failure is non-fatal since the main save already succeeded.
const backupPath = `${configPath}.backup`;
const backupTmpPath = `${backupPath}.tmp-${crypto.randomUUID()}`;
try {
  await Deno.writeTextFile(backupTmpPath, JSON.stringify(normalized, null, 2));
  try { await Deno.chmod(backupTmpPath, 0o644); } catch { /* no-op on Windows */ }
  await Deno.rename(backupTmpPath, backupPath);
} catch {
  // Backup failure does not fail the config save.
}
```

Add `handleBackupInfo`:

```typescript
async function handleBackupInfo(): Promise<Response> {
  const backupPath = `${configPath}.backup`;
  try {
    const stat = await Deno.stat(backupPath);
    const mtimeMs = stat.mtime?.getTime() ?? Date.now();
    const backupAgeSeconds = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
    return Response.json({ hasBackup: true, backupAgeSeconds });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return Response.json({ hasBackup: false, backupAgeSeconds: null });
    }
    throw error;
  }
}

return { handleGet, handlePost, handleBackupInfo };
```

- [ ] **Step 4: Wire GET /config-backup-info into server.ts**

```typescript
if (url.pathname === "/config-backup-info" && req.method === "GET") {
  if (!authApi.requireSession(req)) return new Response("Unauthorized", { status: 401 });
  return configApi.handleBackupInfo();
}
```

- [ ] **Step 5: Add locale keys**

`tr.json`: `"config_backup_age_hint": "Son yedek: {age} önce alındı"`
`en.json`: `"config_backup_age_hint": "Last backup: {age} ago"`
`de.json`: `"config_backup_age_hint": "Letzte Sicherung: vor {age}"`

- [ ] **Step 6: Run full suite — confirm PASS**

```bash
cd dashboard && deno test --allow-read --allow-write --allow-env .
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/config_api.ts dashboard/config_api_test.ts \
  dashboard/server.ts \
  dashboard/public/locales/tr.json dashboard/public/locales/en.json dashboard/public/locales/de.json
git commit -m "feat: write config.json.backup on every successful save, expose backup info endpoint

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Crash recovery — privileged script and service templates

**Files:**
- Create: `privileged/recover-config.sh`
- Create: `tests/privileged/recover_config_test.sh`
- Create: `services/aundekiosk-recovery.service.template`
- Modify: `services/aundekiosk-runner.service.template`
- Modify: `scripts/setup/install.sh`
- Modify: `tests/services/templates_test.sh`

**Interfaces:**
- Consumes: `config.json.backup` written by Task 7
- Produces:
  - `recover-config.sh` — restores backup, resets failed state, starts runner
  - `aundekiosk-recovery.service` — invoked by systemd's `OnFailure=` on the runner
  - `aundekiosk-runner.service` gains `OnFailure=aundekiosk-recovery.service`, `StartLimitBurst=5`, `StartLimitIntervalSec=300`
  - No sudoers entry needed — this service runs as root directly (not via dashboard sudo)

- [ ] **Step 1: Write failing test**

Create `tests/privileged/recover_config_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/recover-config.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$WORKDIR/systemctl.log"
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export WORKDIR
export AUNDEKIOSK_TEST_CONFIG_PATH="$WORKDIR/config.json"
export AUNDEKIOSK_TEST_AUDIT_LOG="$WORKDIR/audit.log"

# Case 1: no backup exists → exits 1 with error message
bash "$HELPER" 2>"$WORKDIR/stderr.txt"
assert_status 1 $? "recover-config.sh exits 1 when no backup exists"
grep -q "No backup" "$WORKDIR/stderr.txt"
assert_status 0 $? "recover-config.sh prints a clear message when no backup exists"

# Case 2: backup exists → config restored, systemctl called, audit log written
echo '{"urls":[{"url":"https://backup.test","duration":5,"cycles":0}]}' > "${AUNDEKIOSK_TEST_CONFIG_PATH}.backup"
bash "$HELPER"
assert_status 0 $? "recover-config.sh exits 0 when backup exists"

[ -f "$AUNDEKIOSK_TEST_CONFIG_PATH" ]
assert_status 0 $? "config.json is restored from backup"

grep -q '"url":"https://backup.test"' "$AUNDEKIOSK_TEST_CONFIG_PATH"
assert_status 0 $? "restored config.json contains the backup content"

grep -q "reset-failed aundekiosk-runner" "$WORKDIR/systemctl.log"
assert_status 0 $? "systemctl reset-failed aundekiosk-runner was called"

grep -q "start aundekiosk-runner" "$WORKDIR/systemctl.log"
assert_status 0 $? "systemctl start aundekiosk-runner was called"

grep -q '"event":"crash_recovery"' "$AUNDEKIOSK_TEST_AUDIT_LOG"
assert_status 0 $? "audit log contains a crash_recovery event"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Run test — confirm FAIL**

```bash
bash tests/privileged/recover_config_test.sh
```

- [ ] **Step 3: Implement recover-config.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${AUNDEKIOSK_TEST_CONFIG_PATH:-/opt/aundekiosk/config.json}"
BACKUP_PATH="${CONFIG_PATH}.backup"
AUDIT_LOG="${AUNDEKIOSK_TEST_AUDIT_LOG:-/opt/aundekiosk/audit.log}"

if [ ! -f "$BACKUP_PATH" ]; then
  echo "No backup found at $BACKUP_PATH; cannot recover." >&2
  exit 1
fi

TMP_PATH="${CONFIG_PATH}.tmp-recovery-$$"
cp "$BACKUP_PATH" "$TMP_PATH"
chmod 0644 "$TMP_PATH" 2>/dev/null || true
mv "$TMP_PATH" "$CONFIG_PATH"

TS=$(date +%s%3N 2>/dev/null || echo "0")
printf '{"event":"crash_recovery","ts":%s,"ok":true}\n' "$TS" >> "$AUDIT_LOG"

systemctl reset-failed aundekiosk-runner 2>/dev/null || true
systemctl start aundekiosk-runner
```

- [ ] **Step 4: Run test — confirm PASS**

```bash
chmod +x privileged/recover-config.sh
bash tests/privileged/recover_config_test.sh
```

- [ ] **Step 5: Create aundekiosk-recovery.service.template**

```ini
[Unit]
Description=AundeKiosk config rollback on crash loop
After=network.target

[Service]
Type=oneshot
ExecStart=/opt/aundekiosk/privileged/recover-config.sh
```

(No `User=` — runs as root so it can call systemctl and write to /opt/aundekiosk/.)

- [ ] **Step 6: Update aundekiosk-runner.service.template**

Add to the `[Unit]` section:
```ini
OnFailure=aundekiosk-recovery.service
```

Add to the `[Service]` section (after `Restart=on-failure`):
```ini
StartLimitIntervalSec=300
StartLimitBurst=5
```

- [ ] **Step 7: Update install.sh to install recovery service**

After the line that copies `aundekiosk-monitor.service.template`, add:
```bash
cp "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-recovery.service.template" /etc/systemd/system/aundekiosk-recovery.service
```

The recovery service should NOT be added to the `systemctl enable` line — it is triggered by `OnFailure=`, not `WantedBy=`.

- [ ] **Step 8: Update templates_test.sh**

Add assertions to `tests/services/templates_test.sh`:

```bash
# Runner must declare OnFailure for crash recovery to trigger
grep -q "^OnFailure=aundekiosk-recovery.service$" "$SERVICES_DIR/aundekiosk-runner.service.template"
assert_status 0 $? "aundekiosk-runner.service.template declares OnFailure=aundekiosk-recovery.service"

# Runner must have StartLimitBurst so systemd knows when to fire OnFailure
grep -q "^StartLimitBurst=" "$SERVICES_DIR/aundekiosk-runner.service.template"
assert_status 0 $? "aundekiosk-runner.service.template sets StartLimitBurst"

# Recovery service must exist in the repo
[ -f "$SERVICES_DIR/aundekiosk-recovery.service.template" ]
assert_status 0 $? "aundekiosk-recovery.service.template exists in services/"

# Recovery service must run recover-config.sh
grep -q "^ExecStart=/opt/aundekiosk/privileged/recover-config.sh$" "$SERVICES_DIR/aundekiosk-recovery.service.template"
assert_status 0 $? "aundekiosk-recovery.service.template runs recover-config.sh"
```

- [ ] **Step 9: Run all tests — confirm PASS**

```bash
bash tests/privileged/recover_config_test.sh
bash tests/services/templates_test.sh
cd dashboard && deno test --allow-read --allow-write --allow-env .
```

- [ ] **Step 10: Commit**

```bash
git add privileged/recover-config.sh tests/privileged/recover_config_test.sh \
  services/aundekiosk-recovery.service.template \
  services/aundekiosk-runner.service.template \
  scripts/setup/install.sh \
  tests/services/templates_test.sh
git commit -m "feat: add crash recovery — config rollback and recovery service on runner restart loop

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
