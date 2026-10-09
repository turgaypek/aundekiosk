const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return CONTENT_TYPES[path.slice(dot)] ?? "application/octet-stream";
}

// Serves files strictly from within `publicDir`. Every candidate path is
// resolved to its real, canonical filesystem path (Deno.realPath resolves
// ".." segments and symlinks) and checked against the resolved root before
// anything is read — this is what stops a request like `/../../etc/passwd`
// from escaping the served directory.
export function createStaticHandler(publicDir: string) {
  const root = Deno.realPathSync(publicDir);

  return async function handleStatic(pathname: string): Promise<Response> {
    const relative = pathname === "/" ? "/index.html" : pathname;
    const candidate = `${root}/${relative}`.replace(/\/{2,}/g, "/");

    let resolved: string;
    try {
      resolved = await Deno.realPath(candidate);
    } catch {
      return new Response("Not Found", { status: 404 });
    }

    // Deno.realPath returns native-separator paths (backslashes on Windows),
    // even when the input used forward slashes. Compare on a forward-slash
    // normalized form so the containment check is correct on every OS.
    const resolvedPosix = resolved.replace(/\\/g, "/");
    const rootPosix = root.replace(/\\/g, "/");
    if (resolvedPosix !== rootPosix && !resolvedPosix.startsWith(rootPosix + "/")) {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const file = await Deno.readFile(resolved);
      return new Response(file, {
        headers: { "Content-Type": contentTypeFor(resolved) },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  };
}
