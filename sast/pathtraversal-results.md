# Path Traversal Analysis Results: AundeKiosk

## Executive Summary
- Sinks analyzed: 5
- Vulnerable: 0
- Likely Vulnerable: 0
- Not Vulnerable: 5
- Needs Manual Review: 0

No path traversal vulnerabilities found.

## Notes

All dynamic file access in AundeKiosk flows through a single shared utility: `createStaticHandler` in `dashboard/static.ts`. This utility applies a correctly implemented two-step containment before every `Deno.readFile` call:

1. `Deno.realPath(candidate)` — called before any prefix check, resolving all `..` segments and symlinks to the canonical filesystem path. Throws (→ 404) if the target does not exist.
2. `resolvedPosix.startsWith(rootPosix + "/")` — prefix check uses a trailing `/` separator (prevents false matches against sibling directories) and is applied to the post-`realPath` canonical path, not raw user input. The base `root` is also canonicalized at handler construction via `Deno.realPathSync`.

On Linux (the runtime platform), `Deno.realPath` returns POSIX paths natively; no platform-specific bypass is applicable.

## Findings

### [NOT VULNERABLE] Static file handler — core `Deno.readFile(resolved)` in `createStaticHandler`

- **File**: `dashboard/static.ts` (lines 19–51)
- **Endpoint / function**: `createStaticHandler(publicDir)` → `handleStatic(pathname)`
- **Taint trace**:
  1. `pathname` arrives as the HTTP URL path component (user-supplied).
  2. `relative` is set to `/index.html` when `pathname === "/"`, otherwise `pathname` verbatim.
  3. `candidate = \`${root}/${relative}\`.replace(/\/{2,}/g, "/")` — raw user input concatenated with base directory.
  4. `resolved = await Deno.realPath(candidate)` — resolves all `..` segments and symlinks; throws on non-existent path → 404.
  5. `resolvedPosix.startsWith(rootPosix + "/")` — canonical path checked against canonical root with trailing `/`. Any path outside the root → 404.
  6. Only on both conditions passing does `Deno.readFile(resolved)` execute.
- **Mitigation evaluation**: `Deno.realPath` before prefix check ✓ · Trailing `/` separator ✓ · Applied to resolved (not raw) path ✓ · Base dir also canonicalized ✓
- **Reason**: Effective containment correctly applied.
- **Dynamic Test** (verifies containment):
  ```sh
  curl -k "https://<host>:8080/../../etc/passwd"
  # Expected: 404 Not Found

  curl -k "https://<host>:8080/%2F..%2F..%2Fetc%2Fpasswd"
  # Expected: 404 Not Found
  ```

---

### [NOT VULNERABLE] Dashboard root catch-all — `serveStatic(url.pathname)` (no auth required for static assets)

- **File**: `dashboard/server.ts` (line 503)
- **Endpoint / function**: `handle(req)` — catch-all for all unmatched routes
- **Reason**: Direct pass-through of `url.pathname` to `createStaticHandler`. Full containment is handled by the shared utility (see above).
- **Dynamic Test**:
  ```sh
  curl -k "https://<host>:8080/../../../etc/shadow"
  # Expected: 404 Not Found
  ```

---

### [NOT VULNERABLE] noVNC route — `serveNovnc(url.pathname.slice("/novnc".length))` (admin required)

- **File**: `dashboard/server.ts` (lines 476–483)
- **Endpoint / function**: `handle(req)` — route `/novnc/*`
- **Taint trace**: `url.pathname` user-supplied → prefix `/novnc` stripped → passed to `createStaticHandler("/usr/share/novnc")`. Deno's WHATWG URL parser normalises `..` segments before `url.pathname` is set, so `https://host/novnc/../../../etc/passwd` resolves `url.pathname` to `/etc/passwd` — the `/novnc/` prefix check fails and the branch is never entered. Even if it were entered, the `realPath` + prefix check in `createStaticHandler` would block the escape.
- **Reason**: Admin auth gate + URL normalisation + `createStaticHandler` containment — three independent layers.
- **Dynamic Test** (requires valid admin session cookie):
  ```sh
  curl -k -b "aundekiosk_session=<valid-admin-token>" \
    "https://<host>:8080/novnc/../../../../etc/passwd"
  # Expected: 404 Not Found
  ```

---

### [NOT VULNERABLE] Recovery server static-file call — unauthenticated but effectively mitigated

- **File**: `recovery/server.ts` (line 165)
- **Endpoint / function**: `handle(req)` — catch-all; no authentication required (`127.0.0.1:8099`)
- **Taint trace**: HTTP request arrives with no auth check → `url.pathname` passed directly to `serveStatic` → `createStaticHandler("recovery/public")` applies `Deno.realPath` + prefix check → any path resolving outside `recovery/public` returns 404.
- **Reason**: The absence of authentication does not affect path containment — the `realPath` + prefix check is the containment control, and it applies regardless of auth state.
- **Dynamic Test**:
  ```sh
  curl -v --path-as-is "http://127.0.0.1:8099/../../../etc/passwd" -H "Host: 127.0.0.1:8099"
  # Expected: 404 Not Found
  ```

---

### [NOT VULNERABLE] Generic `readFile` lambda in device-info wiring — all paths are hardcoded

- **File**: `dashboard/server.ts` (line 252); call sites in `dashboard/device_info_api.ts` (lines 30, 44)
- **Endpoint / function**: `createDeviceInfoApi` options wiring
- **Taint trace**: `handleGet()` is the only HTTP entry point; it accepts no file-path parameter from the request. The two call sites inside `device_info_api.ts` supply hardcoded string literals (`"/etc/resolv.conf"` and `"/etc/dhcpcd.conf"`). `ifname` (from `ip -4 -json addr` system output) is used only as a regex search pattern within already-read file content, not to select which file is opened. No user-controlled value reaches the `path` argument.
- **Reason**: No user-supplied input reaches the path variable at any current call site.
- **Latent design risk**: The lambda `(path) => Deno.readTextFile(path)` is an unconstrained file-read primitive. If a future caller passes a user-supplied value, arbitrary file reads would be possible. Suggested hardening: replace with zero-argument typed callbacks for each specific file (e.g., `{ readResolvConf: () => Deno.readTextFile("/etc/resolv.conf") }`), making it structurally impossible to pass arbitrary paths.
