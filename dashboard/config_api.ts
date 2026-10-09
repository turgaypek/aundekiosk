interface KioskUrlEntry {
  url: string;
  duration: number;
  cycles: number;
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
      e.url.length > 0 &&
      typeof e.duration === "number" &&
      Number.isFinite(e.duration) &&
      typeof e.cycles === "number" &&
      Number.isFinite(e.cycles)
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
        "Invalid config shape: expected { urls: [{ url, duration, cycles }] }.",
        { status: 400 },
      );
    }

    await Deno.writeTextFile(configPath, JSON.stringify(parsed, null, 2));
    return new Response("Config saved.", { status: 200 });
  }

  return { handleGet, handlePost };
}
