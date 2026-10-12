import type { createStepUpGuard } from "./auth/step_up.ts";
import type { createAuditLog } from "./auth/audit_log.ts";
import { requireStepUp } from "./auth/require_step_up.ts";

const VALID_SERVICES = [
  "aundekiosk-dashboard",
  "aundekiosk-monitor",
  "aundekiosk-runner",
  "aundekiosk-switcher",
] as const;
const VALID_SERVICE_SET = new Set<string>(VALID_SERVICES);

export interface ServiceControlApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  // Spec §6 requires every privileged action to be audit-logged with
  // who did it, from where, and whether it succeeded.
  auditLog: ReturnType<typeof createAuditLog>;
  // Injected for testability; server.ts supplies the real sudo-based
  // caller for the actual start/stop (toggle-service.sh), and a plain
  // (unprivileged) `systemctl is-active` call for status reads — reading
  // status needs no elevated privilege, only mutating the unit does.
  runPrivilegedToggle: (service: string, action: "start" | "stop") => Promise<void>;
  checkServiceStatus: (service: string) => Promise<string>;
}

export function createServiceControlApi(opts: ServiceControlApiOptions) {
  const { stepUpGuard, auditLog, runPrivilegedToggle, checkServiceStatus } = opts;

  async function handleStatus(): Promise<Response> {
    const statuses: Record<string, string> = {};
    for (const service of VALID_SERVICES) {
      statuses[service] = await checkServiceStatus(service);
    }
    return Response.json(statuses);
  }

  async function handleToggle(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { service, action, confirmPassword } = body as Record<string, unknown>;

    if (typeof service !== "string" || !VALID_SERVICE_SET.has(service)) {
      return new Response("service must be one of the four AundeKiosk units.", { status: 400 });
    }
    if (action !== "start" && action !== "stop") {
      return new Response("action must be 'start' or 'stop'.", { status: 400 });
    }

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    try {
      await runPrivilegedToggle(service, action);
    } catch (error) {
      await auditLog.record("service_toggled", { username, ip, service, action, ok: false });
      throw error;
    }

    await auditLog.record("service_toggled", { username, ip, service, action, ok: true });
    return new Response(`${service} ${action}ed.`, { status: 200 });
  }

  return { handleStatus, handleToggle };
}
