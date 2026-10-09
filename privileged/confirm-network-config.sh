#!/usr/bin/env bash
# Privileged helper: cancels the pending automatic network rollback
# (spec §8.2's "onayla" action). Argument-free.
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

ROLLBACK_UNIT="aundekiosk-network-rollback"

# Distinguish "a rollback really was pending and is now cancelled" from
# "nothing was pending" (already rolled back, or never scheduled) —
# "systemctl stop ... || true" used to report success either way, so a
# user confirming AFTER the timer had already fired would see
# "confirmed" even though the device had already reverted (final
# review: Important I8). Exit code 2 lets the API tell the difference
# and answer "already rolled back" instead of a false "confirmed".
if ! systemctl is-active --quiet "${ROLLBACK_UNIT}.timer" 2>/dev/null; then
  echo "No pending network rollback (it may have already run)." >&2
  exit 2
fi

systemctl stop "${ROLLBACK_UNIT}.timer"
echo "Pending network rollback cancelled; configuration confirmed."
