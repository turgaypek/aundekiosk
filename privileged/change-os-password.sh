#!/usr/bin/env bash
# Privileged helper: changes the OS account password for the ONE username
# recorded at install time (AUNDEKIOSK_PI_USER_FILE). The payload carries
# NO username field at all — this helper always targets the recorded
# user, so there is nothing for a compromised dashboard (or a malicious
# request) to spoof by naming a different account (final review: Critical
# C2). The new password arrives over stdin as JSON, never as a
# command-line argument (argv is visible to any local user via `ps`;
# stdin is not).
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments; the new password is read from stdin as JSON." >&2
  exit 1
fi

ALLOWED_USER_FILE="${AUNDEKIOSK_PI_USER_FILE:-/opt/aundekiosk/pi-user.txt}"

if [[ ! -f "$ALLOWED_USER_FILE" ]]; then
  echo "No target user recorded at $ALLOWED_USER_FILE; cannot change a password." >&2
  exit 1
fi

ALLOWED_USER=$(cat "$ALLOWED_USER_FILE")

PAYLOAD=$(cat)
NEW_PASSWORD=$(echo "$PAYLOAD" | jq -r '.newPassword')

if [[ "${#NEW_PASSWORD}" -lt 12 ]]; then
  echo "New password must be at least 12 characters." >&2
  exit 1
fi

# A newline in the password would be read by chpasswd as a SECOND
# "user:password" line — letting a long-enough-but-crafted value set an
# arbitrary (e.g. root's) password (final review: Critical C1).
is_safe_secret_value "$NEW_PASSWORD" || { echo "New password must not contain a newline." >&2; exit 1; }

echo "${ALLOWED_USER}:${NEW_PASSWORD}" | chpasswd
echo "Password changed for ${ALLOWED_USER}."
