#!/usr/bin/env bash
# Privileged helper: starts or stops exactly one of AundeKiosk's own
# systemd units (dashboard, monitor, kiosk runner, kiosk switcher) — an
# admin control for taking the kiosk display or a background service
# down for maintenance without needing SSH access. Takes exactly two
# arguments — the service name and "start"/"stop" — and the sudoers
# whitelist grants NOPASSWD on each exact (service, action) combination
# separately, so sudo itself (not just this script) rejects anything else.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

SERVICE="${1:?Usage: toggle-service.sh <service> start|stop}"
ACTION="${2:?Usage: toggle-service.sh <service> start|stop}"

is_valid_aundekiosk_service "$SERVICE" || { echo "Invalid service '$SERVICE'." >&2; exit 1; }

if [[ "$ACTION" != "start" && "$ACTION" != "stop" ]]; then
  echo "Invalid action '$ACTION'. Use 'start' or 'stop'." >&2
  exit 1
fi

exec systemctl "$ACTION" "$SERVICE"
