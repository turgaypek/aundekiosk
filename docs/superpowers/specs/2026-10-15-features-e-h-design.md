# AundeKiosk Features E–H: Design Spec

**Features:**
- **E – User Roles**: Admin vs viewer access control
- **F – Device Status**: Live hostname, IP, DNS, gateway display
- **G – Scheduled Reboot**: Configurable daily reboot via project-managed systemd timer
- **H – Crash Recovery**: Automatic config rollback after repeated runner service failures

---

## §1 User Roles (Feature E)

### Problem

Every dashboard user currently has full admin access. In a multi-site or multi-user deployment, a local technician should be able to update screen URLs without accessing network settings, OS passwords, or user management.

### Data Shape

Add `role: "admin" | "viewer"` to `UserRecord` in `credential_store.ts`. Legacy records without a `role` field are treated as `"admin"` (no migration step; backward-compat read in the existing `read()` function is sufficient).

```typescript
interface UserRecord {
  username: string;
  email: string | null;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: number | null;
  role: "admin" | "viewer";   // ← new; absent in legacy files → treat as "admin"
}
```

### Permissions

**Viewer** (allowed):
- `GET /api/setup`, `POST /api/login`, `POST /api/logout`
- `GET /config`, `POST /config` (URL list — the entire purpose of the viewer role)

**Admin only** (everything else): network, hostname, SSH, VNC, SNMP, OS password, users, services, monitor config, audit log, APT upgrade, reboot schedule (G), device info (F).

### Session

`requireSession` currently returns `{ username }`. Extend the `SessionRecord` in `session_store.ts` to include `role`. `auth_api.ts` reads the user's role from `credentialStore` at login time and stores it in the session — no per-request DB reads.

`server.ts` gains two helpers:
```typescript
// Returns session or null (unchanged callers still work)
function requireSession(req: Request): { username: string; role: "admin" | "viewer" } | null

// Returns session or immediately returns 401/403
function requireAdmin(req: Request):
  | { username: string; role: "admin" }
  | Response  // 401 if no session, 403 if viewer
```

All existing routes that were `requireSession` + admin action become `requireAdmin`. The two viewer-allowed routes (`GET /config`, `POST /config`) keep the plain `requireSession` check.

### API Changes

- `POST /users` body: accepts optional `role: "admin" | "viewer"` (default `"admin"`)
- `GET /users` response: includes `role` per user record

### UI

- Users section: role dropdown (Admin / Viewer) in the add-user form
- Role badge next to each username in the list
- Viewer sees **only** the URL list section; all system sections are hidden in the frontend

New locale keys (all three locales):
```
users_role_label, users_role_admin, users_role_viewer
```

---

## §2 Device Status Display (Feature F)

### Problem

The dashboard can change hostname and network settings but never shows current values. Admins must SSH in to see the device's IP address or confirm what hostname was applied.

### Endpoint

`GET /device-info` → no step-up, any authenticated session (admin or viewer).

Response shape:
```typescript
interface DeviceInfoResponse {
  hostname: string;
  interfaces: {
    name: string;
    mode: "dhcp" | "static" | "unknown";
    address: string | null;   // e.g. "192.168.14.160"
    prefix: number | null;    // e.g. 24
    gateway: string | null;
    dns: string[];
  }[];
}
```

### Implementation

No privileged script needed — all reads are available to the `pi` user:

| Data | Command |
|------|---------|
| hostname | `hostname` |
| IP + prefix | `ip -4 -json addr show eth0` (or wlan0) |
| Gateway | `ip -4 route show default dev eth0` |
| DNS | `cat /etc/resolv.conf` (lines starting `nameserver`) |
| DHCP vs static | parse `/etc/dhcpcd.conf`: absence of `static ip_address=` for that interface → DHCP |

New file: `dashboard/device_info_api.ts`

```typescript
export interface DeviceInfoApiOptions {
  runCommand: (cmd: string, args: string[]) => Promise<string>;
  readFile: (path: string) => Promise<string>;
}

export function createDeviceInfoApi(opts: DeviceInfoApiOptions) {
  async function handleGet(): Promise<Response> { ... }
  return { handleGet };
}
```

`runCommand` and `readFile` injected for testability. `server.ts` supplies real `Deno.Command` / `Deno.readTextFile` implementations.

### UI

Read-only status panel shown above the hostname and network edit forms; auto-fetched on page load. Shows:
- Current hostname (with an "edit" link to the change form)
- Per interface: mode badge (DHCP/Static), IP/mask, gateway, DNS servers

New locale keys:
```
device_info_heading, device_info_hostname_label, device_info_interface_label,
device_info_mode_dhcp, device_info_mode_static, device_info_mode_unknown,
device_info_address_label, device_info_gateway_label, device_info_dns_label,
device_info_loading, device_info_unavailable
```

---

## §3 Scheduled Reboot (Feature G)

### Problem

Chromium accumulates memory over days of continuous operation. A configurable nightly reboot at low-traffic hours (default 03:00) keeps the kiosk fresh. The `auto-reboot.timer` found on production devices was not project-managed and ran every 6 hours, disrupting business hours. This feature replaces that approach with a dashboard-configurable timer.

### Systemd Units

The project creates and manages two units:

**`/etc/systemd/system/aundekiosk-reboot.timer`** (generated by privileged script):
```ini
[Unit]
Description=AundeKiosk scheduled daily reboot

[Timer]
OnCalendar=*-*-* HH:MM:00
Persistent=true

[Install]
WantedBy=timers.target
```

**`/etc/systemd/system/aundekiosk-reboot.service`** (static template):
```ini
[Unit]
Description=AundeKiosk scheduled reboot

[Service]
Type=oneshot
ExecStart=/sbin/reboot
```

Source templates: `services/aundekiosk-reboot.timer.template`, `services/aundekiosk-reboot.service.template`.

### Privileged Script

`privileged/manage-reboot-timer.sh` reads JSON from stdin:
- `{ "action": "enable", "time": "03:00" }` → writes timer file (substituting `HH:MM`), writes service file, runs `systemctl daemon-reload && systemctl enable --now aundekiosk-reboot.timer`
- `{ "action": "disable" }` → runs `systemctl disable --now aundekiosk-reboot.timer`, removes both unit files, `daemon-reload`
- `{ "action": "status" }` → prints JSON `{ "enabled": true/false, "time": "HH:MM" | null }` by reading the timer file

Exit codes: 0 = success, 1 = invalid input.

Time validation: `HH:MM` pattern, 00–23 hours, 00–59 minutes.

### API

New file: `dashboard/reboot_schedule_api.ts`

```typescript
export interface RebootScheduleApiOptions {
  stepUpGuard: ReturnType<typeof createStepUpGuard>;
  auditLog: ReturnType<typeof createAuditLog>;
  runPrivilegedManage: (payload: { action: string; time?: string }) => Promise<string>;
}
```

Routes in `server.ts`:
- `GET /reboot-schedule` → any session; calls `runPrivilegedManage({ action: "status" })`, returns `{ enabled, time }`
- `POST /reboot-schedule` → admin + step-up; body `{ time: "HH:MM", confirmPassword }`; enables/updates timer
- `DELETE /reboot-schedule` → admin + step-up; body `{ confirmPassword }`; disables timer

Audit events: `reboot_schedule_enabled`, `reboot_schedule_disabled`.

`scripts/setup/update.sh` restarts the timer after an update if it is currently enabled (reads status, re-enables with same time).

### UI

New dashboard section "Planlı Yeniden Başlatma":
- Toggle: enabled / disabled
- Time input (HH:MM), shown only when enabled
- "Kaydet" button
- Status line shows next scheduled reboot: "Bir sonraki yeniden başlatma: 03:00"

New locale keys:
```
reboot_schedule_heading, reboot_schedule_enabled_label, reboot_schedule_time_label,
reboot_schedule_save_button, reboot_schedule_disable_button,
reboot_schedule_next_hint, reboot_schedule_disabled_hint
```

Audit log event strings:
```
audit_event_reboot_schedule_enabled, audit_event_reboot_schedule_disabled
```

---

## §4 Crash Recovery (Feature H)

### Problem

If a bad URL is saved to `config.json` (a crash-on-load site, an unreachable address), the runner enters a crash loop. Currently, fixing it requires SSH access. Most crashes in a kiosk are caused by config changes, not software bugs — reverting the last-known-good config is the right recovery.

### Config Backup

`config_api.ts` writes `config.json.backup` atomically after every successful `POST /config` save. Write pattern: write to `config.json.backup.tmp`, then `Deno.rename` → same atomicity guarantee as `config.json` itself. Same directory, same permissions.

Backup location: `/opt/aundekiosk/config.json.backup` (next to `config.json`).

### Service Recovery Trigger

Modify `services/aundekiosk-runner.service.template`:
```ini
[Unit]
OnFailure=aundekiosk-recovery.service

[Service]
StartLimitIntervalSec=300
StartLimitBurst=5
```

When the runner fails 5 times within 5 minutes, systemd invokes `aundekiosk-recovery.service`.

### Recovery Service

New file: `services/aundekiosk-recovery.service.template`
```ini
[Unit]
Description=AundeKiosk config rollback on crash
After=network.target

[Service]
Type=oneshot
ExecStart=/opt/aundekiosk/privileged/recover-config.sh
```

### Privileged Script

`privileged/recover-config.sh`:
1. Check `/opt/aundekiosk/config.json.backup` exists; exit 1 with log if not
2. Copy backup → `config.json` (atomic rename pattern)
3. Append a JSON audit log line to `/opt/aundekiosk/audit.log`:
   `{ "event": "crash_recovery", "ts": <epoch_ms>, "ok": true }`
4. `systemctl reset-failed aundekiosk-runner`
5. `systemctl start aundekiosk-runner`

Exit 0 on success, 1 on failure (no backup to restore).

### Backup Status Endpoint

`GET /config` already returns the URL list. Add a separate lightweight endpoint:

`GET /config-backup-info` → any session; response:
```typescript
interface ConfigBackupInfo {
  hasBackup: boolean;
  backupAgeSeconds: number | null;  // null when no backup exists
}
```

Implemented in `config_api.ts` alongside `handleGet`/`handlePost`. Uses `Deno.stat(backupPath)` to read mtime. No privilege needed.

### UI

Small status line below the URL list apply button:
- When backup exists: "Son yedek: X dakika önce alındı"
- When no backup: nothing shown (first-time use)

New locale keys:
```
config_backup_age_hint
```

---

## §5 Security

- Role is enforced server-side on every request; the client never controls it
- Legacy users (no `role` field) default to `"admin"` — no existing deployment loses access
- A viewer calling an admin-only route gets HTTP 403 (not 401)
- Reboot schedule changes and recovery are step-up gated (admin password re-entry)
- Recovery script logs to audit.log: admins see every rollback
- Backup file uses same permissions as `config.json` (0600, `pi` user)
- `manage-reboot-timer.sh` validates `HH:MM` format before writing any unit file

---

## §6 Files Created / Modified

### Feature E – User Roles
| Action | File |
|--------|------|
| Modify | `dashboard/auth/credential_store.ts` — add role field, backward-compat read |
| Modify | `dashboard/auth/session_store.ts` — role in SessionRecord |
| Modify | `dashboard/auth/auth_api.ts` — store role at login |
| Modify | `dashboard/auth/users_api.ts` — accept and return role |
| Modify | `dashboard/server.ts` — `requireAdmin()` helper, viewer-only routes |
| Modify | `dashboard/public/locales/tr.json`, `en.json`, `de.json` |
| Modify | `dashboard/auth/credential_store_test.ts` |
| Modify | `dashboard/auth/users_api_test.ts` |
| Modify | `dashboard/server_test.ts` |

### Feature F – Device Status
| Action | File |
|--------|------|
| Create | `dashboard/device_info_api.ts` |
| Create | `dashboard/device_info_api_test.ts` |
| Modify | `dashboard/server.ts` — new GET /device-info route |
| Modify | `dashboard/public/locales/tr.json`, `en.json`, `de.json` |

### Feature G – Scheduled Reboot
| Action | File |
|--------|------|
| Create | `privileged/manage-reboot-timer.sh` |
| Create | `tests/privileged/manage_reboot_timer_test.sh` |
| Create | `dashboard/reboot_schedule_api.ts` |
| Create | `dashboard/reboot_schedule_api_test.ts` |
| Create | `services/aundekiosk-reboot.timer.template` |
| Create | `services/aundekiosk-reboot.service.template` |
| Modify | `dashboard/server.ts` — three new reboot-schedule routes |
| Modify | `scripts/setup/update.sh` — re-enable timer on update |
| Modify | `dashboard/public/locales/tr.json`, `en.json`, `de.json` |

### Feature H – Crash Recovery
| Action | File |
|--------|------|
| Modify | `dashboard/config_api.ts` — write backup on save |
| Modify | `dashboard/config_api_test.ts` |
| Create | `privileged/recover-config.sh` |
| Create | `tests/privileged/recover_config_test.sh` |
| Create | `services/aundekiosk-recovery.service.template` |
| Modify | `services/aundekiosk-runner.service.template` — StartLimitBurst + OnFailure |
| Modify | `dashboard/server.ts` — GET /config-backup-info route |
| Modify | `dashboard/public/locales/tr.json`, `en.json`, `de.json` |

---

## §7 Out of Scope

- Email/push notifications on crash recovery (no SMTP infrastructure in this project)
- Multiple backup snapshots / full config history
- Viewer access to monitor config or audit log (read-only — still admin only for now)
- IPv6 support in device info
