import type { createStepUpGuard } from "./auth/step_up.ts";
import type { createAuditLog } from "./auth/audit_log.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

const VALID_AUTH_PROTOCOLS = new Set(["SHA", "SHA-256"]);
const VALID_PRIV_PROTOCOLS = new Set(["AES"]);
const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const MIN_PASSPHRASE_LENGTH = 8;

// Defense in depth, mirroring the bash-level is_safe_secret_value check
// in privileged/lib.sh: a newline here would be written verbatim into
// net-snmp's config files and read as a second, attacker-chosen
// directive (final review: Critical C3).
function containsNewline(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

function validateSnmpPayload(body: Record<string, unknown>): string | null {
  if (body.enabled === false) return null;

  const username = body.username;
  const authProtocol = body.authProtocol;
  const authPassphrase = body.authPassphrase;
  const privProtocol = body.privProtocol;
  const privPassphrase = body.privPassphrase;
  const allowedSource = body.allowedSource;

  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
    return "username must be 1-32 alphanumeric/underscore/hyphen characters.";
  }
  if (typeof authProtocol !== "string" || !VALID_AUTH_PROTOCOLS.has(authProtocol)) {
    return "authProtocol must be 'SHA' or 'SHA-256'.";
  }
  if (typeof authPassphrase !== "string" || authPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `authPassphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  if (containsNewline(authPassphrase)) {
    return "authPassphrase must not contain a newline.";
  }
  if (typeof privProtocol !== "string" || !VALID_PRIV_PROTOCOLS.has(privProtocol)) {
    return "privProtocol must be 'AES'.";
  }
  if (typeof privPassphrase !== "string" || privPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `privPassphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  if (containsNewline(privPassphrase)) {
    return "privPassphrase must not contain a newline.";
  }
  if (typeof allowedSource !== "string" || allowedSource.length === 0) {
    return "allowedSource is required.";
  }
  return null;
}

export interface SnmpApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Spec §6 requires every privileged action to be audit-logged with
  // who did it, from where, and whether it succeeded (final review:
  // Important I6).
  auditLog: ReturnType<typeof createAuditLog>;
  // Injected for testability; server.ts supplies the real sudo-based
  // caller, which pipes the payload (including both passphrases) to
  // configure-snmp.sh over stdin as JSON, never as command-line arguments.
  runPrivilegedConfigure: (payload: Record<string, unknown>) => Promise<void>;
}

export function createSnmpApi(opts: SnmpApiOptions) {
  const { stepUpGuard, auditLog, runPrivilegedConfigure } = opts;

  async function handleConfigure(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const record = body as Record<string, unknown>;

    const validationError = validateSnmpPayload(record);
    if (validationError) {
      return new Response(validationError, { status: 400 });
    }

    const stepUp = await requireStepUp(stepUpGuard, username, record.confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    const { confirmPassword: _confirmPassword, ...payload } = record;
    const enabled = payload.enabled !== false;
    try {
      await runPrivilegedConfigure(payload);
    } catch (error) {
      await auditLog.record("snmp_configured", { username, ip, enabled, ok: false });
      throw error;
    }

    await auditLog.record("snmp_configured", { username, ip, enabled, ok: true });
    return new Response("SNMP configuration updated.", { status: 200 });
  }

  return { handleConfigure };
}
