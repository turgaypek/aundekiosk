export interface AuditLogOptions {
  logPath: string;
}

// Every call site passes English event names and detail values by
// convention — this module never translates anything, so the log stays
// in one consistent language regardless of the UI's current locale
// (spec §6/§9). Appends only; the file is never truncated or rewritten.
export function createAuditLog(opts: AuditLogOptions) {
  const { logPath } = opts;

  async function record(
    event: string,
    details: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...details,
    };
    await Deno.writeTextFile(logPath, JSON.stringify(entry) + "\n", {
      append: true,
      mode: 0o600,
    });
  }

  return { record };
}
