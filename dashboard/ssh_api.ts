import type { createStepUpGuard } from "./auth/step_up.ts";
import type { createAuditLog } from "./auth/audit_log.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

export interface SshApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Spec §6 requires every privileged action, not just login/step-up,
  // to leave an audit trail of who did it, from where, and whether it
  // succeeded (final review: Important I6).
  auditLog: ReturnType<typeof createAuditLog>;
  // Both injected so the API logic is testable without ever shelling out
  // to a real privileged helper; server.ts supplies the real sudo-based
  // callers.
  runPrivilegedToggle: (action: "enable" | "disable") => Promise<void>;
  // SSH password-auth hardening (spec §8.1) — the privileged helper
  // (toggle-ssh-password-auth.sh) and its sudoers entry existed since
  // Task 2, but nothing in the API ever called it until now (final
  // review: Important I7).
  runPrivilegedPasswordAuthToggle: (action: "enable" | "disable") => Promise<void>;
}

export function createSshApi(opts: SshApiOptions) {
  const { stepUpGuard, auditLog, runPrivilegedToggle, runPrivilegedPasswordAuthToggle } = opts;

  async function handleToggle(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { target, action, confirmPassword } = body as Record<string, unknown>;

    if (target !== undefined && target !== "service" && target !== "password_auth") {
      return new Response("target must be 'service' or 'password_auth'.", { status: 400 });
    }

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (action !== "enable" && action !== "disable") {
      return new Response("action must be 'enable' or 'disable'.", { status: 400 });
    }

    const isPasswordAuth = target === "password_auth";
    try {
      if (isPasswordAuth) {
        await runPrivilegedPasswordAuthToggle(action);
      } else {
        await runPrivilegedToggle(action);
      }
    } catch (error) {
      await auditLog.record("ssh_toggled", { username, ip, target: target ?? "service", action, ok: false });
      throw error;
    }

    await auditLog.record("ssh_toggled", { username, ip, target: target ?? "service", action, ok: true });
    return new Response(
      isPasswordAuth ? `SSH password authentication ${action}d.` : `SSH ${action}d.`,
      { status: 200 },
    );
  }

  return { handleToggle };
}
