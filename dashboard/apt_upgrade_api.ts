import type { createStepUpGuard } from "./auth/step_up.ts";
import type { createAuditLog } from "./auth/audit_log.ts";
import { requireStepUp } from "./auth/require_step_up.ts";
import { PrivilegedCommandError } from "./privileged_runner.ts";

// Bounds how much of apt-upgrade.log a single /apt-upgrade/status poll
// returns — a big upgrade's output can run into the hundreds of KB, and
// the admin only ever needs to see the tail while it's progressing (same
// reasoning as audit_log_api.ts's MAX_EVENTS cap).
const MAX_LOG_CHARS = 200_000;

// apt-upgrade.sh itself writes these exact marker lines (see the script)
// once the detached systemd unit finishes — the only reliable way to
// know "it succeeded" after the transient unit may already be gone,
// since we never rely on systemd's own unit bookkeeping surviving long
// enough for a poll to see it.
const SUCCESS_MARKER = "=== apt update/upgrade finished successfully";

export interface AptUpgradeApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  auditLog: ReturnType<typeof createAuditLog>;
  // Invokes "sudo apt-upgrade.sh start"; throws PrivilegedCommandError
  // with code 2 when an upgrade is already running (apt-upgrade.sh's own
  // distinct exit code for that case, same convention as
  // confirm-network-config.sh's "nothing was pending").
  runPrivilegedStart: () => Promise<void>;
  // Querying a systemd unit's state needs no elevated privilege, same as
  // service_control_api.ts/remote_access_api.ts's checkServiceStatus.
  checkUnitActive: () => Promise<boolean>;
  readLog: () => Promise<string>;
  checkRebootRequired: () => Promise<boolean>;
}

export function createAptUpgradeApi(opts: AptUpgradeApiOptions) {
  const { stepUpGuard, auditLog, runPrivilegedStart, checkUnitActive, readLog, checkRebootRequired } = opts;

  async function handleStart(req: Request, username: string, ip: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const { confirmPassword } = body as Record<string, unknown>;

    const stepUp = await requireStepUp(stepUpGuard, username, confirmPassword, ip);
    if (!stepUp.ok) {
      return new Response(stepUp.message, { status: stepUp.status });
    }

    try {
      await runPrivilegedStart();
    } catch (error) {
      if (error instanceof PrivilegedCommandError && error.code === 2) {
        await auditLog.record("apt_upgrade_requested", { username, ip, ok: false, reason: "already_running" });
        return new Response("An apt update/upgrade is already running.", { status: 409 });
      }
      await auditLog.record("apt_upgrade_requested", { username, ip, ok: false });
      throw error;
    }

    await auditLog.record("apt_upgrade_requested", { username, ip, ok: true });
    return new Response("apt update/upgrade started.", { status: 202 });
  }

  async function handleStatus(): Promise<Response> {
    const [running, rawLog, rebootRequired] = await Promise.all([
      checkUnitActive(),
      readLog(),
      checkRebootRequired(),
    ]);

    let state: "idle" | "running" | "success" | "failed";
    if (running) {
      state = "running";
    } else if (rawLog === "") {
      state = "idle";
    } else if (rawLog.includes(SUCCESS_MARKER)) {
      state = "success";
    } else {
      state = "failed";
    }

    const log = rawLog.length > MAX_LOG_CHARS ? rawLog.slice(rawLog.length - MAX_LOG_CHARS) : rawLog;
    return Response.json({ state, log, rebootRequired });
  }

  return { handleStart, handleStatus };
}
