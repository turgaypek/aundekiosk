import type { createStepUpGuard } from "./auth/step_up.ts";
import type { createAuditLog } from "./auth/audit_log.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

// Mirrors privileged/lib.sh's is_valid_hostname (RFC 1123 label):
// 1-63 characters, letters/digits/hyphens only, never starting or
// ending with a hyphen. Defense in depth — change-hostname.sh validates
// again before ever handing this to raspi-config.
const HOSTNAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export interface HostnameApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Spec §6 requires every privileged action to be audit-logged with
  // who did it, from where, and whether it succeeded.
  auditLog: ReturnType<typeof createAuditLog>;
  // Injected for testability — server.ts supplies the real sudo-based
  // caller, which pipes { hostname } to change-hostname.sh over stdin.
  runPrivilegedChange: (hostname: string) => Promise<void>;
}

export function createHostnameApi(opts: HostnameApiOptions) {
  const { stepUpGuard, auditLog, runPrivilegedChange } = opts;

  async function handleChange(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { hostname, confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (typeof hostname !== "string" || !HOSTNAME_PATTERN.test(hostname)) {
      return new Response(
        "hostname must be 1-63 letters, digits, or hyphens, never starting or ending with a hyphen.",
        { status: 400 },
      );
    }

    try {
      await runPrivilegedChange(hostname);
    } catch (error) {
      await auditLog.record("hostname_changed", { username, ip, hostname, ok: false });
      throw error;
    }

    await auditLog.record("hostname_changed", { username, ip, hostname, ok: true });
    return new Response(`Hostname changed to ${hostname}. A reboot is required for every service to pick it up.`, {
      status: 200,
    });
  }

  return { handleChange };
}
