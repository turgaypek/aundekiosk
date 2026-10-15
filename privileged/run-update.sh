#!/usr/bin/env bash
# Triggered by POST /api/update in the dashboard.
# Runs update.sh as a detached systemd transient unit so restarting
# the dashboard service mid-update does not kill the update process.
set -euo pipefail
exec systemd-run \
  --no-block \
  --unit=aundekiosk-update \
  --description="AundeKiosk application update" \
  bash /opt/aundekiosk/scripts/setup/update.sh
