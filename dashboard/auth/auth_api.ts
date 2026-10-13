import type { createCredentialStore } from "./credential_store.ts";
import type { createSessionStore } from "./session_store.ts";
import type { createRateLimiter } from "./rate_limiter.ts";
import type { createAuditLog } from "./audit_log.ts";
import { MIN_PASSWORD_LENGTH } from "./password.ts";

export interface AuthApiOptions {
  credentialStore: ReturnType<typeof createCredentialStore>;
  sessionStore: ReturnType<typeof createSessionStore>;
  rateLimiter: ReturnType<typeof createRateLimiter>;
  auditLog: ReturnType<typeof createAuditLog>;
}

const SESSION_COOKIE = "aundekiosk_session";
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 1024;

export function createAuthApi(opts: AuthApiOptions) {
  const { credentialStore, sessionStore, rateLimiter, auditLog } = opts;

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

  // Validates and trims the two credential fields every endpoint below
  // accepts. Rejecting an oversized value here means an attacker can't
  // force a multi-megabyte argon2 hash or a multi-megabyte audit log line.
  function readCredentials(
    body: Record<string, unknown>,
  ): { username: string; password: string } | { error: string } {
    const { username, password } = body;
    if (typeof username !== "string" || username.trim().length === 0) {
      return { error: "Username is required." };
    }
    if (username.length > MAX_USERNAME_LENGTH) {
      return { error: `Username must be at most ${MAX_USERNAME_LENGTH} characters.` };
    }
    if (typeof password !== "string" || password.length === 0) {
      return { error: "Password is required." };
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      return { error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
    }
    return { username: username.trim(), password };
  }

  async function handleSetupStatus(): Promise<Response> {
    return Response.json({ hasAdmin: await credentialStore.hasAdmin() });
  }

  async function handleSetup(req: Request, ip: string): Promise<Response> {
    if (await credentialStore.hasAdmin()) {
      return new Response("Admin already configured.", { status: 409 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const parsed = readCredentials(body as Record<string, unknown>);
    if ("error" in parsed) {
      return new Response(parsed.error, { status: 400 });
    }
    if (parsed.password.length < MIN_PASSWORD_LENGTH) {
      return new Response(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, { status: 400 });
    }

    try {
      await credentialStore.createInitialAdmin(parsed.username, parsed.password);
    } catch {
      // Lost a race against another concurrent setup request — the
      // credential store's internal serialization caught it; report the
      // same 409 a sequential second attempt would get, not a 500.
      return new Response("Admin already configured.", { status: 409 });
    }
    await auditLog.record("admin_created", { username: parsed.username, ip });
    return new Response("Admin created.", { status: 201 });
  }

  async function handleLogin(req: Request, ip: string): Promise<Response> {
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
    const parsed = readCredentials(body as Record<string, unknown>);
    if ("error" in parsed) {
      return new Response(parsed.error, { status: 400 });
    }
    const { username, password } = parsed;

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
      if (result.justLocked) {
        await auditLog.record("account_locked", { username, ip });
      }
      return new Response("Invalid username or password.", { status: 401 });
    }

    const token = sessionStore.createSession(username);
    await auditLog.record("login_succeeded", { username, ip });
    return new Response("Logged in.", { status: 200, headers: { "Set-Cookie": sessionCookieHeader(token) } });
  }

  async function handleLogout(req: Request, ip: string): Promise<Response> {
    const token = readSessionToken(req);
    if (token) {
      sessionStore.destroy(token);
      await auditLog.record("logout", { ip });
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
