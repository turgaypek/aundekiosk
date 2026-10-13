#!/usr/bin/env bash
# Privileged helper: changes this device's hostname via raspi-config.
# The new hostname arrives over stdin as JSON, like every other
# variable-data privileged helper (change-os-password.sh,
# apply-network-config.sh) — never as a command-line argument, so the
# sudoers whitelist can grant this exact, argument-free script without
# a password instead of needing a wildcard entry for arbitrary hostnames.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments; the new hostname is read from stdin as JSON." >&2
  exit 1
fi

PAYLOAD=$(cat)
NEW_HOSTNAME=$(echo "$PAYLOAD" | jq -r '.hostname')

is_valid_hostname "$NEW_HOSTNAME" || {
  echo "Invalid hostname '$NEW_HOSTNAME'. Use 1-63 letters, digits, or hyphens, never starting or ending with a hyphen." >&2
  exit 1
}

raspi-config nonint do_hostname "$NEW_HOSTNAME"
echo "Hostname changed to ${NEW_HOSTNAME}. A reboot is required for every service to pick it up."
