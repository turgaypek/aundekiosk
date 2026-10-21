#!/usr/bin/env bash
# Triggered by POST /api/update in the dashboard.
# Runs update.sh as a detached systemd transient unit so restarting
# the dashboard service mid-update does not kill the update process.
set -euo pipefail

# Clear any previous failed run so systemd-run can reuse the unit name.
systemctl reset-failed aundekiosk-update 2>/dev/null || true

exec systemd-run \
  --no-block \
  --collect \
  --unit=aundekiosk-update \
  --description="AundeKiosk application update" \
  bash /opt/aundekiosk/scripts/setup/update.sh
