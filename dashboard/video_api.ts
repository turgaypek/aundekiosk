const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const VALID_FILENAME = /^[A-Za-z0-9._\- ]+\.mp4$/i;

export interface VideoApiOptions {
  videosDir: string;
  stateDir: string;
}

export function createVideoApi(opts: VideoApiOptions) {
  const { videosDir, stateDir } = opts;

  function isValidFilename(name: string): boolean {
    return VALID_FILENAME.test(name) && !name.includes("/") && !name.includes("..");
  }

  async function handleList(): Promise<Response> {
    const files: { name: string; size: number; modified: number }[] = [];
    try {
      for await (const entry of Deno.readDir(videosDir)) {
        if (!entry.isFile || !entry.name.toLowerCase().endsWith(".mp4")) continue;
        const info = await Deno.stat(`${videosDir}/${entry.name}`);
        files.push({ name: entry.name, size: info.size, modified: info.mtime?.getTime() ?? 0 });
      }
    } catch {
      // videos dir may not exist on first run
    }
    files.sort((a, b) => b.modified - a.modified);
    return Response.json(files);
  }

  async function handleUpload(req: Request): Promise<Response> {
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("multipart/form-data")) {
      return new Response("multipart/form-data required.", { status: 400 });
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return new Response("Invalid form data.", { status: 400 });
    }
    const file = form.get("video");
    if (!(file instanceof File)) {
      return new Response("'video' field required.", { status: 400 });
    }
    const filename = file.name.trim();
    if (!isValidFilename(filename)) {
      return new Response("Invalid filename. Only .mp4 files with safe names allowed.", { status: 400 });
    }
    if (file.size > MAX_VIDEO_BYTES) {
      return new Response("File exceeds 2 GB limit.", { status: 413 });
    }
    try {
      await Deno.mkdir(videosDir, { recursive: true });
    } catch { /* already exists */ }
    const dest = `${videosDir}/${filename}`;
    await Deno.writeFile(dest, new Uint8Array(await file.arrayBuffer()));
    return new Response("Uploaded.", { status: 201 });
  }

  async function handleServe(req: Request, filename: string): Promise<Response> {
    if (!isValidFilename(filename)) {
      return new Response("Not Found", { status: 404 });
    }
    const path = `${videosDir}/${filename}`;
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(path);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    const total = stat.size;
    const rangeHeader = req.headers.get("range");
    let start = 0;
    let end = total - 1;
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        start = parseInt(m[1]);
        end = m[2] ? parseInt(m[2]) : total - 1;
      }
    }
    if (start > end || start >= total) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    end = Math.min(end, total - 1);
    const length = end - start + 1;
    const file = await Deno.open(path, { read: true });
    await file.seek(start, Deno.SeekMode.Start);
    // Slice the stream to exactly `length` bytes so the browser doesn't hang
    // waiting for more data after a partial request.
    const limited = file.readable.pipeThrough(
      new TransformStream({
        transform(chunk, ctrl) {
          ctrl.enqueue(chunk);
        },
      }),
    );
    return new Response(limited, {
      status: rangeHeader ? 206 : 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(length),
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${total}`,
      },
    });
  }

  async function handleDelete(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const filename = (body as Record<string, unknown>).filename;
    if (typeof filename !== "string" || !isValidFilename(filename)) {
      return new Response("Invalid filename.", { status: 400 });
    }
    try {
      await Deno.remove(`${videosDir}/${filename}`);
    } catch {
      return new Response("Not found.", { status: 404 });
    }
    return new Response("Deleted.");
  }

  async function handlePlay(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const filename = (body as Record<string, unknown>).filename;
    if (typeof filename !== "string" || !isValidFilename(filename)) {
      return new Response("Invalid filename.", { status: 400 });
    }
    try {
      await Deno.stat(`${videosDir}/${filename}`);
    } catch {
      return new Response("Video file not found.", { status: 404 });
    }
    try {
      await Deno.mkdir(stateDir, { recursive: true });
    } catch { /* already exists */ }
    // Write filename so play-video.sh can read it without needing an argument
    // (keeps the sudoers entry argument-free).
    await Deno.writeTextFile(`${stateDir}/video-request`, filename);
    // Remove any stale signals from a previous session.
    for (const f of ["video-done", "video-stop"]) {
      try { await Deno.remove(`${stateDir}/${f}`); } catch { /* ok */ }
    }
    const cmd = new Deno.Command("sudo", {
      args: ["/opt/aundekiosk/privileged/play-video.sh"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    cmd.spawn();
    return new Response("Playback started.", { status: 202 });
  }

  async function handleStop(): Promise<Response> {
    try {
      await Deno.mkdir(stateDir, { recursive: true });
    } catch { /* already exists */ }
    await Deno.writeTextFile(`${stateDir}/video-stop`, "1");
    return new Response("Stop signal sent.");
  }

  // Called by the video player page (no auth cookie) when the video ends.
  async function handleDone(): Promise<Response> {
    try {
      await Deno.mkdir(stateDir, { recursive: true });
    } catch { /* already exists */ }
    await Deno.writeTextFile(`${stateDir}/video-done`, "1");
    return new Response("OK");
  }

  return { handleList, handleUpload, handleServe, handleDelete, handlePlay, handleStop, handleDone };
}
