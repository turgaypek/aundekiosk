#!/usr/bin/env bash
# Privileged helper: enables or disables the SSH service. Takes exactly
# one argument — "enable" or "disable" — and the sudoers whitelist grants
# NOPASSWD on each exact invocation separately, so sudo itself (not just
# this script) rejects anything else.
set -euo pipefail

ACTION="${1:?Usage: toggle-ssh.sh enable|disable}"

if [[ "$ACTION" != "enable" && "$ACTION" != "disable" ]]; then
  echo "Invalid action '$ACTION'. Use 'enable' or 'disable'." >&2
  exit 1
fi

if [[ "$ACTION" == "enable" ]]; then
  exec systemctl enable --now ssh
else
  exec systemctl disable --now ssh
fi
