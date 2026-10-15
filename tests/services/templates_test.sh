#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

SERVICES_DIR="$SCRIPT_DIR/../../services"

# Pi 4/5 on Raspberry Pi OS Bookworm defaults to Wayland (labwc). If the
# runner/switcher units never set WAYLAND_DISPLAY, detect_display_server
# (platform/lib.sh) always falls back to "x11", so the switcher always
# picks xdotool in production even on the primary, fully-supported target.
for unit in aundekiosk-runner.service.template aundekiosk-switcher.service.template; do
  grep -q "^Environment=WAYLAND_DISPLAY=" "$SERVICES_DIR/$unit"
  assert_status 0 $? "$unit sets WAYLAND_DISPLAY so Wayland is detected on Pi 4/5"
done

# The dashboard unit must start the Deno binary where install.sh actually
# puts it (DENO_INSTALL=/usr/local -> /usr/local/bin/deno), not a path
# nothing ever creates.
grep -q "^ExecStart=/usr/local/bin/deno " "$SERVICES_DIR/aundekiosk-dashboard.service.template"
assert_status 0 $? "aundekiosk-dashboard.service.template starts the Deno binary from the path install.sh actually installs it to"

# The 'aundekiosk' service user has no $HOME (--no-create-home), so Deno's
# default cache dir can't be created; DENO_DIR must point inside the
# install tree instead, which install.sh's blanket chown already covers.
grep -q "^Environment=DENO_DIR=/opt/aundekiosk/.deno$" "$SERVICES_DIR/aundekiosk-dashboard.service.template"
assert_status 0 $? "aundekiosk-dashboard.service.template sets DENO_DIR to a path the service user actually owns"

# --cached-only means the service can never silently reach the npm
# registry at runtime; the one dependency it needs is pre-cached and
# integrity-checked by install.sh during setup, while there's still
# network access and an operator watching.
DASHBOARD_UNIT_CONTENT=$(cat "$SERVICES_DIR/aundekiosk-dashboard.service.template")
case "$DASHBOARD_UNIT_CONTENT" in
  *"--cached-only"*) assert_eq "has-cached-only" "has-cached-only" "aundekiosk-dashboard.service.template runs with --cached-only (never fetches at runtime)" ;;
  *) assert_eq "has-cached-only" "missing" "aundekiosk-dashboard.service.template runs with --cached-only (never fetches at runtime)" ;;
esac


# Both services write to the same shared audit.log (dashboard.service.ts /
# monitor/lib.sh's append_monitor_audit_event). Whichever one creates the
# file first matters: Deno's writeTextFile can request mode 0o600 itself,
# but plain bash `>>` cannot, so it gets whatever the process umask allows
# (0644 by default) — a world-readable log of login attempts, usernames
# and source IPs. UMask=0077 closes that regardless of which side wins the
# race to create the file first.
for unit in aundekiosk-dashboard.service.template aundekiosk-monitor.service.template; do
  grep -q "^UMask=0077$" "$SERVICES_DIR/$unit"
  assert_status 0 $? "$unit sets UMask=0077 so audit.log can never end up world-readable"
done

# The monitor unit must run as the unprivileged 'aundekiosk' user (same
# sudoers-whitelist trust boundary as the dashboard), never as root.
grep -q "^User=aundekiosk$" "$SERVICES_DIR/aundekiosk-monitor.service.template"
assert_status 0 $? "aundekiosk-monitor.service.template runs as the unprivileged aundekiosk user"

# Final review (Critical C4a): every SSH/network/SNMP endpoint shells out
# to "sudo <privileged helper>". Without --allow-run=sudo, Deno's
# permission model refuses to spawn it at all (NotCapable), so all five
# Plan 4 endpoints would fail in production even though their mocked unit
# tests pass.
case "$DASHBOARD_UNIT_CONTENT" in
  *"--allow-run=sudo"*) assert_eq "has-allow-run" "has-allow-run" "aundekiosk-dashboard.service.template grants --allow-run=sudo so privileged helpers can actually be invoked" ;;
  *) assert_eq "has-allow-run" "missing" "aundekiosk-dashboard.service.template grants --allow-run=sudo so privileged helpers can actually be invoked" ;;
esac

# service_control_api.ts's status reads run `systemctl is-active <unit>`
# directly; device_info_api.ts runs `hostname` and `ip addr` unprivileged.
# All need their own --allow-run entries or Deno refuses to spawn them.
DASHBOARD_ALLOW_RUN=$(grep -o "allow-run=[^ ]*" "$SERVICES_DIR/aundekiosk-dashboard.service.template" | cut -d= -f2)

for cmd in sudo systemctl hostname ip; do
  case ",$DASHBOARD_ALLOW_RUN," in
    *",$cmd,"*)
      assert_eq "granted" "granted" "aundekiosk-dashboard.service.template --allow-run includes $cmd"
      ;;
    *)
      assert_eq "granted" "missing" "aundekiosk-dashboard.service.template --allow-run includes $cmd"
      ;;
  esac
done

# Discovered by actually running the dashboard service for real (never
# exercised before — every prior test used `deno test`'s own, much
# broader --allow-env, not the unit's restricted allowlist):
# server.ts reads AUNDEKIOSK_ALLOW_HTTP via Deno.env.get() but the unit
# never granted it, so the service crash-looped with
# "NotCapable: Requires env access to 'AUNDEKIOSK_ALLOW_HTTP'" on every
# single start. Rather than pin one missing variable, extract every
# Deno.env.get("...") call in server.ts and require each one appears in
# the unit's --allow-env list — this catches the NEXT omission too, not
# just this one.
DASHBOARD_SERVER_TS="$SCRIPT_DIR/../../dashboard/server.ts"
ALLOW_ENV_LIST=$(grep -o "allow-env=[^ ]*" "$SERVICES_DIR/aundekiosk-dashboard.service.template" | cut -d= -f2)
for env_var in $(grep -oE 'Deno\.env\.get\("[A-Z_]+"\)' "$DASHBOARD_SERVER_TS" | grep -oE '"[A-Z_]+"' | tr -d '"' | sort -u); do
  case ",$ALLOW_ENV_LIST," in
    *",$env_var,"*)
      assert_eq "granted" "granted" "aundekiosk-dashboard.service.template's --allow-env includes $env_var, which server.ts actually reads"
      ;;
    *)
      assert_eq "granted" "missing" "aundekiosk-dashboard.service.template's --allow-env includes $env_var, which server.ts actually reads"
      ;;
  esac
done

# Runner must declare OnFailure for crash recovery to trigger
grep -q "^OnFailure=aundekiosk-recovery.service$" "$SERVICES_DIR/aundekiosk-runner.service.template"
assert_status 0 $? "aundekiosk-runner.service.template declares OnFailure=aundekiosk-recovery.service"

# Runner must have StartLimitBurst so systemd knows when to fire OnFailure
grep -q "^StartLimitBurst=" "$SERVICES_DIR/aundekiosk-runner.service.template"
assert_status 0 $? "aundekiosk-runner.service.template sets StartLimitBurst"

# Recovery service must exist in the repo
[ -f "$SERVICES_DIR/aundekiosk-recovery.service.template" ]
assert_status 0 $? "aundekiosk-recovery.service.template exists in services/"

# Recovery service must run recover-config.sh
grep -q "^ExecStart=/opt/aundekiosk/privileged/recover-config.sh$" "$SERVICES_DIR/aundekiosk-recovery.service.template"
assert_status 0 $? "aundekiosk-recovery.service.template runs recover-config.sh"

assert_summary
