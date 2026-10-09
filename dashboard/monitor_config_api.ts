interface MonitorTier {
  threshold: number;
  sustainedSamples: number;
  action: "log" | "restart_services" | "reboot";
  cooldownSeconds: number;
}

interface MonitorConfig {
  sampleIntervalSeconds: number;
  activeWindow: { start: string; end: string } | null;
  tiers: MonitorTier[];
}

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const VALID_ACTIONS = new Set(["log", "restart_services", "reboot"]);

// Upper bounds exist because the monitor daemon does its own arithmetic
// with these values in bash, not just TypeScript: $((NOW_EPOCH +
// cooldownSeconds)) overflows/errors on a huge value (confirmed: 1e300
// is a bash arithmetic error; a value near Number.MAX_SAFE_INTEGER wraps
// to negative, silently disabling the cooldown it was meant to enforce).
// 604800s = 7 days is already a generous ceiling for "don't repeat this
// for a while"; 1000 sustained samples is ~2.8 hours even at a 10s
// interval, far past any realistic alarm condition.
const MAX_COOLDOWN_SECONDS = 604800;
const MAX_SUSTAINED_SAMPLES = 1000;

function isValidTier(value: unknown): value is MonitorTier {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.threshold === "number" &&
    Number.isFinite(t.threshold) &&
    t.threshold >= 0 &&
    t.threshold <= 100 &&
    typeof t.sustainedSamples === "number" &&
    Number.isInteger(t.sustainedSamples) &&
    t.sustainedSamples >= 1 &&
    t.sustainedSamples <= MAX_SUSTAINED_SAMPLES &&
    typeof t.action === "string" &&
    VALID_ACTIONS.has(t.action) &&
    typeof t.cooldownSeconds === "number" &&
    Number.isInteger(t.cooldownSeconds) &&
    t.cooldownSeconds >= 0 &&
    t.cooldownSeconds <= MAX_COOLDOWN_SECONDS
  );
}

function isValidActiveWindow(value: unknown): value is MonitorConfig["activeWindow"] {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.start === "string" &&
    HHMM_PATTERN.test(w.start) &&
    typeof w.end === "string" &&
    HHMM_PATTERN.test(w.end)
  );
}

function isValidMonitorConfig(value: unknown): value is MonitorConfig {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.sampleIntervalSeconds === "number" &&
    Number.isInteger(c.sampleIntervalSeconds) &&
    c.sampleIntervalSeconds >= 1 &&
    c.sampleIntervalSeconds <= 3600 &&
    isValidActiveWindow(c.activeWindow) &&
    Array.isArray(c.tiers) &&
    c.tiers.every(isValidTier)
  );
}

export interface MonitorConfigApiOptions {
  configPath: string;
  samplePath?: string;
}

export function createMonitorConfigApi(opts: MonitorConfigApiOptions) {
  const { configPath } = opts;
  const samplePath = opts.samplePath ?? configPath.replace(/monitor-config\.json$/, "monitor-config.json.sample");

  async function handleGet(): Promise<Response> {
    try {
      const data = await Deno.readTextFile(configPath);
      return new Response(data, { headers: { "Content-Type": "application/json" } });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        const sample = await Deno.readTextFile(samplePath);
        return new Response(sample, { headers: { "Content-Type": "application/json" } });
      }
      console.error("Error reading monitor config:", error);
      return new Response("Could not read monitor config.", { status: 500 });
    }
  }

  async function handlePost(req: Request): Promise<Response> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await req.text());
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }

    if (!isValidMonitorConfig(parsed)) {
      return new Response(
        "Invalid monitor config shape: expected { sampleIntervalSeconds, activeWindow, tiers: [{ threshold, sustainedSamples, action, cooldownSeconds }] }.",
        { status: 400 },
      );
    }

    const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmpPath, JSON.stringify(parsed, null, 2));
    await Deno.rename(tmpPath, configPath);
    return new Response("Monitor config saved.", { status: 200 });
  }

  return { handleGet, handlePost };
}
