#!/usr/bin/env bash
# Privileged helper: restarts the AundeKiosk runtime services.
# Takes NO arguments by design — this script does exactly one fixed thing,
# which is what makes it safe to grant passwordless sudo on without having
# to validate any input.
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

exec systemctl restart aundekiosk-runner.service aundekiosk-switcher.service
