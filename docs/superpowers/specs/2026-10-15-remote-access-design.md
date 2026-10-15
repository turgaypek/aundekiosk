# Browser-Based Remote Access Design (VNC + SSH Terminal)

**Date:** 2026-10-15  
**Status:** Approved — all four sections confirmed by user

## 1. Overview

Adds browser-based remote desktop (VNC) and interactive terminal (SSH/TTY) to the AundeKiosk admin dashboard. Admins can view and control the Pi's live Wayland desktop and open a shell from any browser — no VNC client or SSH client software required on the admin machine.

Both access modes:
- Require an active **admin-role** session (same `requireAdmin` gate as all other privileged endpoints)
- Route exclusively through the existing HTTPS dashboard on port 8080 — no additional firewall rules needed
- Bind their respective backend daemons to `127.0.0.1` to prevent direct LAN access that would bypass dashboard auth
- Emit audit log entries on WebSocket connect

---

## 2. VNC Subsystem

### Backend daemon

**wayvnc** is already installed as part of the Pi's Wayland stack. It currently listens on `0.0.0.0:5900`, reachable from the LAN directly. This must be restricted to `127.0.0.1:5900` by writing `~/.config/wayvnc/config` for `PI_USER` during install:

```
address=127.0.0.1
```

wayvnc is started by the existing Wayland/compositor session (not a separate systemd service), so no new service template is needed for it.

### Proxy module

**`dashboard/novnc_proxy.ts`** — WebSocket→TCP binary relay.

```
createNoVncProxy(opts?: { backendHostname?, backendPort? }) → { handleUpgrade(req: Request): Response }
```

- `handleUpgrade` calls `Deno.upgradeWebSocket(req)`, then in the socket's `open` event connects TCP to `127.0.0.1:5900`
- If the TCP connect fails, the WebSocket is closed with code 1011
- Two async loops relay raw bytes bidirectionally: TCP→WS (binary frames) and WS→TCP
- `backendHostname`/`backendPort` are injectable for testing (fake TCP server replaces wayvnc)

### Routes (additions to `server.ts`)

| Route | Auth | Description |
|-------|------|-------------|
| `GET /novnc-ws` | requireAdmin | WebSocket upgrade; audited; proxies binary frames to wayvnc |
| `GET /novnc/*` | requireAdmin | Static files served from `/usr/share/novnc/` |

The noVNC HTML client lives at `/novnc/vnc.html`. Opening it with `?autoconnect=true&path=novnc-ws` causes noVNC to open a WebSocket to `/novnc-ws` (same origin, so the session cookie is sent automatically).

### Package

`apt install novnc` → files at `/usr/share/novnc/`

---

## 3. SSH/TTY Subsystem

### Backend daemon

**ttyd** provides a WebSocket terminal daemon with PAM authentication. It binds exclusively to `127.0.0.1:7681` and runs the `login` command, which prompts for username and password via PAM.

**`services/aundekiosk-tty.service.template`** (new):
```ini
[Unit]
Description=AundeKiosk TTY daemon (browser terminal access)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/ttyd --interface 127.0.0.1 --port 7681 login
User=root
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`User=root` is required because `login(1)` calls PAM and must setuid to the authenticated user.

### Proxy module

**`dashboard/tty_proxy.ts`** — WebSocket→WebSocket relay.

```
createTtyProxy(opts?: { backendUrl? }) → { handleUpgrade(req: Request): Response }
```

- `handleUpgrade` upgrades the client WebSocket, then opens `ws://127.0.0.1:7681/ws` as the backend WS
- When backend opens, message relay is wired bidirectionally (frames pass through opaquely — the ttyd/xterm.js protocol is not decoded at the proxy layer)
- Close/error on either side closes the other

`backendUrl` is injectable for testing.

### ttyd wire protocol (handled by the terminal page's JavaScript)

| Direction | Frame type | Meaning |
|-----------|-----------|---------|
| Server → client | Binary, byte[0]=1 | Terminal output; byte[1:] is UTF-8 text |
| Server → client | Binary, byte[0]=2 | Window title (ignored in our client) |
| Server → client | Binary, byte[0]=3 | Preferences JSON (ignored) |
| Client → server | Text, `"0" + data` | Terminal input |
| Client → server | Text, `"1" + JSON` | Resize: `{"columns": N, "rows": M}` |

### Routes (additions to `server.ts`)

| Route | Auth | Description |
|-------|------|-------------|
| `GET /tty-ws` | requireAdmin | WebSocket upgrade; audited; proxies frames to ttyd |
| `GET /terminal` | requireAdmin | Returns `TERMINAL_HTML` — self-contained xterm.js page |

**`dashboard/terminal_page.ts`** exports the `TERMINAL_HTML` constant: a standalone HTML page that loads xterm.js from CDN and connects to `/tty-ws`.

> **Note:** The terminal page loads xterm.js from `cdn.jsdelivr.net`. Admin browsers must have internet access on first load; the browser cache handles subsequent loads.

### Package

`apt install ttyd`

---

## 4. Auth, Security, and Service Changes

### Auth gate

All four new routes (`/novnc-ws`, `/novnc/*`, `/tty-ws`, `/terminal`) use `requireAdmin(req)` at the top of their handler — the same pattern as every other admin-only endpoint. A request without a session returns 401; a non-admin session returns 403.

For WebSocket upgrade routes (`/novnc-ws`, `/tty-ws`): if the request lacks `Upgrade: websocket`, return 426 before attempting the upgrade.

### wayvnc LAN exposure (security-critical)

Without `~/.config/wayvnc/config`, wayvnc listens on `0.0.0.0:5900` — accessible from any machine on the LAN directly, entirely bypassing the dashboard's authentication. `install.sh` must write this config file. The service template change alone is not sufficient.

### Dashboard service template additions

`services/aundekiosk-dashboard.service.template` — ExecStart line modifications:

- `--allow-net`: change `0.0.0.0:8080` → `0.0.0.0:8080,127.0.0.1:5900,127.0.0.1:7681`  
  (`127.0.0.1:5900` for `Deno.connect` to wayvnc; `127.0.0.1:7681` for `new WebSocket(...)` to ttyd)
- `--allow-read`: append `,/usr/share/novnc`

### Audit log events

```json
{"event":"vnc_ws_connected","ts":...,"username":"admin"}
{"event":"tty_ws_connected","ts":...,"username":"admin"}
```

### install.sh additions

1. `apt install -y novnc ttyd`
2. `mkdir -p "$PI_HOME/.config/wayvnc"` + write `address=127.0.0.1` config
3. Copy `aundekiosk-tty.service.template` → `/etc/systemd/system/aundekiosk-tty.service`
4. `systemctl daemon-reload && systemctl enable aundekiosk-tty.service`

---

## 5. Frontend

Two buttons added to the Remote Access panel in `public/index.html`, between `#remote-access-list` and the Hostname section:

```html
<div class="d-flex flex-wrap gap-2 mt-3 mb-4">
  <button type="button" class="btn btn-outline-primary"
          data-i18n="remote_access_open_desktop"
          onclick="window.open('/novnc/vnc.html?autoconnect=true&path=novnc-ws', '_blank')">
    Open Desktop
  </button>
  <button type="button" class="btn btn-outline-primary"
          data-i18n="remote_access_open_terminal"
          onclick="window.open('/terminal', '_blank')">
    Open Terminal
  </button>
</div>
```

New locale keys (all three locale files):

| Key | tr | en | de |
|-----|----|----|----|
| `remote_access_open_desktop` | Masaüstünü Aç | Open Desktop | Desktop öffnen |
| `remote_access_open_terminal` | Terminali Aç | Open Terminal | Terminal öffnen |

No changes to `script.js` — the buttons use inline `onclick` handlers.

---

## 6. Global Constraints

- Targets Raspberry Pi 4/5 running Raspberry Pi OS Bookworm (Debian 12), 64-bit
- Dashboard is Deno/TypeScript; no new runtime dependencies beyond `novnc` and `ttyd` apt packages
- All new routes follow the existing `requireAdmin` pattern — no step-up required (VNC/terminal access is admin-only by session role, not a separate privilege level)
- wayvnc must already be installed and running (it is, as part of the labwc Wayland session)
- `novnc_proxy.ts` and `tty_proxy.ts` are stateless; all auth state lives in `server.ts`'s requireAdmin wrapper
