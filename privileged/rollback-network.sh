#!/usr/bin/env bash
# Privileged helper: restores the network settings apply-network-config.sh
# backed up before its last change. This is what the scheduled
# systemd-run timer calls if the change is never confirmed in time
# (spec §8.2). Argument-free — it only ever reads its own backup file.
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

BACKUP_FILE="${AUNDEKIOSK_NETWORK_BACKUP_FILE:-/opt/aundekiosk/network-backup.json}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "No network backup found; nothing to roll back." >&2
  exit 0
fi

PAYLOAD=$(cat "$BACKUP_FILE")
INTERFACE=$(echo "$PAYLOAD" | jq -r '.interface')
MODE=$(echo "$PAYLOAD" | jq -r '.mode')
STATIC_IP=$(echo "$PAYLOAD" | jq -r '.staticIp')
GATEWAY=$(echo "$PAYLOAD" | jq -r '.gateway')
DNS=$(echo "$PAYLOAD" | jq -r '.dns')

if [[ "$MODE" == "auto" || "$MODE" == "dhcp" || -z "$STATIC_IP" ]]; then
  nmcli connection modify "$INTERFACE" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
else
  nmcli connection modify "$INTERFACE" ipv4.method manual ipv4.addresses "$STATIC_IP" ipv4.gateway "$GATEWAY" ipv4.dns "$DNS"
fi
nmcli connection up "$INTERFACE"

rm -f "$BACKUP_FILE"
echo "Network configuration rolled back to the previous settings on $INTERFACE."
