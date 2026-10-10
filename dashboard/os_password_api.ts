import type { createStepUpGuard } from "./auth/step_up.ts";
import type { createAuditLog } from "./auth/audit_log.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

const MIN_OS_PASSWORD_LENGTH = 12;

// Defense in depth, mirroring the bash-level is_safe_secret_value check
// in privileged/lib.sh: a newline here is read by chpasswd as a SECOND
// "user:password" line (final review: Critical C1).
function containsNewline(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

export interface OsPasswordApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Spec §6 requires every privileged action to be audit-logged with
  // who did it, from where, and whether it succeeded (final review:
  // Important I6).
  auditLog: ReturnType<typeof createAuditLog>;
  // Injected for testability — server.ts supplies the real sudo-based
  // caller, which pipes { username, newPassword } to change-os-password.sh
  // over stdin (never as a command-line argument).
  runPrivilegedChange: (newPassword: string) => Promise<void>;
}

export function createOsPasswordApi(opts: OsPasswordApiOptions) {
  const { stepUpGuard, auditLog, runPrivilegedChange } = opts;

  async function handleChange(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { newPassword, confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (typeof newPassword !== "string" || newPassword.length < MIN_OS_PASSWORD_LENGTH) {
      return new Response(`newPassword must be at least ${MIN_OS_PASSWORD_LENGTH} characters.`, { status: 400 });
    }
    if (containsNewline(newPassword)) {
      return new Response("newPassword must not contain a newline.", { status: 400 });
    }

    try {
      await runPrivilegedChange(newPassword);
    } catch (error) {
      await auditLog.record("os_password_changed", { username, ip, ok: false });
      throw error;
    }

    await auditLog.record("os_password_changed", { username, ip, ok: true });
    return new Response("OS account password changed.", { status: 200 });
  }

  return { handleChange };
}
