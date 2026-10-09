#!/usr/bin/env bash
# Privileged helper: cancels the pending automatic network rollback
# (spec §8.2's "onayla" action). Argument-free.
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

ROLLBACK_UNIT="aundekiosk-network-rollback"

systemctl stop "${ROLLBACK_UNIT}.timer" 2>/dev/null || true
echo "Pending network rollback cancelled (if any); configuration confirmed."
