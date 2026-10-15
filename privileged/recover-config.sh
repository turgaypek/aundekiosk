#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${AUNDEKIOSK_TEST_CONFIG_PATH:-/opt/aundekiosk/config.json}"
BACKUP_PATH="${CONFIG_PATH}.backup"
AUDIT_LOG="${AUNDEKIOSK_TEST_AUDIT_LOG:-/opt/aundekiosk/audit.log}"

if [ ! -f "$BACKUP_PATH" ]; then
  echo "No backup found at $BACKUP_PATH; cannot recover." >&2
  exit 1
fi

TMP_PATH="${CONFIG_PATH}.tmp-recovery-$$"
cp "$BACKUP_PATH" "$TMP_PATH"
chmod 0644 "$TMP_PATH" 2>/dev/null || true
mv "$TMP_PATH" "$CONFIG_PATH"

TS=$(date +%s%3N 2>/dev/null || echo "0")
printf '{"event":"crash_recovery","ts":%s,"ok":true}\n' "$TS" >> "$AUDIT_LOG"

systemctl reset-failed aundekiosk-runner 2>/dev/null || true
systemctl start aundekiosk-runner
