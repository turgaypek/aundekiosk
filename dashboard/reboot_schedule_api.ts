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
