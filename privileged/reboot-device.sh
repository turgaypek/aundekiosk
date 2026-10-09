#!/usr/bin/env bash
# Privileged helper: reboots the device. Takes NO arguments by design —
# same fixed-action pattern as restart-kiosk-services.sh (Plan 1), which
# is what makes it safe to grant passwordless sudo on without validating
# any input.
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

exec systemctl reboot
