# AundeKiosk Plan 2 — Auth & Oturum Güvenliği — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock down Plan 1's dashboard: a mandatory first-run admin setup, argon2id password hashing, server-side sessions over HTTPS, brute-force lockout, an English append-only audit log, a reusable step-up re-auth guard for Plan 3/4's high-risk actions, and the actual UI wiring (setup form / login form / the app itself) that Plan 1 deferred.

**Architecture:** Five small, independently testable modules under `dashboard/auth/` (password hashing, credential store, audit log, rate limiter, session store) compose into one `auth_api.ts`, which `server.ts` uses to gate `/config` behind a session and expose `/api/setup`, `/api/login`, `/api/logout`. A self-signed TLS certificate (generated once by `install.sh`, idempotent) turns the dashboard into HTTPS by default; `Deno.serve` falls back to plain HTTP only when no certificate is present (local dev convenience, never production).

**Tech Stack:** Deno + TypeScript (unchanged), `npm:hash-wasm` for argon2id (WASM, no native build step — portable across every Pi model without per-architecture prebuilt binaries), `openssl` for the self-signed certificate (already present on Raspberry Pi OS).

**Spec:** [docs/superpowers/specs/2026-10-09-aundekiosk-design.md](../specs/2026-10-09-aundekiosk-design.md) (section 6)

## Global Constraints

- Şifreler **argon2id** ile hash'lenir. (Spec §6)
- Credential store **`config.json`'un dışında**, ayrı bir dosyada, kısıtlı izinlerle (`0600`) saklanır. (Spec §6, §10)
- Oturumlar **sunucu taraflı**, rastgele **256-bit** token, cookie `HttpOnly` + `SameSite=Strict` + `Secure`, **30 dakika** hareketsizlikte sona erer. (Spec §6)
- Dashboard varsayılan olarak **self-signed TLS ile HTTPS** sunar. (Spec §6)
- Brute-force koruması: IP bazlı hız sınırlama + **5 başarısız denemede** artan süreli hesap kilitleme. (Spec §6)
- **Audit log her zaman İngilizce**, zaman damgası + kaynak IP ile, **append-only**. (Spec §6, §9)
- OS hesabı şifre değişimi ve SSH ayarları için **step-up auth** (geçerli dashboard şifresinin tekrar girilmesi) gerekir — bu planın görevi mekanizmayı inşa etmek, Plan 3/4'ün görevi onu kullanmak. (Spec §6)
- Zorunlu 2FA yok; TOTP bu planın kapsamı dışında (YAGNI, spec §4/§6'da da "opsiyonel, varsayılan kapalı" — somut bir tüketicisi olmayan bir toggle inşa etmek testsiz/anlamsız kod olur). (Spec §4, §6)
- Dashboard'dan gelen hiçbir veri doğrudan shell string'ine eklenmez. (Spec §5.1, §8.4 — Plan 1'den devam eden ilke)

## Review Focus

- Hiç admin yokken `/config`'e veya login'e erişim **sessizce başarılı olmaz**; admin oluşturulana kadar sistem kilitli kalır, ve bir admin zaten varken yeniden admin oluşturulamaz — Task 2 ve Task 7'de test edilir.
- **5 ardışık başarısız giriş** hesabı kilitler; kilitli pencerede, **doğru şifreyle bile** 6. deneme reddedilir (kilitlemenin asıl amacı) — Task 2 ve Task 7'de test edilir.
- **30 dakika hareketsiz kalan bir oturum çerezi** bir sonraki istekte geçersiz sayılır — çökme değil, temiz bir 401 — Task 5 ve Task 7'de test edilir.
- Her giriş başarısı, başarısızlığı, kilitlenme ve çıkış olayı, UI dili ne olursa olsun **İngilizce**, zaman damgası + kaynak IP ile audit log'a yazılır — Task 3 ve Task 7'de test edilir.
- Plan 1'de auth'suz inşa edilen `/config` endpoint'i artık **geçerli bir oturum zorunlu kılar** — çerezsiz veya geçersiz/süresi dolmuş çerezli bir istek asla config verisini almaz, her zaman 401 alır — Task 7'de test edilir.

---

## Ortam Notu

`npm:hash-wasm` paketi ilk kullanıldığında npm registry'den indirilir. Bu makinede kurumsal bir TLS ara sunucusu `UnknownIssuer` hatası veriyor (gerçek Pi hedefinde bu sorun olmayacak — farklı bir ağ). Bu makinede ilk indirme için `DENO_TLS_CA_STORE=mozilla,system` ortam değişkenini kullanın; paket bir kez Deno'nun global cache'ine indikten sonra tekrar ağa gerek kalmaz.

### Task 1: Şifre Hash'leme (`dashboard/auth/password.ts`)

**Files:**
- Create: `dashboard/auth/password.ts`
- Test: `dashboard/auth/password_test.ts`

**Interfaces:**
- Produces: `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, encodedHash: string): Promise<boolean>`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/auth/password_test.ts`:

```typescript
import { hashPassword, verifyPassword } from "./password.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("hashPassword produces a hash that verifyPassword accepts for the same password", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assertEquals(await verifyPassword("correct-horse-battery-staple", hash), true);
});

Deno.test("verifyPassword rejects a different password", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assertEquals(await verifyPassword("wrong-password", hash), false);
});

Deno.test("hashPassword produces an argon2id-encoded hash", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assertEquals(hash.startsWith("$argon2id$"), true);
});

Deno.test("hashPassword salts each call differently, so the same password hashes differently", async () => {
  const first = await hashPassword("same-password");
  const second = await hashPassword("same-password");
  assertEquals(first === second, false);
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run (bu makinede ilk çalıştırma, npm paketi indirmek için): `DENO_TLS_CA_STORE=mozilla,system deno test --allow-read --allow-write --allow-net dashboard/auth/password_test.ts`
Expected: `password.ts` henüz yok, modül çözümleme hatasıyla başarısız olur.

- [ ] **Step 3: `dashboard/auth/password.ts`'i yaz**

```typescript
import { argon2id, argon2Verify } from "npm:hash-wasm@4.11.0";

// Argon2id parameters per OWASP's baseline recommendation for interactive
// logins (m=19MiB, t=2, p=1) — chosen to stay fast enough on a Raspberry
// Pi's CPU while still meeting the memory-hardness argon2id is for.
const MEMORY_SIZE_KIB = 19456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return await argon2id({
    password,
    salt,
    parallelism: PARALLELISM,
    iterations: ITERATIONS,
    memorySize: MEMORY_SIZE_KIB,
    hashLength: HASH_LENGTH,
    outputType: "encoded",
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  return await argon2Verify({ password, hash: encodedHash });
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `DENO_TLS_CA_STORE=mozilla,system deno test --allow-read --allow-write --allow-net dashboard/auth/password_test.ts`
Expected: 4 test de PASS. (Paket bir kez cache'e indikten sonra, bu plandaki sonraki her `deno test` çağrısı için `DENO_TLS_CA_STORE` artık gerekmez; yine de tutarlılık için her adımda belirtiyoruz.)

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/password.ts dashboard/auth/password_test.ts
git commit -m "feat: add argon2id password hashing"
```

---

### Task 2: Kimlik Bilgisi Deposu (`dashboard/auth/credential_store.ts`)

**Files:**
- Create: `dashboard/auth/credential_store.ts`
- Test: `dashboard/auth/credential_store_test.ts`

**Interfaces:**
- Consumes: `dashboard/auth/password.ts` → `hashPassword`, `verifyPassword`
- Produces: `createCredentialStore(opts: { storePath: string }): { hasAdmin(): Promise<boolean>; createInitialAdmin(username: string, password: string): Promise<void>; verifyCredentials(username: string, password: string, now?: number): Promise<VerifyResult> }`
  where `VerifyResult = { outcome: "success" } | { outcome: "locked"; retryAfterMs: number } | { outcome: "invalid" } | { outcome: "no-admin" }`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/auth/credential_store_test.ts`:

```typescript
import { createCredentialStore } from "./credential_store.ts";
import { assertEquals } from "../test_util.ts";

async function withTempStore(fn: (storePath: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(`${dir}/auth.db`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("hasAdmin is false before any admin is created", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    assertEquals(await store.hasAdmin(), false);
  });
});

Deno.test("createInitialAdmin makes hasAdmin true", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    assertEquals(await store.hasAdmin(), true);
  });
});

Deno.test("createInitialAdmin refuses to run a second time", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    let threw = false;
    try {
      await store.createInitialAdmin("someone-else", "another-password");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  });
});

Deno.test("verifyCredentials reports no-admin before setup", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    const result = await store.verifyCredentials("admin", "anything");
    assertEquals(result.outcome, "no-admin");
  });
});

Deno.test("verifyCredentials succeeds with the right username and password", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const result = await store.verifyCredentials("admin", "a-long-enough-password");
    assertEquals(result.outcome, "success");
  });
});

Deno.test("verifyCredentials rejects the wrong password", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const result = await store.verifyCredentials("admin", "wrong-password");
    assertEquals(result.outcome, "invalid");
  });
});

Deno.test("verifyCredentials rejects the wrong username", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");
    const result = await store.verifyCredentials("not-admin", "a-long-enough-password");
    assertEquals(result.outcome, "invalid");
  });
});

Deno.test("5 consecutive failures lock the account, and the 6th attempt is rejected even with the correct password", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");

    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      const result = await store.verifyCredentials("admin", "wrong-password", now);
      assertEquals(result.outcome, "invalid");
    }

    const sixth = await store.verifyCredentials("admin", "a-long-enough-password", now);
    assertEquals(sixth.outcome, "locked");
  });
});

Deno.test("after the lockout window passes, the correct password succeeds and resets the failure count", async () => {
  await withTempStore(async (storePath) => {
    const store = createCredentialStore({ storePath });
    await store.createInitialAdmin("admin", "a-long-enough-password");

    const now = 2_000_000;
    for (let i = 0; i < 5; i++) {
      await store.verifyCredentials("admin", "wrong-password", now);
    }
    const locked = await store.verifyCredentials("admin", "a-long-enough-password", now);
    assertEquals(locked.outcome, "locked");
    if (locked.outcome !== "locked") throw new Error("unreachable");

    const afterWindow = now + locked.retryAfterMs + 1;
    const result = await store.verifyCredentials("admin", "a-long-enough-password", afterWindow);
    assertEquals(result.outcome, "success");
  });
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/auth/credential_store_test.ts`
Expected: `credential_store.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/auth/credential_store.ts`'i yaz**

```typescript
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
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/auth/credential_store_test.ts`
Expected: 9 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/credential_store.ts dashboard/auth/credential_store_test.ts
git commit -m "feat: add the credential store with lockout logic"
```

---

### Task 3: Audit Log (`dashboard/auth/audit_log.ts`)

**Files:**
- Create: `dashboard/auth/audit_log.ts`
- Test: `dashboard/auth/audit_log_test.ts`

**Interfaces:**
- Produces: `createAuditLog(opts: { logPath: string }): { record(event: string, details?: Record<string, string | number | boolean>): Promise<void> }`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/auth/audit_log_test.ts`:

```typescript
import { createAuditLog } from "./audit_log.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("record appends a JSON line with a timestamp and the given event", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const logPath = `${dir}/audit.log`;
    const log = createAuditLog({ logPath });
    await log.record("login_succeeded", { username: "admin", ip: "192.0.2.1" });

    const lines = (await Deno.readTextFile(logPath)).trim().split("\n");
    assertEquals(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assertEquals(parsed.event, "login_succeeded");
    assertEquals(parsed.username, "admin");
    assertEquals(parsed.ip, "192.0.2.1");
    assertEquals(typeof parsed.timestamp, "string");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("record appends, never overwrites — multiple events produce multiple lines", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const logPath = `${dir}/audit.log`;
    const log = createAuditLog({ logPath });
    await log.record("login_succeeded", { username: "admin" });
    await log.record("logout", { username: "admin" });

    const lines = (await Deno.readTextFile(logPath)).trim().split("\n");
    assertEquals(lines.length, 2);
    assertEquals(JSON.parse(lines[0]).event, "login_succeeded");
    assertEquals(JSON.parse(lines[1]).event, "logout");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write dashboard/auth/audit_log_test.ts`
Expected: `audit_log.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/auth/audit_log.ts`'i yaz**

```typescript
export interface AuditLogOptions {
  logPath: string;
}

// Every call site passes English event names and detail values by
// convention — this module never translates anything, so the log stays
// in one consistent language regardless of the UI's current locale
// (spec §6/§9). Appends only; the file is never truncated or rewritten.
export function createAuditLog(opts: AuditLogOptions) {
  const { logPath } = opts;

  async function record(
    event: string,
    details: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...details,
    };
    await Deno.writeTextFile(logPath, JSON.stringify(entry) + "\n", {
      append: true,
      mode: 0o600,
    });
  }

  return { record };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write dashboard/auth/audit_log_test.ts`
Expected: 2 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/audit_log.ts dashboard/auth/audit_log_test.ts
git commit -m "feat: add the append-only, English-only audit log"
```

---

### Task 4: Hız Sınırlama (`dashboard/auth/rate_limiter.ts`)

**Files:**
- Create: `dashboard/auth/rate_limiter.ts`
- Test: `dashboard/auth/rate_limiter_test.ts`

**Interfaces:**
- Produces: `createRateLimiter(opts: { maxAttempts: number; windowMs: number }): { check(key: string, now?: number): boolean }`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/auth/rate_limiter_test.ts`:

```typescript
import { createRateLimiter } from "./rate_limiter.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("allows attempts up to the limit within the window", () => {
  const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60_000 });
  const now = 1000;
  assertEquals(limiter.check("1.2.3.4", now), true);
  assertEquals(limiter.check("1.2.3.4", now), true);
  assertEquals(limiter.check("1.2.3.4", now), true);
});

Deno.test("rejects the attempt that exceeds the limit within the window", () => {
  const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60_000 });
  const now = 1000;
  limiter.check("1.2.3.4", now);
  limiter.check("1.2.3.4", now);
  limiter.check("1.2.3.4", now);
  assertEquals(limiter.check("1.2.3.4", now), false);
});

Deno.test("different keys (IPs) are tracked independently", () => {
  const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
  const now = 1000;
  assertEquals(limiter.check("1.2.3.4", now), true);
  assertEquals(limiter.check("5.6.7.8", now), true);
});

Deno.test("allows attempts again once the window has fully passed", () => {
  const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 60_000 });
  limiter.check("1.2.3.4", 1000);
  assertEquals(limiter.check("1.2.3.4", 1000 + 60_000 + 1), true);
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test dashboard/auth/rate_limiter_test.ts`
Expected: `rate_limiter.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/auth/rate_limiter.ts`'i yaz**

```typescript
export interface RateLimiterOptions {
  maxAttempts: number;
  windowMs: number;
}

// A simple per-key sliding window: each check() records the attempt and
// reports whether the number of attempts inside the trailing `windowMs`
// (including this one) is within `maxAttempts`.
export function createRateLimiter(opts: RateLimiterOptions) {
  const { maxAttempts, windowMs } = opts;
  const attempts = new Map<string, number[]>();

  function check(key: string, now: number = Date.now()): boolean {
    const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
    const allowed = recent.length < maxAttempts;
    recent.push(now);
    attempts.set(key, recent);
    return allowed;
  }

  return { check };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test dashboard/auth/rate_limiter_test.ts`
Expected: 4 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/rate_limiter.ts dashboard/auth/rate_limiter_test.ts
git commit -m "feat: add the per-IP login rate limiter"
```

---

### Task 5: Oturum Deposu (`dashboard/auth/session_store.ts`)

**Files:**
- Create: `dashboard/auth/session_store.ts`
- Test: `dashboard/auth/session_store_test.ts`

**Interfaces:**
- Produces: `createSessionStore(opts: { idleTimeoutMs: number }): { createSession(username: string, now?: number): string; touch(token: string, now?: number): { username: string } | null; destroy(token: string): void }`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/auth/session_store_test.ts`:

```typescript
import { createSessionStore } from "./session_store.ts";
import { assertEquals } from "../test_util.ts";

Deno.test("touch returns the username for a freshly created session", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const token = store.createSession("admin", 1000);
  assertEquals(store.touch(token, 1000)?.username, "admin");
});

Deno.test("touch returns null for an unknown token", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  assertEquals(store.touch("not-a-real-token"), null);
});

Deno.test("touch returns null once the session has been idle past the timeout", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const token = store.createSession("admin", 1000);
  const idleCutoff = 1000 + 30 * 60_000 + 1;
  assertEquals(store.touch(token, idleCutoff), null);
});

Deno.test("touch within the timeout keeps the session alive for a later touch at the same relative gap", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const token = store.createSession("admin", 1000);
  // Touch twice, each time within the idle window of the *previous* touch,
  // proving activity resets the idle clock rather than the original
  // creation time being the only thing that matters.
  assertEquals(store.touch(token, 1000 + 20 * 60_000) !== null, true);
  assertEquals(store.touch(token, 1000 + 20 * 60_000 + 20 * 60_000) !== null, true);
});

Deno.test("destroy invalidates the session immediately", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const token = store.createSession("admin", 1000);
  store.destroy(token);
  assertEquals(store.touch(token, 1000), null);
});

Deno.test("two sessions get two different tokens", () => {
  const store = createSessionStore({ idleTimeoutMs: 30 * 60_000 });
  const a = store.createSession("admin", 1000);
  const b = store.createSession("admin", 1000);
  assertEquals(a === b, false);
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test dashboard/auth/session_store_test.ts`
Expected: `session_store.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/auth/session_store.ts`'i yaz**

```typescript
export interface SessionStoreOptions {
  idleTimeoutMs: number;
}

interface SessionRecord {
  username: string;
  lastActivityAt: number;
}

function randomToken(): string {
  const bytes = new Uint8Array(32); // 256 bits
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// In-memory only: a dashboard restart logs everyone out, which is an
// acceptable, simple trade-off for a single-admin kiosk tool (no
// persisted session store to keep consistent or clean up).
export function createSessionStore(opts: SessionStoreOptions) {
  const { idleTimeoutMs } = opts;
  const sessions = new Map<string, SessionRecord>();

  function createSession(username: string, now: number = Date.now()): string {
    const token = randomToken();
    sessions.set(token, { username, lastActivityAt: now });
    return token;
  }

  function touch(token: string, now: number = Date.now()): { username: string } | null {
    const record = sessions.get(token);
    if (!record) return null;
    if (now - record.lastActivityAt > idleTimeoutMs) {
      sessions.delete(token);
      return null;
    }
    record.lastActivityAt = now;
    return { username: record.username };
  }

  function destroy(token: string): void {
    sessions.delete(token);
  }

  return { createSession, touch, destroy };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test dashboard/auth/session_store_test.ts`
Expected: 6 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/session_store.ts dashboard/auth/session_store_test.ts
git commit -m "feat: add the in-memory session store with idle expiry"
```

---

### Task 6: Step-Up Auth Koruması (`dashboard/auth/step_up.ts`)

**Files:**
- Create: `dashboard/auth/step_up.ts`
- Test: `dashboard/auth/step_up_test.ts`

**Interfaces:**
- Consumes: `dashboard/auth/credential_store.ts` → `createCredentialStore`
- Produces: `createStepUpGuard(opts: { credentialStore: ReturnType<typeof createCredentialStore> }): { verify(username: string, confirmPassword: string): Promise<boolean> }`

Bu modülün bu planda doğrudan bir HTTP tüketicisi yok — Plan 3/4'ün OS şifre değişimi ve SSH ayarları buna sarılacak. Plan 1'in privileged helper deseni de aynı şekilde, HTTP'ye bağlanmadan önce kendi başına kanıtlanmıştı.

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/auth/step_up_test.ts`:

```typescript
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
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/auth/step_up_test.ts`
Expected: `step_up.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/auth/step_up.ts`'i yaz**

```typescript
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
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/auth/step_up_test.ts`
Expected: 3 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/step_up.ts dashboard/auth/step_up_test.ts
git commit -m "feat: add the reusable step-up re-authentication guard"
```

---

### Task 7: Auth API & Dashboard Entegrasyonu

**Files:**
- Create: `dashboard/auth/auth_api.ts`
- Test: `dashboard/auth/auth_api_test.ts`
- Modify: `dashboard/server.ts`
- Modify: `dashboard/server_test.ts`

**Interfaces:**
- Consumes: Task 2 `createCredentialStore`, Task 3 `createAuditLog`, Task 4 `createRateLimiter`, Task 5 `createSessionStore`
- Produces: `createAuthApi(opts): { handleSetupStatus(): Promise<Response>; handleSetup(req): Promise<Response>; handleLogin(req): Promise<Response>; handleLogout(req): Promise<Response>; requireSession(req): { username: string } | null }`

- [ ] **Step 1: `auth_api.ts` için başarısız olacak testi yaz**

`dashboard/auth/auth_api_test.ts`:

```typescript
import { createAuthApi } from "./auth_api.ts";
import { createCredentialStore } from "./credential_store.ts";
import { createSessionStore } from "./session_store.ts";
import { createRateLimiter } from "./rate_limiter.ts";
import { createAuditLog } from "./audit_log.ts";
import { assertEquals } from "../test_util.ts";

async function withApi(
  fn: (api: ReturnType<typeof createAuthApi>, dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const api = createAuthApi({
      credentialStore: createCredentialStore({ storePath: `${dir}/auth.db` }),
      sessionStore: createSessionStore({ idleTimeoutMs: 30 * 60_000 }),
      rateLimiter: createRateLimiter({ maxAttempts: 100, windowMs: 60_000 }),
      auditLog: createAuditLog({ logPath: `${dir}/audit.log` }),
    });
    await fn(api, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

Deno.test("handleSetupStatus reports hasAdmin:false before setup", async () => {
  await withApi(async (api) => {
    const res = await api.handleSetupStatus();
    assertEquals((await res.json()).hasAdmin, false);
  });
});

Deno.test("handleSetup creates the admin and handleSetupStatus then reports hasAdmin:true", async () => {
  await withApi(async (api) => {
    const res = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    assertEquals(res.status, 201);
    const status = await api.handleSetupStatus();
    assertEquals((await status.json()).hasAdmin, true);
  });
});

Deno.test("handleSetup refuses a second admin once one exists", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    const res = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "someone-else", password: "another-password" }),
    );
    assertEquals(res.status, 409);
  });
});

Deno.test("handleSetup rejects a short password", async () => {
  await withApi(async (api) => {
    const res = await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "short" }),
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("handleLogin with the right credentials returns 200 and sets a session cookie", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
    );
    assertEquals(res.status, 200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    assertEquals(setCookie.includes("HttpOnly"), true);
    assertEquals(setCookie.includes("SameSite=Strict"), true);
    assertEquals(setCookie.includes("Secure"), true);
  });
});

Deno.test("handleLogin with the wrong password returns 401 and sets no cookie", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }),
    );
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("Set-Cookie"), null);
  });
});

Deno.test("5 failed logins lock the account; the 6th attempt is rejected (423) even with the right password", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    for (let i = 0; i < 5; i++) {
      await api.handleLogin(jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }));
    }
    const res = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
    );
    assertEquals(res.status, 423);
  });
});

Deno.test("requireSession returns null without a cookie, and the username with a valid one from login", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    const noSessionReq = new Request("http://localhost/config");
    assertEquals(api.requireSession(noSessionReq), null);

    const loginRes = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
    );
    const setCookie = loginRes.headers.get("Set-Cookie") ?? "";
    const cookiePair = setCookie.split(";")[0];
    const authedReq = new Request("http://localhost/config", { headers: { Cookie: cookiePair } });
    assertEquals(api.requireSession(authedReq)?.username, "admin");
  });
});

Deno.test("handleLogout clears the session so the same cookie no longer authenticates", async () => {
  await withApi(async (api) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    const loginRes = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }),
    );
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];

    await api.handleLogout(new Request("http://localhost/api/logout", { method: "POST", headers: { Cookie: cookiePair } }));

    const reusedReq = new Request("http://localhost/config", { headers: { Cookie: cookiePair } });
    assertEquals(api.requireSession(reusedReq), null);
  });
});

Deno.test("every login success, failure, lockout, and logout is recorded in the audit log in English with a timestamp and IP", async () => {
  await withApi(async (api, dir) => {
    await api.handleSetup(
      jsonRequest("http://localhost/api/setup", { username: "admin", password: "a-long-enough-password" }),
    );
    await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "wrong" }, { "x-forwarded-for": "203.0.113.1" }),
    );
    const loginRes = await api.handleLogin(
      jsonRequest("http://localhost/api/login", { username: "admin", password: "a-long-enough-password" }, { "x-forwarded-for": "203.0.113.1" }),
    );
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];
    await api.handleLogout(new Request("http://localhost/api/logout", { method: "POST", headers: { Cookie: cookiePair } }));

    const lines = (await Deno.readTextFile(`${dir}/audit.log`)).trim().split("\n").map((l) => JSON.parse(l));
    const events = lines.map((l: Record<string, unknown>) => l.event);
    assertEquals(events.includes("login_failed"), true);
    assertEquals(events.includes("login_succeeded"), true);
    assertEquals(events.includes("logout"), true);
    for (const line of lines) {
      assertEquals(typeof line.timestamp, "string");
    }
    const failedLine = lines.find((l: Record<string, unknown>) => l.event === "login_failed");
    assertEquals(failedLine.ip, "203.0.113.1");
  });
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/auth/auth_api_test.ts`
Expected: `auth_api.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/auth/auth_api.ts`'i yaz**

```typescript
import type { createCredentialStore } from "./credential_store.ts";
import type { createSessionStore } from "./session_store.ts";
import type { createRateLimiter } from "./rate_limiter.ts";
import type { createAuditLog } from "./audit_log.ts";

export interface AuthApiOptions {
  credentialStore: ReturnType<typeof createCredentialStore>;
  sessionStore: ReturnType<typeof createSessionStore>;
  rateLimiter: ReturnType<typeof createRateLimiter>;
  auditLog: ReturnType<typeof createAuditLog>;
}

const SESSION_COOKIE = "aundekiosk_session";
const MIN_PASSWORD_LENGTH = 12;

export function createAuthApi(opts: AuthApiOptions) {
  const { credentialStore, sessionStore, rateLimiter, auditLog } = opts;

  function clientIp(req: Request): string {
    return req.headers.get("x-forwarded-for") ?? "unknown";
  }

  function sessionCookieHeader(token: string): string {
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Secure; Path=/`;
  }

  function clearCookieHeader(): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0`;
  }

  function readSessionToken(req: Request): string | null {
    const cookie = req.headers.get("cookie");
    if (!cookie) return null;
    for (const part of cookie.split(";")) {
      const [name, value] = part.trim().split("=");
      if (name === SESSION_COOKIE) return value ?? null;
    }
    return null;
  }

  async function handleSetupStatus(): Promise<Response> {
    return Response.json({ hasAdmin: await credentialStore.hasAdmin() });
  }

  async function handleSetup(req: Request): Promise<Response> {
    if (await credentialStore.hasAdmin()) {
      return new Response("Admin already configured.", { status: 409 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { username, password } = body as Record<string, unknown>;
    if (typeof username !== "string" || username.trim().length === 0) {
      return new Response("Username is required.", { status: 400 });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return new Response(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, { status: 400 });
    }
    await credentialStore.createInitialAdmin(username.trim(), password);
    await auditLog.record("admin_created", { username: username.trim(), ip: clientIp(req) });
    return new Response("Admin created.", { status: 201 });
  }

  async function handleLogin(req: Request): Promise<Response> {
    const ip = clientIp(req);
    if (!rateLimiter.check(ip)) {
      await auditLog.record("login_rate_limited", { ip });
      return new Response("Too many login attempts. Try again later.", { status: 429 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { username, password } = body as Record<string, unknown>;
    if (typeof username !== "string" || typeof password !== "string") {
      return new Response("Username and password are required.", { status: 400 });
    }

    const result = await credentialStore.verifyCredentials(username, password);

    if (result.outcome === "no-admin") {
      return new Response("No admin configured yet.", { status: 409 });
    }
    if (result.outcome === "locked") {
      await auditLog.record("login_locked", { username, ip });
      return new Response("Account locked. Try again later.", {
        status: 423,
        headers: { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) },
      });
    }
    if (result.outcome === "invalid") {
      await auditLog.record("login_failed", { username, ip });
      return new Response("Invalid username or password.", { status: 401 });
    }

    const token = sessionStore.createSession(username);
    await auditLog.record("login_succeeded", { username, ip });
    return new Response("Logged in.", { status: 200, headers: { "Set-Cookie": sessionCookieHeader(token) } });
  }

  async function handleLogout(req: Request): Promise<Response> {
    const token = readSessionToken(req);
    if (token) {
      sessionStore.destroy(token);
      await auditLog.record("logout", { ip: clientIp(req) });
    }
    return new Response("Logged out.", { status: 200, headers: { "Set-Cookie": clearCookieHeader() } });
  }

  function requireSession(req: Request): { username: string } | null {
    const token = readSessionToken(req);
    if (!token) return null;
    return sessionStore.touch(token);
  }

  return { handleSetupStatus, handleSetup, handleLogin, handleLogout, requireSession };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net dashboard/auth/auth_api_test.ts`
Expected: 10 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/auth/auth_api.ts dashboard/auth/auth_api_test.ts
git commit -m "feat: add the setup/login/logout API with lockout and audit logging"
```

- [ ] **Step 6: `server.ts` için başarısız olacak testleri yaz (yeni rotalar + `/config` koruması)**

`dashboard/server_test.ts`'e ekle (dosyanın başındaki import'ların yanına, mevcut testlerin ALTINA):

```typescript
Deno.test("GET /config without a session returns 401, never the config data", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/config"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the full setup -> login -> GET /config flow works end to end through createHandler", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });

    const setupRes = await handle(
      new Request("http://localhost/api/setup", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
      }),
    );
    assertEquals(setupRes.status, 201);

    const loginRes = await handle(
      new Request("http://localhost/api/login", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
      }),
    );
    assertEquals(loginRes.status, 200);
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];

    const configRes = await handle(
      new Request("http://localhost/config", { headers: { Cookie: cookiePair } }),
    );
    assertEquals(configRes.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

- [ ] **Step 7: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`
Expected: `createHandler`'ın `authStorePath`/`auditLogPath` seçeneklerini henüz tanımadığı ve `/config`'i koruması altına almadığı için başarısız olur (önceki "GET /config returns the sample config" testi de artık 401 beklemediği için hâlâ geçiyor olabilir — ama yeni iki test FAIL verir).

- [ ] **Step 8: `dashboard/server.ts`'i güncelle**

```typescript
import { createStaticHandler } from "./static.ts";
import { createConfigApi } from "./config_api.ts";
import { createCredentialStore } from "./auth/credential_store.ts";
import { createSessionStore } from "./auth/session_store.ts";
import { createRateLimiter } from "./auth/rate_limiter.ts";
import { createAuditLog } from "./auth/audit_log.ts";
import { createAuthApi } from "./auth/auth_api.ts";

const DEFAULT_PUBLIC_DIR = `${import.meta.dirname}/public`;
const DEFAULT_CONFIG_PATH = "/opt/aundekiosk/config.json";
const DEFAULT_SAMPLE_PATH = `${import.meta.dirname}/../config.json.sample`;
const DEFAULT_AUTH_STORE_PATH = "/opt/aundekiosk/auth.db";
const DEFAULT_AUDIT_LOG_PATH = "/opt/aundekiosk/audit.log";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const LOGIN_RATE_LIMIT = { maxAttempts: 10, windowMs: 60_000 };

export interface HandlerOptions {
  configPath?: string;
  samplePath?: string;
  publicDir?: string;
  authStorePath?: string;
  auditLogPath?: string;
}

export function createHandler(options: HandlerOptions = {}) {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const configPath = options.configPath ?? Deno.env.get("AUNDEKIOSK_CONFIG_FILE") ?? DEFAULT_CONFIG_PATH;
  const samplePath = options.samplePath ?? DEFAULT_SAMPLE_PATH;
  const authStorePath = options.authStorePath ?? Deno.env.get("AUNDEKIOSK_AUTH_STORE_FILE") ?? DEFAULT_AUTH_STORE_PATH;
  const auditLogPath = options.auditLogPath ?? Deno.env.get("AUNDEKIOSK_AUDIT_LOG_FILE") ?? DEFAULT_AUDIT_LOG_PATH;

  const serveStatic = createStaticHandler(publicDir);
  const configApi = createConfigApi({ configPath, samplePath });
  const authApi = createAuthApi({
    credentialStore: createCredentialStore({ storePath: authStorePath }),
    sessionStore: createSessionStore({ idleTimeoutMs: IDLE_TIMEOUT_MS }),
    rateLimiter: createRateLimiter(LOGIN_RATE_LIMIT),
    auditLog: createAuditLog({ logPath: auditLogPath }),
  });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/setup") {
      if (req.method === "GET") return authApi.handleSetupStatus();
      if (req.method === "POST") return authApi.handleSetup(req);
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      return authApi.handleLogin(req);
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      return authApi.handleLogout(req);
    }

    if (url.pathname === "/config") {
      if (!authApi.requireSession(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (req.method === "GET") return configApi.handleGet();
      if (req.method === "POST") return configApi.handlePost(req);
      return new Response("Method Not Allowed", { status: 405 });
    }

    return serveStatic(url.pathname);
  };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8080");
  const certPath = Deno.env.get("AUNDEKIOSK_TLS_CERT") ?? "/opt/aundekiosk/tls/cert.pem";
  const keyPath = Deno.env.get("AUNDEKIOSK_TLS_KEY") ?? "/opt/aundekiosk/tls/key.pem";

  let tls: { cert: string; key: string } | undefined;
  try {
    tls = { cert: await Deno.readTextFile(certPath), key: await Deno.readTextFile(keyPath) };
  } catch {
    console.warn(`No TLS certificate found at ${certPath}; starting over plain HTTP (dev only).`);
  }

  console.log(`AundeKiosk dashboard starting on port ${port}${tls ? " (HTTPS)" : " (HTTP)"}...`);
  Deno.serve({ port, ...tls }, createHandler());
}
```

Not: önceki "GET /config returns the sample config end to end" ve "POST /config with the wrong method..." testleri artık **401** bekleyecek şekilde güncellenmeli (çünkü `/config` artık oturum ister) — bu testlerin başına ilgili test içinde önce setup+login akışını eklemek yerine, bu iki testi "oturumsuz 401 döner" beklentisine çevir (zaten üstte eklenen yeni test tam akışı kanıtlıyor):

`dashboard/server_test.ts`'teki şu iki testi güncelle:

```typescript
Deno.test("GET /config returns the sample config end to end", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const samplePath = `${dir}/config.json.sample`;
    await Deno.writeTextFile(samplePath, JSON.stringify({ urls: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    // Without a session, /config is always 401 now — see the dedicated
    // "full setup -> login -> GET /config flow" test for the authenticated path.
    const res = await handle(new Request("http://localhost/config"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /config with the wrong method on another path is not routed to the config API", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<h1>AundeKiosk</h1>");
    const handle = createHandler({
      publicDir: dir,
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
    });
    const res = await handle(new Request("http://localhost/config", { method: "DELETE" }));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

(İkinci testin ismi "DELETE'in config API'ye yönlendirilmediğini" kanıtlıyordu; artık önce auth kontrolüne çarpıyor — bu da doğru davranış, çünkü auth kontrolü method kontrolünden önce gelmeli.)

- [ ] **Step 9: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`
Expected: 5 test de PASS (3 eski + 2 yeni).

- [ ] **Step 10: Commit**

```bash
git add dashboard/server.ts dashboard/server_test.ts
git commit -m "feat: gate /config behind a session and wire setup/login/logout into the server"
```

---

### Task 8: Arayüz — Setup / Login / Uygulama Durumları

**Files:**
- Create: `dashboard/public/auth.js`
- Test: `dashboard/auth_ui_test.ts`
- Modify: `dashboard/public/index.html`
- Modify: `dashboard/public/locales/tr.json`, `en.json`, `de.json`
- Modify: `dashboard/public/script.js` *(yeni — add-url/apply butonlarını `/config`'e bağlar)*

**Interfaces:**
- Produces: `dashboard/public/auth.js` → `decideUiState(hasAdmin: boolean, authenticated: boolean): "setup" | "login" | "app"`

Bu görev iki parçadan oluşur: (1) hangi ekranın gösterileceğine karar veren **test edilebilir saf mantık**, (2) DOM'a bağlı bootstrap/form-wiring kodu — bu kısım Plan 1'in `i18n.js` deseniyle aynı sebepten (tarayıcı DOM'u olmadan test edilemez) otomatik test kapsamı dışında, spec §11'e göre gerçek donanımda/manuel QA ile doğrulanır.

- [ ] **Step 1: Saf mantık için başarısız olacak testi yaz**

`dashboard/auth_ui_test.ts`:

```typescript
import { decideUiState } from "./public/auth.js";
import { assertEquals } from "./test_util.ts";

Deno.test("shows setup when no admin exists yet", () => {
  assertEquals(decideUiState(false, false), "setup");
});

Deno.test("shows login when an admin exists but the session is not authenticated", () => {
  assertEquals(decideUiState(true, false), "login");
});

Deno.test("shows the app once an admin exists and the session is authenticated", () => {
  assertEquals(decideUiState(true, true), "app");
});

Deno.test("setup takes priority even if (inconsistently) authenticated is true with no admin", () => {
  assertEquals(decideUiState(false, true), "setup");
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read dashboard/auth_ui_test.ts`
Expected: `dashboard/public/auth.js` henüz yok, başarısız olur.

- [ ] **Step 3: `dashboard/public/auth.js`'i yaz**

```javascript
// auth.js — decides which UI state to show, and wires the setup/login
// forms and the authenticated app view to the server's auth endpoints.
// decideUiState has no DOM dependency so Deno can import and test it
// directly; everything below the guard at the bottom only runs in a
// real browser.

export function decideUiState(hasAdmin, authenticated) {
  if (!hasAdmin) return "setup";
  if (!authenticated) return "login";
  return "app";
}

async function bootstrapAuth() {
  const setupSection = document.getElementById("setup-section");
  const loginSection = document.getElementById("login-section");
  const appSection = document.getElementById("app-section");

  function showOnly(sectionToShow) {
    for (const section of [setupSection, loginSection, appSection]) {
      if (section) section.hidden = section !== sectionToShow;
    }
  }

  async function refreshState() {
    const statusRes = await fetch("/api/setup");
    const { hasAdmin } = await statusRes.json();

    if (!hasAdmin) {
      showOnly(setupSection);
      return;
    }

    const configRes = await fetch("/config");
    const authenticated = configRes.status !== 401;
    const state = decideUiState(hasAdmin, authenticated);
    showOnly(state === "app" ? appSection : loginSection);
    if (state === "app" && window.aundekiosk?.loadConfig) {
      window.aundekiosk.loadConfig();
    }
  }

  const setupForm = document.getElementById("setup-form");
  if (setupForm) {
    setupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("setup-username").value;
      const password = document.getElementById("setup-password").value;
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        await refreshState();
      } else {
        document.getElementById("setup-error").textContent = await res.text();
      }
    });
  }

  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("login-username").value;
      const password = document.getElementById("login-password").value;
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        await refreshState();
      } else {
        document.getElementById("login-error").textContent = await res.text();
      }
    });
  }

  const logoutButton = document.getElementById("logout-button");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      await refreshState();
    });
  }

  window.aundekiosk = window.aundekiosk || {};
  window.aundekiosk.refreshAuthState = refreshState;
  await refreshState();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrapAuth();
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read dashboard/auth_ui_test.ts`
Expected: 4 test de PASS.

- [ ] **Step 5: `index.html`'i üç bölüme ayır ve çeviri anahtarlarını ekle**

`dashboard/public/index.html` (tamamını değiştir):

```html
<!doctype html>
<html lang="tr" data-bs-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
    <link
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
      rel="stylesheet"
      integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH"
      crossorigin="anonymous"
    />
    <link rel="stylesheet" href="style.css" />
    <title>AundeKiosk</title>
  </head>
  <body>
    <section id="setup-section" class="container-md my-5" hidden>
      <h1 data-i18n="app_title">AundeKiosk</h1>
      <form id="setup-form" class="mt-4">
        <h2 data-i18n="setup_heading">Set up the admin account</h2>
        <div class="mb-3">
          <label class="form-label" data-i18n="setup_username_label">Username</label>
          <input id="setup-username" type="text" class="form-control" required />
        </div>
        <div class="mb-3">
          <label class="form-label" data-i18n="setup_password_label">Password (min 12 characters)</label>
          <input id="setup-password" type="password" class="form-control" minlength="12" required />
        </div>
        <button type="submit" class="btn btn-primary" data-i18n="setup_submit">Create admin</button>
        <div id="setup-error" class="text-danger mt-2"></div>
      </form>
    </section>

    <section id="login-section" class="container-md my-5" hidden>
      <h1 data-i18n="app_title">AundeKiosk</h1>
      <form id="login-form" class="mt-4">
        <h2 data-i18n="login_heading">Log in</h2>
        <div class="mb-3">
          <label class="form-label" data-i18n="login_username_label">Username</label>
          <input id="login-username" type="text" class="form-control" required />
        </div>
        <div class="mb-3">
          <label class="form-label" data-i18n="login_password_label">Password</label>
          <input id="login-password" type="password" class="form-control" required />
        </div>
        <button type="submit" class="btn btn-primary" data-i18n="login_submit">Log in</button>
        <div id="login-error" class="text-danger mt-2"></div>
      </form>
    </section>

    <section id="app-section" hidden>
      <nav class="navbar bg-body-tertiary py-3">
        <div class="container-md d-flex flex-wrap align-items-center gap-3">
          <h1 class="my-0" data-i18n="app_title">AundeKiosk</h1>
          <input id="new-url" type="text" class="form-control" data-i18n-placeholder="nav_add_placeholder" />
          <button id="add-url" type="button" class="btn btn-secondary" data-i18n="nav_add_button">ADD</button>
          <button id="execute" type="button" class="btn btn-danger" data-i18n="nav_apply_button">APPLY</button>
          <select id="lang-switch" class="form-select w-auto">
            <option value="tr">TR</option>
            <option value="en">EN</option>
            <option value="de">DE</option>
          </select>
          <button id="logout-button" type="button" class="btn btn-outline-light" data-i18n="logout_button">Log out</button>
        </div>
      </nav>

      <div id="urls" class="container-md my-5">
        <ul class="list-group list-group-flush"></ul>
      </div>
    </section>

    <template id="template-url">
      <li class="list-group-item d-flex justify-content-between align-items-center">
        <a target="_blank" rel="noopener"></a>
        <button type="button" class="btn btn-sm btn-outline-danger remove-url" data-i18n="remove_button">Remove</button>
      </li>
    </template>

    <script
      src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"
      integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz"
      crossorigin="anonymous"
    ></script>
    <script type="module" src="i18n.js"></script>
    <script type="module" src="auth.js"></script>
    <script type="module" src="script.js"></script>
  </body>
</html>
```

`dashboard/public/locales/tr.json`'a ekle (mevcut anahtarların yanına):

```json
{
  "app_title": "AundeKiosk",
  "nav_add_placeholder": "...ekranlara eklemek için web sayfası URL'leri girin",
  "nav_add_button": "EKLE",
  "nav_apply_button": "UYGULA",
  "setup_heading": "Yönetici hesabını oluşturun",
  "setup_username_label": "Kullanıcı adı",
  "setup_password_label": "Şifre (en az 12 karakter)",
  "setup_submit": "Yönetici oluştur",
  "login_heading": "Giriş yap",
  "login_username_label": "Kullanıcı adı",
  "login_password_label": "Şifre",
  "login_submit": "Giriş yap",
  "logout_button": "Çıkış yap",
  "remove_button": "Kaldır"
}
```

`dashboard/public/locales/en.json`'a ekle:

```json
{
  "app_title": "AundeKiosk",
  "nav_add_placeholder": "...add webpage URLs as screens",
  "nav_add_button": "ADD",
  "nav_apply_button": "APPLY",
  "setup_heading": "Set up the admin account",
  "setup_username_label": "Username",
  "setup_password_label": "Password (min 12 characters)",
  "setup_submit": "Create admin",
  "login_heading": "Log in",
  "login_username_label": "Username",
  "login_password_label": "Password",
  "login_submit": "Log in",
  "logout_button": "Log out",
  "remove_button": "Remove"
}
```

`dashboard/public/locales/de.json`'a ekle:

```json
{
  "app_title": "AundeKiosk",
  "nav_add_placeholder": "...fügen Sie Webseiten-URLs als Bildschirme hinzu",
  "nav_add_button": "HINZUFÜGEN",
  "nav_apply_button": "ANWENDEN",
  "setup_heading": "Administratorkonto einrichten",
  "setup_username_label": "Benutzername",
  "setup_password_label": "Passwort (mind. 12 Zeichen)",
  "setup_submit": "Administrator erstellen",
  "login_heading": "Anmelden",
  "login_username_label": "Benutzername",
  "login_password_label": "Passwort",
  "login_submit": "Anmelden",
  "logout_button": "Abmelden",
  "remove_button": "Entfernen"
}
```

- [ ] **Step 6: `script.js`'i yaz — ekle/uygula butonlarını `/config`'e bağla (Plan 1'in I9 kararını kapatır)**

`dashboard/public/script.js`:

```javascript
// script.js — wires the authenticated app view's URL list to /config.
// DOM-dependent, so (like i18n.js and auth.js) this is verified by manual
// QA in a real browser (spec §11), not a Deno unit test.

function renderUrlRow(entry) {
  const template = document.getElementById("template-url");
  const row = template.content.firstElementChild.cloneNode(true);
  const link = row.querySelector("a");
  link.href = entry.url;
  link.textContent = entry.url;
  row.dataset.duration = entry.duration;
  row.dataset.cycles = entry.cycles;
  row.querySelector(".remove-url").addEventListener("click", () => row.remove());
  return row;
}

async function loadConfig() {
  const list = document.querySelector("#urls ul");
  list.innerHTML = "";
  const res = await fetch("/config");
  if (!res.ok) return;
  const { urls } = await res.json();
  for (const entry of urls) {
    list.appendChild(renderUrlRow(entry));
  }
}

async function applyConfig() {
  const list = document.querySelector("#urls ul");
  const urls = [...list.children].map((row) => ({
    url: row.querySelector("a").href,
    duration: Number(row.dataset.duration) || 10,
    cycles: Number(row.dataset.cycles) || 0,
  }));
  const res = await fetch("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  const message = await res.text();
  alert(message);
  if (res.ok) await loadConfig();
}

if (typeof document !== "undefined") {
  document.getElementById("add-url")?.addEventListener("click", () => {
    const input = document.getElementById("new-url");
    const url = input.value.trim();
    if (!url) return;
    document.querySelector("#urls ul").appendChild(renderUrlRow({ url, duration: 10, cycles: 0 }));
    input.value = "";
  });

  document.getElementById("execute")?.addEventListener("click", applyConfig);

  window.aundekiosk = window.aundekiosk || {};
  window.aundekiosk.loadConfig = loadConfig;
}
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/public/auth.js dashboard/auth_ui_test.ts dashboard/public/index.html dashboard/public/locales dashboard/public/script.js
git commit -m "feat: add setup/login/app UI states and wire the URL list to /config"
```

---

### Task 9: TLS — Self-Signed Sertifika

**Files:**
- Create: `scripts/setup/generate-tls-cert.sh`
- Test: `tests/setup/generate_tls_cert_test.sh`
- Modify: `scripts/setup/install.sh`
- Modify: `services/aundekiosk-dashboard.service.template`

**Interfaces:**
- Produces: `scripts/setup/generate-tls-cert.sh <cert_dir>` (idempotent: `<cert_dir>/cert.pem` + `<cert_dir>/key.pem`)

- [ ] **Step 1: Başarısız olacak testi yaz**

`tests/setup/generate_tls_cert_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

GENERATOR="$SCRIPT_DIR/../../scripts/setup/generate-tls-cert.sh"
WORKDIR=$(mktemp -d)
CERT_DIR="$WORKDIR/tls"

bash "$GENERATOR" "$CERT_DIR" > "$WORKDIR/output1.txt" 2>&1
assert_status 0 $? "generate-tls-cert.sh exits 0 on first run"

[[ -f "$CERT_DIR/cert.pem" ]]
assert_status 0 $? "generate-tls-cert.sh creates cert.pem"

[[ -f "$CERT_DIR/key.pem" ]]
assert_status 0 $? "generate-tls-cert.sh creates key.pem"

first_cert_contents=$(cat "$CERT_DIR/cert.pem")

bash "$GENERATOR" "$CERT_DIR" > "$WORKDIR/output2.txt" 2>&1
assert_status 0 $? "generate-tls-cert.sh exits 0 on second run"

second_cert_contents=$(cat "$CERT_DIR/cert.pem")
assert_eq "$first_cert_contents" "$second_cert_contents" "generate-tls-cert.sh does not regenerate an existing certificate (idempotent)"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/setup/generate_tls_cert_test.sh`
Expected: script henüz yok, "No such file or directory" ile başarısız olur.

- [ ] **Step 3: `scripts/setup/generate-tls-cert.sh`'ı yaz**

```bash
#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="${1:?Usage: generate-tls-cert.sh <cert_dir>}"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"

if [[ -f "$CERT_FILE" && -f "$KEY_FILE" ]]; then
  echo "TLS certificate already exists at $CERT_DIR, leaving it in place."
  exit 0
fi

mkdir -p "$CERT_DIR"
openssl req -x509 -newkey rsa:2048 -days 825 -nodes \
  -subj "/CN=aundekiosk" \
  -keyout "$KEY_FILE" -out "$CERT_FILE" 2>/dev/null

chmod 600 "$KEY_FILE"
chmod 644 "$CERT_FILE"
echo "Generated a new self-signed TLS certificate at $CERT_DIR."
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/setup/generate_tls_cert_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`, exit code 0.

- [ ] **Step 5: `install.sh`'ı güncelle (sertifika üretimi + sahiplik + uyarı mesajını kaldır)**

`scripts/setup/install.sh`'ta şu değişiklikleri yap:

1. `apt-get install -y jq chromium wtype xdotool unzip` satırına `openssl` ekle (çoğu Raspberry Pi OS imajında zaten var, ama açıkça listelemek güvenli):
   ```bash
   apt-get install -y jq chromium wtype xdotool openssl unzip
   ```

2. Sudoers kurulumundan önce, sertifika üretimini ekle:
   ```bash
   msg "$INFO" "Generating the self-signed TLS certificate (if one doesn't exist yet)..."
   bash "$AUNDEKIOSK_INSTALL_DIR/scripts/setup/generate-tls-cert.sh" "$AUNDEKIOSK_INSTALL_DIR/tls"
   ```
   Bunu `chown -R aundekiosk:aundekiosk "$AUNDEKIOSK_INSTALL_DIR"` satırından **önce** ekle, böylece blanket chown `tls/` dizinini de kapsar (aundekiosk servis kullanıcısı `key.pem`'i okuyabilir).

3. En alttaki uyarı/bilgi mesajlarını güncelle:
   ```bash
   echo
   msg "$CALLOUT" "AundeKiosk is now installed."
   echo -e "Dashboard: ${SUCCESS}https://$(hostname -I | cut -d ' ' -f 1):8080/${RESET}"
   msg "$WARNING" "The TLS certificate is self-signed — your browser will warn about it once; this is expected for a LAN-only kiosk tool."
   msg "$WARNING" "Kiosk mode will launch on the next startup."
   ```
   (Önceki "no authentication yet" uyarısı kaldırıldı — bu plan auth'u ekliyor.)

- [ ] **Step 6: Söz dizimini doğrula**

Run: `bash -n scripts/setup/install.sh`
Expected: Çıktı yok, exit code 0.

- [ ] **Step 7: Dashboard systemd şablonunu güncelle**

`services/aundekiosk-dashboard.service.template`'teki `Environment=` satırlarına TLS yollarını ekle (opsiyonel override olarak; `server.ts` zaten `/opt/aundekiosk/tls/{cert,key}.pem`'i varsayılan kabul ediyor, bu satırlar sadece açıklık için):

```ini
[Unit]
Description=Run AundeKiosk dashboard
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/deno run --allow-net=0.0.0.0:8080 --allow-read=/opt/aundekiosk --allow-write=/opt/aundekiosk --allow-env=PORT,AUNDEKIOSK_CONFIG_FILE,AUNDEKIOSK_AUTH_STORE_FILE,AUNDEKIOSK_AUDIT_LOG_FILE,AUNDEKIOSK_TLS_CERT,AUNDEKIOSK_TLS_KEY /opt/aundekiosk/dashboard/server.ts
WorkingDirectory=/opt/aundekiosk
Environment=PORT=8080
User=aundekiosk
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 8: Tüm test paketini çalıştır**

Run: `bash tests/run_all.sh` (önce `tests/run_all.sh`'a `"$SCRIPT_DIR/setup/generate_tls_cert_test.sh" \` satırını `install_test.sh`'tan önce ekle)
Expected: Her bölüm için `0 failed`, "All bash test suites passed."

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/`
Expected: Task 1–8'deki tüm Deno testleri PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/setup/generate-tls-cert.sh tests/setup/generate_tls_cert_test.sh scripts/setup/install.sh services/aundekiosk-dashboard.service.template tests/run_all.sh
git commit -m "feat: add self-signed TLS, completing Plan 2"
```
