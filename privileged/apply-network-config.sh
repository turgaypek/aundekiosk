#!/usr/bin/env bash
# Privileged helper: applies a new network configuration via NetworkManager
# (nmcli — Bookworm's default, never dhcpcd.conf), after backing up the
# CURRENT settings and scheduling an automatic rollback (spec §8.2). The
# config arrives over stdin as JSON, never as command-line arguments —
# the WiFi password especially must never appear in `ps` output.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments; configuration is read from stdin as JSON." >&2
  exit 1
fi

BACKUP_FILE="${AUNDEKIOSK_NETWORK_BACKUP_FILE:-/opt/aundekiosk/network-backup.json}"
ROLLBACK_UNIT="aundekiosk-network-rollback"
ROLLBACK_SCRIPT="${AUNDEKIOSK_ROLLBACK_SCRIPT:-/opt/aundekiosk/privileged/rollback-network.sh}"
ROLLBACK_DELAY_SECONDS="${AUNDEKIOSK_ROLLBACK_DELAY_SECONDS:-60}"

PAYLOAD=$(cat)
INTERFACE=$(echo "$PAYLOAD" | jq -r '.interface')
MODE=$(echo "$PAYLOAD" | jq -r '.mode')
STATIC_IP=$(echo "$PAYLOAD" | jq -r '.staticIp // ""')
GATEWAY=$(echo "$PAYLOAD" | jq -r '.gateway // ""')
DNS=$(echo "$PAYLOAD" | jq -r '.dns // ""')
WIFI_SSID=$(echo "$PAYLOAD" | jq -r '.wifiSsid // ""')
WIFI_PASSWORD=$(echo "$PAYLOAD" | jq -r '.wifiPassword // ""')

is_valid_interface "$INTERFACE" || { echo "Invalid interface '$INTERFACE'." >&2; exit 1; }
is_valid_network_mode "$MODE" || { echo "Invalid mode '$MODE'." >&2; exit 1; }

if [[ "$MODE" == "static" ]]; then
  is_valid_cidr "$STATIC_IP" || { echo "Invalid static IP/CIDR '$STATIC_IP'." >&2; exit 1; }
  is_valid_ipv4 "$GATEWAY" || { echo "Invalid gateway '$GATEWAY'." >&2; exit 1; }
  is_valid_ipv4 "$DNS" || { echo "Invalid DNS '$DNS'." >&2; exit 1; }
fi

if [[ "$INTERFACE" == "wlan0" ]]; then
  is_valid_wifi_ssid "$WIFI_SSID" || { echo "Invalid WiFi SSID." >&2; exit 1; }
  is_valid_wifi_password "$WIFI_PASSWORD" || { echo "Invalid WiFi password (must be 8-63 characters)." >&2; exit 1; }
fi

# Back up the CURRENT settings before changing anything — this is what
# rollback-network.sh restores if the new config is never confirmed.
CURRENT_MODE=$(nmcli -g ipv4.method connection show "$INTERFACE" 2>/dev/null || echo "auto")
CURRENT_IP=$(nmcli -g ipv4.addresses connection show "$INTERFACE" 2>/dev/null || echo "")
CURRENT_GATEWAY=$(nmcli -g ipv4.gateway connection show "$INTERFACE" 2>/dev/null || echo "")
CURRENT_DNS=$(nmcli -g ipv4.dns connection show "$INTERFACE" 2>/dev/null || echo "")

jq -n \
  --arg interface "$INTERFACE" \
  --arg mode "$CURRENT_MODE" \
  --arg staticIp "$CURRENT_IP" \
  --arg gateway "$CURRENT_GATEWAY" \
  --arg dns "$CURRENT_DNS" \
  '{interface: $interface, mode: $mode, staticIp: $staticIp, gateway: $gateway, dns: $dns}' \
  > "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"

# Apply the new settings as an nmcli argument array — never a shell-
# interpolated string — so none of these validated-but-still-dashboard-
# supplied values can be read as an extra nmcli flag.
if [[ "$MODE" == "dhcp" ]]; then
  nmcli connection modify "$INTERFACE" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
else
  nmcli connection modify "$INTERFACE" ipv4.method manual ipv4.addresses "$STATIC_IP" ipv4.gateway "$GATEWAY" ipv4.dns "$DNS"
fi

if [[ "$INTERFACE" == "wlan0" ]]; then
  nmcli connection modify "$INTERFACE" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$WIFI_PASSWORD" 802-11-wireless.ssid "$WIFI_SSID"
fi

nmcli connection up "$INTERFACE"

# Kernel-level timer (not an in-process JS timeout) so the rollback still
# fires even if the dashboard process crashes or restarts in the meantime.
systemd-run --unit="$ROLLBACK_UNIT" --on-active="${ROLLBACK_DELAY_SECONDS}s" "$ROLLBACK_SCRIPT"

echo "Network configuration applied to $INTERFACE. Automatic rollback scheduled in ${ROLLBACK_DELAY_SECONDS}s unless confirmed."
