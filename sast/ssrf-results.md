# SSRF Analysis Results: AundeKiosk

## Executive Summary
- Outbound call sites analyzed: 6
- Vulnerable: 0
- Likely Vulnerable: 0
- Not Vulnerable: 6
- Needs Manual Review: 0

No SSRF vulnerabilities found. AundeKiosk has no external API integrations. All outbound connections go to localhost (`127.0.0.1`) at hardcoded ports, and their destination values are captured at process startup from hardcoded defaults — no HTTP request data reaches any outbound call's destination argument.

## Findings

### [NOT VULNERABLE] noVNC TCP proxy — `Deno.connect` to VNC backend

- **File**: `dashboard/novnc_proxy.ts` (lines 7–16)
- **Endpoint / function**: `GET /novnc-ws` (WebSocket upgrade) → `noVncProxy.handleUpgrade(req)`
- **Reason**: `createNoVncProxy()` called in `server.ts:79` with no arguments. `backendHostname = "127.0.0.1"` and `backendPort = 5900` are captured in closure at proxy-creation time. `handleUpgrade(req)` never reads query params, headers, or body to influence the destination. No HTTP-request path reaches these variables.

---

### [NOT VULNERABLE] TTY WebSocket proxy — `new WebSocket` to PTY backend

- **File**: `dashboard/tty_proxy.ts` (lines 6–12)
- **Endpoint / function**: `GET /tty-ws` (WebSocket upgrade) → `ttyProxy.handleUpgrade(req)`
- **Reason**: Server entry point calls `createHandler()` with no arguments, so `ttyBackendUrl` resolves to `DEFAULT_TTY_BACKEND_URL = "ws://127.0.0.1:7681/ws"` always. The URL is fixed at startup. No HTTP request handler writes to `HandlerOptions.ttyBackendUrl`.

---

### [NOT VULNERABLE] Browser terminal page — client-side `new WebSocket` to same origin

- **File**: `dashboard/terminal_page.ts` (lines 38–39)
- **Endpoint / function**: `GET /terminal` → inline `<script>` in browser
- **Reason**: Runs client-side only (in browser). URL constructed from `location.protocol` + `location.host` — always same-origin (`/tty-ws`). Server emits static HTML with no interpolated values. Not a server-side request.

---

### [NOT VULNERABLE] CDP bridge — `urllib.request.urlopen` to Chromium debug port

- **File**: `runtime/cdp-navigate.py` (lines 17–18)
- **Endpoint / function**: `navigate()` — `urllib.request.urlopen(f"http://{host}:{port}/json")`
- **Reason**: `switcher.sh` passes only one argument (`$url`) to `cdp-navigate.py`; `host` and `port` stay at their defaults (`127.0.0.1:9222`). The `url` argument does not affect the HTTP GET destination — it is relayed as a CDP payload over a separate socket, not used as the `urlopen` URL.

---

### [NOT VULNERABLE] CDP bridge — `socket.create_connection` to Chromium debug port

- **File**: `runtime/cdp-navigate.py` (lines 25–35)
- **Endpoint / function**: `navigate()` — `socket.create_connection((host, port))`
- **Reason**: TCP connection target hardcoded to `127.0.0.1:9222`. The `url` from `sys.argv[1]` is admin-configured kiosk display URLs (the system's intentional core function), stored via `POST /api/config` which requires `requireAdmin()` + validates `http:`/`https:` protocol with `isValidHttpUrl()`. Chrome's subsequent navigation to those URLs is a deliberate browser feature, not unintended server-side SSRF.

---

### [NOT VULNERABLE] Install script — `curl` download with architecture-derived path

- **File**: `scripts/setup/install.sh` (lines 59–67)
- **Endpoint / function**: top-level install flow (runs once at install time)
- **Reason**: `TTYD_VER` is a hardcoded literal `"1.7.7"`. `TTYD_BIN` derives from `$(uname -m)` through a closed `case` with only two defined output values and an empty fallback that skips the download. Runs once at install time as root — no HTTP request can influence the download destination.
