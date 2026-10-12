const MONITOR_EVENT_TYPES = new Set([
  "threshold_triggered",
  "action_suppressed_startup_grace",
  "action_executed",
]);

const MAX_EVENTS = 20;

export interface MonitorEventsApiOptions {
  auditLogPath: string;
}

export function createMonitorEventsApi(opts: MonitorEventsApiOptions) {
  const { auditLogPath } = opts;

  async function handleGet(): Promise<Response> {
    let text: string;
    try {
      text = await Deno.readTextFile(auditLogPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return Response.json([]);
      }
      throw error;
    }

    // The audit log is a single append-only file shared with the
    // dashboard's own login/service/config events (spec §6/§9) — this
    // filters down to just the resource monitor's own entries, written
    // by monitor/resource-monitor.sh via append_monitor_audit_event,
    // which is the only place an admin could otherwise see which
    // metric (CPU or RAM) actually crossed a tier's threshold.
    const events = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .filter((entry) => MONITOR_EVENT_TYPES.has(entry.event));

    events.reverse();
    return Response.json(events.slice(0, MAX_EVENTS));
  }

  return { handleGet };
}
