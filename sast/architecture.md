# Architecture: AundeKiosk

## Technology Stack

| Category | Details |
|---|---|
| Languages | TypeScript (Deno runtime), Bash, Python 3.12 |
| Frameworks | None (raw Deno HTTP, hand-rolled routing in server.ts) |
| Databases | JSON flat-file (auth.db, mode 0600) — no SQL engine |
| Auth mechanism | Session cookie (in-memory Map, 256-bit token), Argon2id (hash-wasm 4.11.0), step-up re-auth for destructive ops |
| Infrastructure | systemd services, NetworkManager (nmcli), sudo privilege-escalation model |
| External services | None — LAN-only kiosk |
| Crypto | Argon2id: m=19MiB t=2 p=1 salt=16B hash=32B; session tokens: `crypto.getRandomValues` 32 bytes base64url |
| VNC | wayvnc (Wayland compositor capture) → noVNC (browser client) proxied through dashboard WS |
| Terminal | Python 3 PTY-over-WebSocket (`pty_ws_server.py`, root-owned service) proxied through dashboard WS |
| TLS | Self-signed cert; enforced by `resolveTlsMode()` — HTTP only if `AUNDEKIOSK_ALLOW_HTTP=1` |

## Architecture Overview

AundeKiosk is a **single-machine monolith** running on a Raspberry Pi 4 factory kiosk. The system has three main runtime processes:

1. **Dashboard** (`aundekiosk-dashboard.service`, user `aundekiosk`): Deno HTTPS server on port 8080. All dashboard logic, auth, config management, and privileged action dispatch live here.
2. **PTY server** (`aundekiosk-tty.service`, user `root`): Python 3 WebSocket server on `127.0.0.1:7681`. Forks `/bin/bash -l` per connection and proxies I/O using the ttyd wire protocol. Runs as root intentionally (admin root shell).
3. **wayvnc** (`wayvnc.service`): Captures the Wayland compositor and serves VNC on `localhost:5900`. Proxied to browser via noVNC through the dashboard's `/novnc-ws` WebSocket endpoint.
4. **Chromium kiosk** (`aundekiosk-runner.service`): Runs Chromium in `--kiosk` mode displaying configured URLs. URL switching uses CDP (`--remote-debugging-port=9222`) via `cdp-navigate.py`.

**Privileged helper model**: the `aundekiosk` user cannot perform root-level OS operations directly. Instead, `dashboard/privileged_runner.ts` invokes `sudo /opt/aundekiosk/privileged/<script>.sh` for each privileged action. The sudoers whitelist grants NOPASSWD only for exact, argument-free invocations (plus two hard-coded toggle args: `enable`/`disable`). Secrets and variable data travel over stdin as JSON, never as argv (argv is world-readable via `/proc/<pid>/cmdline`).

## Data Flow

**Login:**
`Browser POST /api/login (JSON: {username, password})` → `auth_api.ts:handleLogin` → rate limiter check (10 req/60s per IP) → `credential_store.ts:verifyCredentials` (Argon2id verify, serialize queue, lockout check) → session store creates 256-bit token → `Set-Cookie: aundekiosk_session=<token>; HttpOnly; SameSite=Strict; Secure`

**Config save:**
`Browser POST /api/config (JSON: {urls: [...]})` → `requireAdmin()` → `config_api.ts:handlePost` → URL validation (`http/https` protocol check via `new URL()`) → normalize (drop extra fields, trim URLs) → atomic write-then-rename to `config.json` → trigger kiosk restart (CDP `cdp-navigate.py`)

**Network apply:**
`Browser POST /api/network/apply (JSON: {interface, mode, ..., confirmPassword})` → `requireAdmin()` → `network_api.ts:handleApply` → TypeScript-level validation (interface: eth0|wlan0, mode: dhcp|static, CIDR/IPv4 patterns) → step-up auth (re-verify password) → `runPrivilegedCommand("sudo", [".../apply-network-config.sh"], JSON.stringify(payload))` → Bash reads from stdin via `jq` → lib.sh validators → nmcli apply → systemd rollback timer (-60s auto-rollback unless confirmed)

**Terminal (WS):**
`Browser WS /tty-ws` → `requireAdmin()` → `tty_proxy.ts:handleUpgrade` → WS bridge to `ws://127.0.0.1:7681/ws` → `pty_ws_server.py` forks `/bin/bash -l` (root) ↔ PTY ↔ browser

**VNC (WS):**
`Browser WS /novnc-ws` → `requireAdmin()` → `novnc_proxy.ts:handleUpgrade` → raw TCP relay to `127.0.0.1:5900` (wayvnc RFB protocol)

## Entry Points

| Entry Point | Type | Auth Required | Description |
|---|---|---|---|
| `GET /api/setup-status` | HTTP | None | Returns `{hasAdmin: bool}` |
| `POST /api/setup` | HTTP | None (one-time) | Create initial admin (409 if already exists) |
| `POST /api/login` | HTTP | None | Rate-limited (10/60s per IP) |
| `POST /api/logout` | HTTP | None | Destroys session cookie |
| `GET /api/config` | HTTP | Session (viewer+) | Read kiosk URL config |
| `POST /api/config` | HTTP | Admin | Write kiosk URL config, trigger restart |
| `GET /api/status` | HTTP | Session | System metrics (CPU, mem, uptime, etc.) |
| `GET /api/audit-log` | HTTP | Admin | Tail of audit.log |
| `POST /api/reboot` | HTTP | Admin + step-up | `sudo reboot-device.sh` |
| `POST /api/ssh/toggle` | HTTP | Admin | `sudo toggle-ssh.sh enable|disable` |
| `POST /api/ssh/password-auth` | HTTP | Admin | `sudo toggle-ssh-password-auth.sh enable|disable` |
| `POST /api/os-password` | HTTP | Admin + step-up | `sudo change-os-password.sh` (stdin JSON) |
| `POST /api/network/apply` | HTTP | Admin + step-up | `sudo apply-network-config.sh` (stdin JSON) |
| `POST /api/network/confirm` | HTTP | Admin + step-up | `sudo confirm-network-config.sh` |
| `POST /api/snmp` | HTTP | Admin + step-up | `sudo configure-snmp.sh` (stdin JSON) |
| `POST /api/hostname` | HTTP | Admin + step-up | `sudo change-hostname.sh` (stdin JSON) |
| `POST /api/vnc/toggle` | HTTP | Admin | `sudo toggle-vnc.sh enable|disable` |
| `GET /api/services` | HTTP | Admin | `systemctl is-active` for 4 named units |
| `POST /api/services` | HTTP | Admin | `sudo toggle-service.sh <unit> start|stop` |
| `POST /api/update` | HTTP | Admin | `sudo run-update.sh` (git pull + install) |
| `GET /api/users` | HTTP | Admin | List users (no password hashes) |
| `POST /api/users` | HTTP | Admin | Create user |
| `DELETE /api/users/:username` | HTTP | Admin | Delete user (cannot delete last) |
| `PUT /api/users/:username/role` | HTTP | Admin | Change role (admin\|viewer) |
| `PUT /api/users/:username/password` | HTTP | Admin + step-up | Reset another user's password |
| `GET /novnc/*` | HTTP static | None | noVNC JS client files |
| `WS /novnc-ws` | WebSocket | Admin | VNC proxy (→ wayvnc :5900) |
| `WS /tty-ws` | WebSocket | Admin | Terminal proxy (→ pty_ws_server :7681) |
| `GET /terminal` | HTTP | Admin | Serves terminal HTML page |
| `GET /*` | HTTP static | None | Dashboard SPA static assets |

## Trust Boundaries

| Boundary | What Crosses It | Direction | Protection |
|---|---|---|---|
| Internet / LAN → Dashboard | HTTPS requests | Inbound | TLS, session cookie (HttpOnly, Secure, SameSite=Strict), auth gates |
| Dashboard process → PTY server | WebSocket frames (raw terminal I/O) | Both | Only reachable from 127.0.0.1; admin session required before proxy |
| Dashboard process → wayvnc | TCP (RFB protocol) | Both | Only reachable from 127.0.0.1; admin session required before proxy |
| Dashboard (aundekiosk user) → root helpers | stdin JSON + sudo | Outbound | Sudoers whitelist: exact scripts, no wildcards; input validation in lib.sh |
| Privileged helpers → OS | nmcli, chpasswd, systemctl, raspi-config | Outbound | Validators in lib.sh; secrets via stdin/heredoc, never argv |
| Admin → Terminal | WebSocket → bash (root) | Both | Admin re-auth not required beyond existing admin session |
| Chromium kiosk → External sites | HTTPS | Outbound | No filtering — loads whatever URLs are in config.json |

## Sensitive Data Inventory

| Data Type | Where Stored | How Accessed | Protection |
|---|---|---|---|
| Admin passwords (Argon2id hash) | `/opt/aundekiosk/auth.db` (JSON) | credential_store.ts | Mode 0600, owned by aundekiosk; serialize queue prevents race |
| Session tokens | In-memory Map (dashboard process) | session_store.ts | Never persisted; 256-bit random; HttpOnly Secure SameSite=Strict cookie |
| WiFi PSK | NetworkManager `/etc/NetworkManager/system-connections/` | apply-network-config.sh via nmcli heredoc | Root-owned 0600 by NM; in-transit via stdin JSON + heredoc |
| SNMP credentials | `/var/lib/snmp/snmpd.conf`, `/etc/snmp/snmpd.conf` | configure-snmp.sh | Root-owned 0600; in-transit via stdin JSON + heredoc |
| OS user password | chpasswd (not stored by AundeKiosk) | change-os-password.sh | In-transit via stdin JSON; newline-checked; hardcoded allowed user |
| Audit log | `/opt/aundekiosk/audit.log` | audit_log.ts (append-only) | Mode 0600; readable by admin via GET /api/audit-log |
| Kiosk URLs | `/opt/aundekiosk/config.json` | config_api.ts | Mode 0644 (intentional — readable by kiosk runner as different user) |
| Network backup | `/etc/aundekiosk-priv/network-backup.json` | apply-network-config.sh, rollback-network.sh | Root-owned, 0077 umask directory |
| Pi OS username | `/etc/aundekiosk-priv/pi-user.txt` | change-os-password.sh | Root-owned directory; prevents arbitrary account targeting |

## Notes for Vulnerability Analysis

- **Step-up auth**: Endpoints marked "Admin + step-up" require re-submitting the current admin password in the request body. This is enforced by `auth/step_up.ts` / `auth/require_step_up.ts`.
- **Viewer role**: A `viewer` session can read config and status but cannot trigger any privileged actions.
- **Rate limiter**: Applied only at `/api/login`. The Map keys (IP strings) are never deleted — only timestamps within each key's array are pruned. Memory grows unboundedly with unique source IPs.
- **Cookie parsing**: `readSessionToken` splits on the first `=` only; session tokens strip base64 `=` padding at creation, so this is safe.
- **Timing attack mitigations**: `verifyCredentials` hashes against a real hash even for unknown usernames (dummy hash from first user record). Lockout check happens BEFORE password verify, so lock state is visible to timing analysis, but this is expected for a lockout mechanism.
- **SNMP heredoc injection surface**: `configure-snmp.sh` writes `AUTH_PASSPHRASE` and `PRIV_PASSPHRASE` between single-quote delimiters in a heredoc. `is_safe_secret_value` guards newlines/CRs but not single-quote characters. Net-snmp config parsing behavior with embedded quotes needs evaluation.
- **WiFi SSID injection surface**: `apply-network-config.sh` calls `is_safe_secret_value` on `WIFI_PASSWORD` but NOT on `WIFI_SSID`. A SSID containing a newline character would pass `is_valid_wifi_ssid` (length check only) and could inject lines into the nmcli interactive session heredoc.
- **pty_ws_server.py runs as root**: By design — it provides an admin root shell. Any authenticated admin who reaches `/tty-ws` gets unrestricted root access.
- **recover-config.sh / recovery/server.ts**: Separate recovery mechanism (different port, no normal auth) — needs separate analysis.
