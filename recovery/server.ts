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

// This tool can reset any user's password and binds to loopback, but
// loopback is not a security boundary: the Pi's own kiosk Chromium is
// continuously showing arbitrary third-party pages, any of which could
// try a same-origin-policy-exempt POST or a DNS-rebinding attack against
// 127.0.0.1:8099 while this tool happens to be running. Checking Host
// blocks rebinding; requiring an application/json Content-Type on every
// mutating request forces a CORS preflight that this server never
// answers, so a browser never even sends the real cross-site request.
const ALLOWED_HOSTS = new Set(["127.0.0.1:8099", "localhost:8099"]);

function hasAllowedHost(req: Request): boolean {
  const host = req.headers.get("host");
  return host !== null && ALLOWED_HOSTS.has(host);
}

function hasJsonContentType(req: Request): boolean {
  const contentType = req.headers.get("content-type");
  return contentType !== null && contentType.toLowerCase().startsWith("application/json");
}

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
    if (!hasAllowedHost(req)) {
      return new Response("Host not allowed.", { status: 400 });
    }
    const url = new URL(req.url);
    if (url.pathname === "/status" && req.method === "GET") {
      return handleStatus();
    }
    if (url.pathname === "/reset-password" && req.method === "POST") {
      if (!hasJsonContentType(req)) return new Response("Content-Type must be application/json.", { status: 400 });
      return handleResetPassword(req);
    }
    if (url.pathname === "/create-admin" && req.method === "POST") {
      if (!hasJsonContentType(req)) return new Response("Content-Type must be application/json.", { status: 400 });
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
