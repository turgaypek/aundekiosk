---
name: aundekiosk-project
description: AundeKiosk project context — architecture, completed plans, deployment notes
metadata:
  type: project
---

AundeKiosk is a from-scratch Raspberry Pi kiosk management system at this repo. GitHub: `https://github.com/turgaypek/aundekiosk.git`, branch `master`. Made PUBLIC 2026-10-14 — confirmed clean of secrets before going public.

**Install/update:**
```
curl -sSL https://raw.githubusercontent.com/turgaypek/aundekiosk/master/scripts/setup/bootstrap.sh | sudo bash -s -- --install
curl -sSL https://raw.githubusercontent.com/turgaypek/aundekiosk/master/scripts/setup/bootstrap.sh | sudo bash -s -- --update
```

## Completed Plans (as of 2026-10-13)
1. Platform & kiosk runtime (Wayland + Chromium, URL rotation via CDP)
2. Auth & session security (Argon2id, session cookies, step-up re-auth)
3. Resource monitor (CPU/RAM threshold tiers, hysteresis, log→restart→reboot)
4. SSH/Network/SNMP module
- A: SSH/VNC/Hostname/Network/SNMP/OS-password admin panel controls
- B: apt update/upgrade from dashboard (systemd-run detached)
- C: Multi-user accounts + audit log viewer
- D: Loopback-only aundekiosk-recover password recovery tool

## Last Changes (2026-10-20)
- Location/region label in dashboard header (inline editable, saved to config.json)
- Device info panel: Pi model, RAM, kernel, disk, CPU temp, hostname, IP/gateway/DNS
- Restart button with confirmation dialog (btn-outline-danger)
- update.sh fixes: $HOME export, git stash -u
- .gitignore: added .deno/, tls/, config.json, monitor-config.json, *.db, audit.log, videos/, state/

## Security Architecture (critical — never deviate)
Privileged-helper model: every privileged action goes through root-owned, sudoers-whitelisted, single-purpose bash scripts under `privileged/`. Dashboard runs as unprivileged `aundekiosk` user. Secrets travel over stdin as JSON, never argv.

## Pi Deployment
Pi devices accessed via SSH (user: pi). Credentials stored locally, NOT in this repo.
Some Pi devices have no internet access — updates via SCP for those.
Pi network addresses tracked locally by the operator.

## Key Design Decisions
- `update.sh` uses `git stash -u` + `git pull --ff-only` + `git stash pop` — runtime files (.deno/, tls/, config.json etc.) must be in .gitignore or they get stashed and lost
- Deno cache at `/opt/aundekiosk/.deno/`, pre-cached by install.sh so service starts with `--cached-only`
- wayvnc config at `/etc/wayvnc/config`, `enable_auth=false` (noVNC requires security type None)
- URL rotation uses CDP not wtype (Chromium kiosk intercepts keyboard shortcuts)
