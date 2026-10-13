#!/usr/bin/env bash
# Privileged helper: enables or disables the VNC service (wayvnc, the
# Wayland-native VNC server Raspberry Pi OS Bookworm ships — already
# installed and listening on 5900 by default). Takes exactly one
# argument — "enable" or "disable" — and the sudoers whitelist grants
# NOPASSWD on each exact invocation separately, so sudo itself (not just
# this script) rejects anything else.
set -euo pipefail

ACTION="${1:?Usage: toggle-vnc.sh enable|disable}"

if [[ "$ACTION" != "enable" && "$ACTION" != "disable" ]]; then
  echo "Invalid action '$ACTION'. Use 'enable' or 'disable'." >&2
  exit 1
fi

if [[ "$ACTION" == "enable" ]]; then
  exec systemctl enable --now wayvnc
else
  exec systemctl disable --now wayvnc
fi
