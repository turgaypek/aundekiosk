import type { createStepUpGuard } from "./auth/step_up.ts";
import type { createAuditLog } from "./auth/audit_log.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

export interface VncApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Spec §6 requires every privileged action to be audit-logged with
  // who did it, from where, and whether it succeeded.
  auditLog: ReturnType<typeof createAuditLog>;
  runPrivilegedToggle: (action: "enable" | "disable") => Promise<void>;
}

export function createVncApi(opts: VncApiOptions) {
  const { stepUpGuard, auditLog, runPrivilegedToggle } = opts;

  async function handleToggle(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { action, confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    if (action !== "enable" && action !== "disable") {
      return new Response("action must be 'enable' or 'disable'.", { status: 400 });
    }

    try {
      await runPrivilegedToggle(action);
    } catch (error) {
      await auditLog.record("vnc_toggled", { username, ip, action, ok: false });
      throw error;
    }

    await auditLog.record("vnc_toggled", { username, ip, action, ok: true });
    return new Response(`VNC ${action}d.`, { status: 200 });
  }

  return { handleToggle };
}
