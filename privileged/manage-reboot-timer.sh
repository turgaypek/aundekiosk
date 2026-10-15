#!/usr/bin/env bash
# Privileged helper: enables or disables a systemd timer for a daily scheduled reboot.
# Input arrives over stdin as JSON: { "action": "enable", "time": "HH:MM" } or
# { "action": "disable" }. Timer and service unit paths can be overridden via
# environment variables for testing without root.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

TIMER_FILE="${AUNDEKIOSK_TEST_TIMER_FILE:-/etc/systemd/system/aundekiosk-reboot.timer}"
SERVICE_FILE="${AUNDEKIOSK_TEST_SERVICE_FILE:-/etc/systemd/system/aundekiosk-reboot.service}"

INPUT=$(cat)
action=$(printf '%s' "$INPUT" | jq -r '.action // empty' 2>/dev/null || true)
time_val=$(printf '%s' "$INPUT" | jq -r '.time // empty' 2>/dev/null || true)

is_valid_hhmm() {
  [[ "$1" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]
}

case "$action" in
  enable)
    if ! is_valid_hhmm "${time_val:-}"; then
      echo "Invalid time '${time_val:-}'. Expected HH:MM (00:00-23:59)." >&2
      exit 1
    fi
    HH="${time_val%%:*}"
    MM="${time_val##*:}"

    cat > "$TIMER_FILE" <<TIMER_EOF
[Unit]
Description=AundeKiosk scheduled daily reboot

[Timer]
OnCalendar=*-*-* ${HH}:${MM}:00
Persistent=true

[Install]
WantedBy=timers.target
TIMER_EOF

    cat > "$SERVICE_FILE" <<'SERVICE_EOF'
[Unit]
Description=AundeKiosk scheduled reboot

[Service]
Type=oneshot
ExecStart=/sbin/reboot
SERVICE_EOF

    systemctl daemon-reload
    systemctl enable --now aundekiosk-reboot.timer
    ;;

  disable)
    systemctl disable --now aundekiosk-reboot.timer 2>/dev/null || true
    rm -f "$TIMER_FILE" "$SERVICE_FILE"
    systemctl daemon-reload
    ;;

  *)
    echo "Unknown action '${action:-}'. Use 'enable' or 'disable'." >&2
    exit 1
    ;;
esac
