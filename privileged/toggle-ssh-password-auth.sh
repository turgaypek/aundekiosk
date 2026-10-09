#!/usr/bin/env bash
# Privileged helper: toggles SSH password authentication on or off via a
# drop-in file (never edits the main sshd_config directly, so this can't
# corrupt an unrelated setting). "Şifre ile girişi kapat, sadece SSH key"
# per spec §8.1.
set -euo pipefail

ACTION="${1:?Usage: toggle-ssh-password-auth.sh enable|disable}"

if [[ "$ACTION" != "enable" && "$ACTION" != "disable" ]]; then
  echo "Invalid action '$ACTION'. Use 'enable' or 'disable'." >&2
  exit 1
fi

DROPIN_FILE="${AUNDEKIOSK_SSHD_DROPIN_FILE:-/etc/ssh/sshd_config.d/aundekiosk-password-auth.conf}"

if [[ "$ACTION" == "enable" ]]; then
  echo "PasswordAuthentication yes" > "$DROPIN_FILE"
else
  echo "PasswordAuthentication no" > "$DROPIN_FILE"
fi

systemctl reload ssh 2>/dev/null || systemctl restart ssh
