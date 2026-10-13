#!/usr/bin/env bash
# Privileged helper: runs "apt-get update && apt-get upgrade" as a
# detached systemd transient unit, so the dashboard's HTTP request only
# ever has to kick it off — the upgrade itself survives a dashboard
# restart, a closed browser tab, or an SSH disconnect (same "kernel-level,
# not in-process" reasoning as apply-network-config.sh's rollback timer).
#
# "start" is the only subcommand the sudoers whitelist grants to the
# dashboard user; it re-invokes this same script as "run" via
# systemd-run, which executes AS ROOT (because "start" itself already
# is root, courtesy of sudo) — "run" is never sudo-whitelisted directly,
# and is never meant to be invoked except by "start"'s own systemd-run
# call.
set -euo pipefail

SCRIPT_PATH=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)/$(basename -- "${BASH_SOURCE[0]}")

UNIT="aundekiosk-apt-upgrade"
LOG_FILE="${AUNDEKIOSK_APT_UPGRADE_LOG_FILE:-/opt/aundekiosk/apt-upgrade.log}"
AUDIT_LOG_FILE="${AUNDEKIOSK_AUDIT_LOG_FILE:-/opt/aundekiosk/audit.log}"
REBOOT_REQUIRED_FILE="${AUNDEKIOSK_REBOOT_REQUIRED_FILE:-/var/run/reboot-required}"

ACTION="${1:?Usage: apt-upgrade.sh start|run}"

# Mirrors monitor/lib.sh's append_monitor_audit_event: a plain `jq -nc`
# object appended to the shared audit log. A JSON line this short stays
# well under PIPE_BUF, so concurrent appends from the dashboard (Deno),
# the resource monitor, and this script never interleave into a broken
# line.
append_audit_event() {
  local event="$1" ok="$2" reboot_required="$3"
  local timestamp
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  jq -nc \
    --arg timestamp "$timestamp" \
    --arg event "$event" \
    --argjson ok "$ok" \
    --argjson rebootRequired "$reboot_required" \
    '{timestamp: $timestamp, event: $event, ok: $ok, rebootRequired: $rebootRequired}' \
    >> "$AUDIT_LOG_FILE"
}

case "$ACTION" in
  start)
    if [[ "$#" -ne 1 ]]; then
      echo "Usage: apt-upgrade.sh start" >&2
      exit 1
    fi

    # Exit code 2 (not a bare failure) lets apt_upgrade_api.ts tell
    # "already running" apart from a real error, same convention as
    # confirm-network-config.sh's code 2 for "nothing was pending".
    if systemctl is-active --quiet "${UNIT}.service" 2>/dev/null; then
      echo "An apt update/upgrade is already running." >&2
      exit 2
    fi

    # Fresh log for this run; mode 0644 so the unprivileged dashboard
    # user can read it back for GET /apt-upgrade/status even though
    # root (via systemd-run below) owns the file.
    : > "$LOG_FILE"
    chmod 644 "$LOG_FILE"

    # Clear a FAILED state left over from a previous run so this run
    # starts clean — systemd refuses to reuse a unit name still in the
    # "failed" state.
    systemctl reset-failed "${UNIT}.service" 2>/dev/null || true

    systemd-run --unit="$UNIT" "$SCRIPT_PATH" run
    echo "apt update/upgrade started."
    ;;

  run)
    if [[ "$#" -ne 1 ]]; then
      echo "Usage: apt-upgrade.sh run" >&2
      exit 1
    fi

    exec >> "$LOG_FILE" 2>&1
    echo "=== apt update/upgrade started: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    append_audit_event "apt_upgrade_started" true false

    set +e
    echo "=== running apt-get update ==="
    apt-get update
    update_code=$?
    upgrade_code=0
    if [[ "$update_code" -eq 0 ]]; then
      echo "=== running apt-get upgrade ==="
      DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::="--force-confold" upgrade
      upgrade_code=$?
    fi
    set -e

    reboot_required=false
    [[ -f "$REBOOT_REQUIRED_FILE" ]] && reboot_required=true

    if [[ "$update_code" -eq 0 && "$upgrade_code" -eq 0 ]]; then
      echo "=== apt update/upgrade finished successfully: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
      append_audit_event "apt_upgrade_finished" true "$reboot_required"
      exit 0
    fi

    echo "=== apt update/upgrade FAILED (update exit $update_code, upgrade exit $upgrade_code): $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    append_audit_event "apt_upgrade_finished" false "$reboot_required"
    exit 1
    ;;

  *)
    echo "Invalid action '$ACTION'. Use 'start' or 'run'." >&2
    exit 1
    ;;
esac
