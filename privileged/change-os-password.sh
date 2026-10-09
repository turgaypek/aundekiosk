#!/usr/bin/env bash
# Privileged helper: changes the OS account password for the ONE username
# recorded at install time (AUNDEKIOSK_PI_USER_FILE) — never an arbitrary
# username, even if asked to. The new password arrives over stdin as JSON,
# never as a command-line argument (argv is visible to any local user via
# `ps`; stdin is not).
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments; the username/password are read from stdin as JSON." >&2
  exit 1
fi

ALLOWED_USER_FILE="${AUNDEKIOSK_PI_USER_FILE:-/opt/aundekiosk/pi-user.txt}"

if [[ ! -f "$ALLOWED_USER_FILE" ]]; then
  echo "No target user recorded at $ALLOWED_USER_FILE; cannot change a password." >&2
  exit 1
fi

ALLOWED_USER=$(cat "$ALLOWED_USER_FILE")

PAYLOAD=$(cat)
USERNAME=$(echo "$PAYLOAD" | jq -r '.username')
NEW_PASSWORD=$(echo "$PAYLOAD" | jq -r '.newPassword')

if [[ "$USERNAME" != "$ALLOWED_USER" ]]; then
  echo "This helper can only change the password for '$ALLOWED_USER', not '$USERNAME'." >&2
  exit 1
fi

if [[ "${#NEW_PASSWORD}" -lt 12 ]]; then
  echo "New password must be at least 12 characters." >&2
  exit 1
fi

echo "${USERNAME}:${NEW_PASSWORD}" | chpasswd
echo "Password changed for ${USERNAME}."
