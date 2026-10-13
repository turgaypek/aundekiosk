const MAX_EVENTS = 50;

export interface AuditLogApiOptions {
  auditLogPath: string;
}

// The general "who did what" viewer for the admin panel — unlike
// monitor_events_api.ts (which filters down to just the resource
// monitor's own entries), this returns every event type recorded in the
// shared audit log: logins, every privileged toggle/change, user
// management, and monitor events too.
export function createAuditLogApi(opts: AuditLogApiOptions) {
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

    const events = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    events.reverse();
    return Response.json(events.slice(0, MAX_EVENTS));
  }

  return { handleGet };
}
