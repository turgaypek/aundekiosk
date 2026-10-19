# Security Assessment Final Report

**Project**: AundeKiosk (Raspberry Pi Factory Kiosk Dashboard)
**Generated**: 2026-10-19
**Scans completed**: Missing Auth/Authz, RCE, Hardcoded Secrets, Path Traversal, IDOR, SSRF

---

## Executive Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 0 |
| Medium | 2 |
| Low | 0 |
| **Total confirmed findings** | **3** |

Scans with no confirmed vulnerabilities: Hardcoded Secrets, Path Traversal, SSRF

Scans not yet run: XSS, SQLi, XXE, File Upload, SSTI, JWT, Business Logic, GraphQL

Business-logic concerns identified (not vulnerability-class findings): 3 (see `sast/idor-results.md` — no last-admin guard on role demotion/deletion, default role is "admin" on user create).

---

## Vulnerability Index

| # | Title | Type | Severity | Endpoint / File |
|---|-------|------|----------|----------------|
| 1 | PTY WebSocket server — no Origin validation | Missing Auth | Critical | `ws://127.0.0.1:7681/ws` |
| 2 | nmcli SSID injection in apply-network-config.sh ⚠ | RCE | Medium | `POST /api/network/apply` → `privileged/apply-network-config.sh` |
| 3 | nmcli SSID injection in rollback-network.sh ⚠ | RCE | Medium | systemd rollback timer → `privileged/rollback-network.sh` |

---

## Findings

### Critical

#### PTY WebSocket server — no Origin validation ⚠ Likely Vulnerable

- **Source scan**: `sast/missingauth-results.md`
- **Classification**: Likely Vulnerable
- **Endpoint / File**: `dashboard/pty_ws_server.py` — `ws://127.0.0.1:7681/ws`
- **Severity rationale**: The PTY server runs as root and forks an interactive `/bin/bash -l` shell for every connection. Any JavaScript executing inside the Chromium kiosk — including scripts from external kiosk URLs configured by an admin, or a page with XSS — can open `ws://127.0.0.1:7681/ws` and receive a root shell. Browsers do not block cross-origin WebSocket connections to localhost (unlike XHR, WebSocket upgrades bypass the Same-Origin Policy). This is an unauthenticated privilege-escalation path from "script running in kiosk browser" to "root OS shell", bypassing the entire dashboard authentication model.
- **Issue**: `pty_ws_server.py` performs a manual HTTP→WebSocket upgrade (`ws_handshake()`). The handshake reads the `Upgrade: websocket` header and builds a 101 response, but never checks the `Origin` header. Any WebSocket client — including browser JavaScript from any origin — connecting to `ws://127.0.0.1:7681/ws` with the `tty` subprotocol receives an immediate root bash shell with no credentials.
- **Impact**: A malicious or XSS-compromised page loaded in the kiosk browser can silently obtain a root shell on the Pi. From there the attacker has full control of the device: can read/write all files, install backdoors, exfiltrate data, pivot to the factory network, and cannot be stopped by the dashboard's authentication. The `requireAdmin()` gate on `/tty-ws` in the dashboard is bypassed entirely by connecting directly to port 7681.
- **Proof**:
  ```
  # pty_ws_server.py ws_handshake() — no Origin check:
  def ws_handshake(sock):
      # Reads HTTP request, checks "Upgrade: websocket", builds 101 response.
      # No Origin validation before completing the upgrade.
      # Any client connecting to ws://127.0.0.1:7681/ws gets a root bash shell.

  # Dashboard proxy (dashboard/tty_proxy.ts) is auth-gated:
  #   GET /tty-ws → requireAdmin() → tty_proxy.ts → ws://127.0.0.1:7681/ws
  # But the PTY server accepts direct connections BYPASSING the proxy entirely.
  ```
- **Remediation**:

  **Option A (recommended) — Unix domain socket**: Bind the PTY server to a Unix domain socket (`/run/aundekiosk/pty.sock`) owned by `aundekiosk:aundekiosk` mode `0600`. Update `tty_proxy.ts` to connect via the socket path. Filesystem permissions replace Origin validation and no TCP port is exposed. In `pty_ws_server.py`:
  ```python
  import socket, os
  SOCK_PATH = "/run/aundekiosk/pty.sock"
  srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
  os.unlink(SOCK_PATH) if os.path.exists(SOCK_PATH) else None
  srv.bind(SOCK_PATH)
  os.chmod(SOCK_PATH, 0o600)
  srv.listen(5)
  ```
  In `tty_proxy.ts`, update `backendUrl` to a Unix socket connection (Deno supports `Deno.connect({ transport: "unix", path: "/run/aundekiosk/pty.sock" })`).

  **Option B — Origin allowlist**: Add Origin header validation in `ws_handshake()`. Accept only the dashboard origin (`https://<Pi-IP>:8080`); reject all others with a 403:
  ```python
  def ws_handshake(sock):
      data = b""
      while b"\r\n\r\n" not in data:
          data += sock.recv(1024)
      headers = {}
      for line in data.split(b"\r\n")[1:]:
          if b": " in line:
              k, v = line.split(b": ", 1)
              headers[k.lower()] = v.decode()
      origin = headers.get(b"origin", "")
      # Allow only the dashboard; reject all others
      ALLOWED_ORIGINS = {"https://127.0.0.1:8080", "https://192.168.14.128:8080",
                         "https://192.168.14.160:8080"}
      if origin not in ALLOWED_ORIGINS:
          sock.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
          sock.close()
          return False
      # ... rest of handshake
  ```
  Note: Option A is more robust because it eliminates the TCP port entirely; Option B is bypassable by non-browser clients (e.g., `wscat --header "Origin: https://192.168.14.128:8080"`).

- **Dynamic Test**:
  ```bash
  # From any process on the Pi (including the kiosk browser's JS console):
  # 1. Confirm the port is open without dashboard auth:
  nc -z 127.0.0.1 7681 && echo "OPEN"

  # 2. Connect directly, bypassing dashboard auth:
  #    (requires wscat: npm install -g wscat)
  wscat --protocol tty --connect ws://127.0.0.1:7681/ws
  # Expected if vulnerable: immediate bash prompt — root shell, no credentials asked.

  # 3. Browser JS payload (run in kiosk browser developer console or inject via XSS):
  #    const ws = new WebSocket('ws://127.0.0.1:7681/ws', ['tty']);
  #    ws.onmessage = e => console.log('Shell output:', e.data);
  #    ws.onopen = () => ws.send(JSON.stringify({type: 'input', data: 'id\n'}));
  # Expected: root shell output
  ```

---

### Medium

#### nmcli SSID injection in apply-network-config.sh ⚠ Likely Vulnerable

- **Source scan**: `sast/rce-results.md`
- **Classification**: Likely Vulnerable
- **Endpoint / File**: `privileged/apply-network-config.sh` (lines 148–155) — reached via `POST /api/network/apply`
- **Severity rationale**: Requires admin role + step-up password re-verification. Impact is constrained to nmcli interactive-mode commands (no arbitrary OS command execution). However, an authenticated admin can inject nmcli directives to alter network configuration in ways the UI would never permit — for example disabling WiFi encryption — effectively bypassing the TypeScript-layer validation. The step-up requirement significantly reduces exploitability; this is a defense-in-depth gap rather than an unauthenticated attack surface.
- **Issue**: `WIFI_SSID` is extracted from user-supplied JSON via `jq -r '.wifiSsid'` and passed into an unquoted heredoc sent to `nmcli connection edit`. `is_valid_wifi_ssid` only checks byte length (1–32 characters). `is_safe_secret_value` (the newline/CR guard) is called on `WIFI_PASSWORD` but **not** on `WIFI_SSID`. A newline character in the SSID is one byte and passes the length check, then expands in the heredoc to inject additional nmcli interactive commands.
- **Impact**: An authenticated admin can inject additional nmcli interactive commands. Possible injected directives: `set wifi-sec.key-mgmt none` (disable WiFi encryption), `set ipv4.method manual ipv4.addresses 0.0.0.0/0` (misconfigure network), or other `nmcli connection` properties. This allows an admin to apply network settings that the dashboard UI would not normally permit, bypassing TypeScript-level validation. Impact is bounded by nmcli interactive mode — no arbitrary OS command execution.
- **Proof**:
  ```
  Taint trace:
  POST /api/network/apply {wifiSsid: "test\nset wifi-sec.key-mgmt none"}
    → network_api.ts:validateNetworkPayload — checks ssid.length 1-32, NO newline check
    → runPrivilegedCommand("sudo", [".../apply-network-config.sh"], JSON.stringify(payload))
    → apply-network-config.sh reads stdin JSON via jq
    → WIFI_SSID=$(echo "$PAYLOAD" | jq -r '.wifiSsid')
    → is_valid_wifi_ssid "$WIFI_SSID"  ← only checks length, PASSES
    → (no is_safe_secret_value call)
    → heredoc expansion: "set 802-11-wireless.ssid test\nset wifi-sec.key-mgmt none"
    → nmcli connection edit receives injected command
  ```
- **Remediation**:

  1. Add `is_safe_secret_value` check in `privileged/apply-network-config.sh` immediately after `is_valid_wifi_ssid`:
  ```bash
  is_valid_wifi_ssid "$WIFI_SSID" || { echo "Invalid WiFi SSID." >&2; exit 1; }
  is_safe_secret_value "$WIFI_SSID" || { echo "WiFi SSID must not contain a newline." >&2; exit 1; }
  ```

  2. Add newline validation in `dashboard/network_api.ts` `validateNetworkPayload()` for defense-in-depth:
  ```typescript
  if (ssid.includes('\n') || ssid.includes('\r')) {
    return "wifiSsid must not contain newline characters.";
  }
  ```

- **Dynamic Test**:
  ```bash
  # Requires valid admin session cookie and current admin password.
  # JSON \n is a literal newline in the string value.
  curl -k -b "aundekiosk_session=<ADMIN_SESSION>" \
    -H "Content-Type: application/json" \
    -d '{"interface":"wlan0","mode":"dhcp","wifiSsid":"test\nset wifi-sec.key-mgmt none","wifiPassword":"validpass123","confirmPassword":"<ADMIN_PASSWORD>"}' \
    https://192.168.14.128:8080/api/network/apply
  # Expected if vulnerable: nmcli processes "set wifi-sec.key-mgmt none" as a second command.
  # Verify: nmcli connection show <connection-id> | grep key-mgmt
  ```

---

#### nmcli SSID injection in rollback-network.sh ⚠ Likely Vulnerable (second-order)

- **Source scan**: `sast/rce-results.md`
- **Classification**: Likely Vulnerable
- **Endpoint / File**: `privileged/rollback-network.sh` (lines 51–57) — invoked by systemd rollback timer
- **Severity rationale**: Same class as finding #2 but second-order: this sink is only exploitable if a malicious SSID was previously stored in NetworkManager via finding #2. The step-up + admin requirement for the triggering action, combined with the two-step exploit chain, makes this lower-probability than finding #2. Both should be fixed together for consistency.
- **Issue**: `rollback-network.sh` reads `WIFI_SSID` from `/etc/aundekiosk-priv/network-backup.json` (root-owned) without calling `is_safe_secret_value`. In the normal rollback path the backup contains the pre-change SSID (from nmcli output) and is unlikely to contain newlines. However, if finding #2 was exploited and a malicious SSID was stored in NetworkManager, and if the rollback timer fires (because the network change wasn't confirmed within 60 seconds), the backup may carry the injected SSID, which would re-inject through the rollback heredoc.
- **Impact**: Same class as finding #2. If a malicious SSID was previously applied to NetworkManager, the 60-second rollback path could re-trigger the nmcli injection. The rollback script is also missing the guard, creating a consistent defense gap even if finding #2 is never exploited.
- **Proof**:
  ```
  Second-order taint trace:
  (Step 1) Finding #2 exploited: malicious SSID stored in NetworkManager
  (Step 2) apply-network-config.sh backs up CURRENT config before change
  (Step 3) If the backup contains a malicious SSID (from a prior successful inject):
    → rollback timer fires (no network confirmation within 60s)
    → rollback-network.sh reads WIFI_SSID from network-backup.json
    → is_valid_wifi_ssid check only — no is_safe_secret_value
    → heredoc expands newline → nmcli injection in rollback
  ```
- **Remediation**:

  Add `is_safe_secret_value` guard in `privileged/rollback-network.sh` for `WIFI_SSID`:
  ```bash
  WIFI_SSID=$(echo "$PAYLOAD" | jq -r '.wifiSsid // ""')
  # ADD:
  if [[ -n "$WIFI_SSID" ]]; then
    is_safe_secret_value "$WIFI_SSID" || {
      echo "Backup SSID contains an unsafe character; skipping WiFi rollback." >&2
      WIFI_SSID=""
      INTERFACE_SKIP_WIFI=1
    }
  fi
  ```

- **Dynamic Test**:
  ```bash
  # Prerequisite: trigger finding #2 to apply a SSID with "\n" into NetworkManager.
  # Then wait for the 60-second rollback timer to fire (do not confirm the network change).
  sudo journalctl -u aundekiosk-network-rollback.service --no-pager | tail -20
  nmcli connection show <connection-id> | grep -E 'key-mgmt|ssid'
  # Expected if vulnerable: unexpected nmcli property changes from rollback heredoc injection.
  ```

---

## Appendix: Scan Coverage

| Scan | Result File | Status |
|------|-------------|--------|
| Missing Auth/Authz | `sast/missingauth-results.md` | Completed |
| RCE | `sast/rce-results.md` | Completed |
| Hardcoded Secrets | `sast/hardcodedsecrets-results.md` | Completed |
| Path Traversal | `sast/pathtraversal-results.md` | Completed |
| IDOR | `sast/idor-results.md` | Completed |
| SSRF | `sast/ssrf-results.md` | Completed |
| XSS | `sast/xss-results.md` | Not run |
| SQLi | `sast/sqli-results.md` | Not run |
| XXE | `sast/xxe-results.md` | Not run |
| File Upload | `sast/fileupload-results.md` | Not run |
| SSTI | `sast/ssti-results.md` | Not run |
| JWT | `sast/jwt-results.md` | Not run |
| Business Logic | `sast/businesslogic-results.md` | Not run |
| GraphQL injection | `sast/graphql-results.md` | Not run |

### Notes on Unrun Scans

AundeKiosk's technology stack significantly limits the surface area for several of the unrun scan types:

- **XSS**: The dashboard is a Deno server-side application with no server-side template rendering. All HTML responses are hardcoded string literals or served as static files. Client-side XSS surface exists in the noVNC/terminal pages but inputs are constrained (admin-only). Worth running.
- **SQLi**: No SQL database — flat JSON file (`auth.db`). No SQL engine is in use. Very low expected yield.
- **XXE**: No XML processing in the codebase. Not applicable.
- **File Upload**: No file upload feature. Not applicable.
- **SSTI**: No server-side template engine. Not applicable.
- **JWT**: No JWT tokens — session cookies backed by an in-memory Map with random tokens. Not applicable.
- **Business Logic**: Several concerns already identified in IDOR scan (no last-admin guard, default role "admin"). A dedicated business logic pass could find additional edge cases.
- **GraphQL**: No GraphQL. Not applicable.
