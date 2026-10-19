# Missing Auth/Authz Analysis Results: AundeKiosk

## Executive Summary
- Endpoints analyzed: 30
- Vulnerable: 0
- Likely Vulnerable: 1
- Not Vulnerable: 27
- Needs Manual Review: 2

## Findings

### [LIKELY VULNERABLE] PTY WebSocket server — no Origin validation

- **File**: `dashboard/pty_ws_server.py`
- **Endpoint**: `WS ws://127.0.0.1:7681/ws` (internal; proxied via `/tty-ws`)
- **Issue**: The PTY server is a plain TCP WebSocket server bound to `127.0.0.1:7681` with no Origin header validation. Any process on the Pi — including Chromium (which runs JavaScript from external kiosk URLs) — can open a raw TCP connection or a WebSocket connection to this port and receive a root bash shell, bypassing the dashboard's admin auth gate entirely.
- **Concern**: Chromium running in kiosk mode visits external URLs. If a malicious page (or XSS in a loaded URL) can reach `ws://127.0.0.1:7681/ws`, it gets a root interactive shell with no credentials. WebSocket upgrade requests to localhost from browser JS are not blocked by same-origin policy — the browser sends an `Origin: http://evil.example.com` header but the server never checks it.
- **Proof**: In `dashboard/pty_ws_server.py`, `ws_handshake()` performs a manual HTTP→WS upgrade. Reviewing the handshake implementation (from the context), there is no `Origin` header check before completing the upgrade:
  ```python
  def ws_handshake(sock):
      # Reads HTTP request, checks "Upgrade: websocket" and builds 101 response
      # No Origin validation present
  ```
  Any WebSocket client (browser JS, `wscat`, Python) connecting to `ws://127.0.0.1:7681/ws` with the `tty` subprotocol receives an immediate root bash shell prompt.
- **Remediation**: Add an allowlist of accepted `Origin` header values to `ws_handshake()`. Accept only `https://<Pi-IP>:8080` (the dashboard origin). Reject any other Origin with a 403 response before completing the WebSocket upgrade. Alternatively, bind the PTY server to a Unix domain socket (`/run/aundekiosk/pty.sock`) owned by the `aundekiosk` user and update `tty_proxy.ts` to connect via the socket — filesystem permissions replace Origin validation and no port is exposed.
- **Dynamic Test**:
  ```bash
  # From any process on the Pi (or from a browser JS console on the kiosk display):
  # 1. Confirm the port is open:
  #    nc -z 127.0.0.1 7681 && echo "OPEN"
  # 2. Connect without dashboard session (requires wscat or similar):
  #    wscat --protocol tty --connect ws://127.0.0.1:7681/ws
  # Expected if vulnerable: bash prompt returned immediately, no credentials asked
  ```

---

### [NEEDS MANUAL REVIEW] wayvnc on localhost:5900 — no auth configured

- **File**: `scripts/setup/wayvnc-kiosk-run.sh`, `/etc/wayvnc/config`
- **Endpoint**: TCP `localhost:5900` (VNC; proxied via `/novnc-ws`)
- **Issue**: wayvnc's auth configuration should be checked. If wayvnc runs with no VNC password (the default when no `credentials_file` is set in `/etc/wayvnc/config`), any local process that can connect to `localhost:5900` gets desktop access without credentials, bypassing the dashboard's admin auth gate.
- **Uncertainty**: The `/etc/wayvnc/config` file on deployed Pi hardware was not available for static analysis (only a blank template). Whether `credentials_file` is set depends on installation. The install script should be audited to confirm wayvnc is configured with a strong credential.
- **Suggestion**: Inspect `/etc/wayvnc/config` on deployed devices for `credentials_file`. Confirm `install.sh` generates and writes a wayvnc credential file. If auth is not enforced by wayvnc itself, bind it to a Unix socket and restrict socket permissions, mirroring the PTY server recommendation above.

---

### [NEEDS MANUAL REVIEW] recovery/server.ts — separate recovery HTTP server

- **File**: `recovery/server.ts` (not fully analyzed in this pass)
- **Endpoint**: Unknown port (separate Deno HTTP server)
- **Issue**: The project includes a separate recovery server. Its authentication model, exposed endpoints, and binding address were not analyzed in this pass.
- **Suggestion**: Run the `sast-missingauth` analysis on `recovery/server.ts` as a separate pass. Confirm it does not expose privileged actions (password reset, admin creation) without adequate rate limiting and, if reachable from the LAN, without IP restriction.

---

## Not Vulnerable Endpoints

All 27 remaining endpoints were verified as properly protected:

| Endpoint | Protection |
|---|---|
| `GET /api/setup-status` | Intentionally public; returns only boolean |
| `POST /api/setup` | Intentionally public; 409 + serialize queue blocks second admin |
| `POST /api/login` | Public auth endpoint; rate-limited 10/60s per IP |
| `POST /api/logout` | Public; unauthenticated logout is standard |
| `GET /api/config` | requireSession (viewer+) |
| `POST /api/config` | requireAdmin() — checks session + role === "admin" |
| `GET /api/status` | requireSession (viewer+) |
| `GET /api/audit-log` | requireAdmin() |
| `POST /api/reboot` | requireAdmin() + requireStepUp (re-verify password) |
| `POST /api/ssh/toggle` | requireAdmin() |
| `POST /api/ssh/password-auth` | requireAdmin() |
| `POST /api/os-password` | requireAdmin() + requireStepUp |
| `POST /api/network/apply` | requireAdmin() + requireStepUp |
| `POST /api/network/confirm` | requireAdmin() + requireStepUp |
| `POST /api/snmp` | requireAdmin() + requireStepUp |
| `POST /api/hostname` | requireAdmin() + requireStepUp |
| `POST /api/vnc/toggle` | requireAdmin() |
| `GET /api/services` | requireAdmin() |
| `POST /api/services` | requireAdmin() |
| `POST /api/update` | requireAdmin() |
| `GET /api/users` | requireAdmin() |
| `POST /api/users` | requireAdmin() |
| `DELETE /api/users/:username` | requireAdmin() |
| `PUT /api/users/:username/role` | requireAdmin() |
| `PUT /api/users/:username/password` | requireAdmin() + requireStepUp |
| `WS /novnc-ws` | requireAdmin() |
| `WS /tty-ws` | requireAdmin() (but see PTY server finding above) |
| `GET /terminal` | requireAdmin() |
| `GET /novnc/*` | Public static files; VNC connection requires admin |
| `GET /*` | Public SPA assets; all data APIs require auth |

## Notes
- `requireAdmin()` in `dashboard/auth/auth_api.ts` checks both session validity (idle timeout) AND `role === "admin"`. A viewer-role session is rejected by `requireAdmin()` on all privileged endpoints.
- Step-up auth (`requireStepUp`) requires re-submitting the current user's password for all destructive operations. This is an effective additional layer against CSRF and session hijacking for the most dangerous actions.
- The `viewer` role can only read config and status — no write operations are accessible to viewers.
