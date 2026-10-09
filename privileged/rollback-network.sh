#!/usr/bin/env bash
# Privileged helper: restores the network settings apply-network-config.sh
# backed up before its last change. This is what the scheduled
# systemd-run timer calls if the change is never confirmed in time
# (spec §8.2). Argument-free — it only ever reads its own backup file.
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

BACKUP_FILE="${AUNDEKIOSK_NETWORK_BACKUP_FILE:-/etc/aundekiosk-priv/network-backup.json}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "No network backup found; nothing to roll back." >&2
  exit 0
fi

PAYLOAD=$(cat "$BACKUP_FILE")
INTERFACE=$(echo "$PAYLOAD" | jq -r '.interface')
CONNECTION_ID=$(echo "$PAYLOAD" | jq -r '.connectionId // .interface')
MODE=$(echo "$PAYLOAD" | jq -r '.mode')
STATIC_IP=$(echo "$PAYLOAD" | jq -r '.staticIp')
GATEWAY=$(echo "$PAYLOAD" | jq -r '.gateway')
DNS=$(echo "$PAYLOAD" | jq -r '.dns')
WIFI_SSID=$(echo "$PAYLOAD" | jq -r '.wifiSsid // ""')
WIFI_PASSWORD=$(echo "$PAYLOAD" | jq -r '.wifiPassword // ""')

# Re-validate before trusting, even though the backup directory is
# root-owned (final review: Critical C2's directory move is the primary
# defense) — this is defense in depth against any future bug in how the
# backup was written, at negligible cost.
is_valid_interface "$INTERFACE" || { echo "Backup names an invalid interface '$INTERFACE'; refusing to roll back." >&2; exit 1; }

if [[ "$MODE" == "auto" || "$MODE" == "dhcp" || -z "$STATIC_IP" ]]; then
  nmcli connection modify "$CONNECTION_ID" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
else
  nmcli connection modify "$CONNECTION_ID" ipv4.method manual ipv4.addresses "$STATIC_IP" ipv4.gateway "$GATEWAY" ipv4.dns "$DNS"
fi

# Restore the previous WiFi SSID/password too (final review: Important
# I2 — a bad new SSID/PSK needs to be rolled back, not just the IPv4
# fields), over nmcli's own stdin, never as a command-line argument.
if [[ "$INTERFACE" == "wlan0" && -n "$WIFI_SSID" ]]; then
  nmcli connection edit "$CONNECTION_ID" <<NMCLI_EDIT
set wifi-sec.key-mgmt wpa-psk
set wifi-sec.psk $WIFI_PASSWORD
set 802-11-wireless.ssid $WIFI_SSID
save
quit
NMCLI_EDIT
fi

nmcli connection up "$CONNECTION_ID"

rm -f "$BACKUP_FILE"
echo "Network configuration rolled back to the previous settings on $INTERFACE ($CONNECTION_ID)."
