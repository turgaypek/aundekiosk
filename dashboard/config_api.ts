interface KioskUrlEntry {
  url: string;
  duration: number;
  cycles: number;
}

// Only http/https parse successfully here with an allowed protocol, so this
// also rejects "javascript:", "file:", and anything with a syntax error —
// including a value like "https://ok.test --proxy-server=evil.test:8080",
// where the space immediately after the host breaks URL parsing outright.
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidConfigShape(value: unknown): value is { urls: KioskUrlEntry[] } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.urls)) return false;
  return obj.urls.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.url === "string" &&
      isValidHttpUrl(e.url.trim()) &&
      typeof e.duration === "number" &&
      Number.isInteger(e.duration) &&
      e.duration >= 1 &&
      e.duration <= 300 &&
      typeof e.cycles === "number" &&
      Number.isInteger(e.cycles) &&
      e.cycles >= 0 &&
      e.cycles <= 100
    );
  });
}

export interface ConfigApiOptions {
  configPath: string;
  samplePath?: string;
}

export function createConfigApi(opts: ConfigApiOptions) {
  const { configPath } = opts;
  const samplePath = opts.samplePath ?? configPath.replace(/config\.json$/, "config.json.sample");

  async function handleGet(): Promise<Response> {
    try {
      const data = await Deno.readTextFile(configPath);
      return new Response(data, { headers: { "Content-Type": "application/json" } });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        const sample = await Deno.readTextFile(samplePath);
        return new Response(sample, { headers: { "Content-Type": "application/json" } });
      }
      console.error("Error reading config:", error);
      return new Response("Could not read config.", { status: 500 });
    }
  }

  async function handlePost(req: Request): Promise<Response> {
    const body = await req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }

    if (!isValidConfigShape(parsed)) {
      return new Response(
        "Invalid config shape: expected { urls: [{ url (http/https), duration (1-300), cycles (0-100) }] }.",
        { status: 400 },
      );
    }

    // Drop any unexpected extra fields and trim whitespace around each URL,
    // so only the known, validated shape ever reaches disk.
    const normalized = {
      urls: parsed.urls.map((entry) => ({
        url: entry.url.trim(),
        duration: entry.duration,
        cycles: entry.cycles,
      })),
    };

    // Write-then-rename so a power loss or crash mid-write can never leave
    // config.json truncated or empty — the rename is atomic on the same
    // filesystem, so readers always see either the old or the new content.
    const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmpPath, JSON.stringify(normalized, null, 2));
    await Deno.rename(tmpPath, configPath);
    return new Response("Config saved.", { status: 200 });
  }

  return { handleGet, handlePost };
}
