interface KioskUrlEntry {
  url: string;
  duration: number;
  cycles: number;
}

interface KioskVideoEntry {
  type: "video";
  filename: string;
}

type PlaylistItem = KioskUrlEntry | KioskVideoEntry;

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

// Only [A-Za-z0-9._- ] with a .mp4 extension — same rule as play-video.sh.
const VALID_VIDEO_FILENAME = /^[A-Za-z0-9._\- ]+\.mp4$/i;

function isValidPlaylistItem(entry: unknown): entry is PlaylistItem {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  if (e.type === "video") {
    return typeof e.filename === "string" && VALID_VIDEO_FILENAME.test(e.filename);
  }
  // URL item (type absent or "url")
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
}

function isValidConfigShape(value: unknown): value is { urls: PlaylistItem[] } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.urls)) return false;
  // At least one URL item must exist so runner.sh always has a start URL.
  const hasUrl = obj.urls.some((e) => {
    if (typeof e !== "object" || e === null) return false;
    return (e as Record<string, unknown>).type !== "video";
  });
  if (!hasUrl && obj.urls.length > 0) return false;
  return obj.urls.every(isValidPlaylistItem);
}

export interface ConfigApiOptions {
  configPath: string;
  samplePath?: string;
  // Called after every successful save so the runner relaunches Chromium
  // with the updated URL list (runner reads URLs once at startup).
  // Best-effort: failures are logged but do not fail the config save.
  runKioskRestart?: () => Promise<void>;
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
        "Invalid config shape: expected { urls: [ {url, duration, cycles} | {type:\"video\", filename} ] } with at least one URL item.",
        { status: 400 },
      );
    }

    // Drop any unexpected extra fields so only the known, validated shape
    // ever reaches disk.  Video items keep type+filename; URL items keep
    // url (trimmed) + duration + cycles.
    const normalized = {
      urls: parsed.urls.map((entry) => {
        if ("type" in entry && entry.type === "video") {
          return { type: "video" as const, filename: (entry as KioskVideoEntry).filename };
        }
        const u = entry as KioskUrlEntry;
        return { url: u.url.trim(), duration: u.duration, cycles: u.cycles };
      }),
    };

    // Write-then-rename so a power loss or crash mid-write can never leave
    // config.json truncated or empty — the rename is atomic on the same
    // filesystem, so readers always see either the old or the new content.
    const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmpPath, JSON.stringify(normalized, null, 2));
    // The dashboard service runs with UMask=0077 (so audit.log/auth.db,
    // which hold real secrets, can never end up world-readable) — but that
    // umask also applies here, leaving config.json mode 600 and unreadable
    // by the "pi" user, which is who actually runs the kiosk display.
    // config.json holds no secrets (just display URLs), so force it
    // world-readable explicitly rather than relaxing the service's umask.
    try {
      await Deno.chmod(tmpPath, 0o644);
    } catch {
      // Deno.chmod is a no-op/unsupported on Windows; harmless to skip there.
    }
    await Deno.rename(tmpPath, configPath);

    // Best-effort backup — failure is non-fatal since the main save already succeeded.
    const backupPath = `${configPath}.backup`;
    const backupTmpPath = `${backupPath}.tmp-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(backupTmpPath, JSON.stringify(normalized, null, 2));
      try { await Deno.chmod(backupTmpPath, 0o644); } catch { /* no-op on Windows */ }
      await Deno.rename(backupTmpPath, backupPath);
    } catch {
      // Backup failure does not fail the config save.
    }

    if (opts.runKioskRestart) {
      try {
        await opts.runKioskRestart();
      } catch (error) {
        console.error("Kiosk restart after config save failed:", error);
      }
    }

    return new Response("Config saved.", { status: 200 });
  }

  async function handleBackupInfo(): Promise<Response> {
    const backupPath = `${configPath}.backup`;
    try {
      const stat = await Deno.stat(backupPath);
      const mtimeMs = stat.mtime?.getTime() ?? Date.now();
      const backupAgeSeconds = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
      return Response.json({ hasBackup: true, backupAgeSeconds });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return Response.json({ hasBackup: false, backupAgeSeconds: null });
      }
      throw error;
    }
  }

  return { handleGet, handlePost, handleBackupInfo };
}
