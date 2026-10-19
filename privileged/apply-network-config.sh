#!/usr/bin/env bash
# Privileged helper: applies a new network configuration via NetworkManager
# (nmcli — Bookworm's default, never dhcpcd.conf), after backing up the
# CURRENT settings and scheduling an automatic rollback (spec §8.2). The
# config arrives over stdin as JSON, never as command-line arguments —
# the WiFi password especially must never appear in `ps` output.
set -euo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments; configuration is read from stdin as JSON." >&2
  exit 1
fi

BACKUP_FILE="${AUNDEKIOSK_NETWORK_BACKUP_FILE:-/etc/aundekiosk-priv/network-backup.json}"
ROLLBACK_UNIT="aundekiosk-network-rollback"
ROLLBACK_SCRIPT="${AUNDEKIOSK_ROLLBACK_SCRIPT:-/opt/aundekiosk/privileged/rollback-network.sh}"
ROLLBACK_DELAY_SECONDS="${AUNDEKIOSK_ROLLBACK_DELAY_SECONDS:-60}"

# Refuse a second apply while an earlier one's rollback is still
# pending: letting it through would overwrite the backup with these
# (still-unconfirmed) settings, so the pending timer would roll back to
# the WRONG state, and scheduling a second timer under the same unit
# name would conflict with the first (final review: Critical C5).
if systemctl is-active --quiet "${ROLLBACK_UNIT}.timer" 2>/dev/null; then
  echo "A network config change is still pending confirmation. Confirm it or wait for it to roll back before applying another change." >&2
  exit 1
fi

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
  is_safe_secret_value "$WIFI_SSID" || { echo "WiFi SSID must not contain a newline." >&2; exit 1; }
  is_valid_wifi_password "$WIFI_PASSWORD" || { echo "Invalid WiFi password (must be 8-63 characters)." >&2; exit 1; }
  is_safe_secret_value "$WIFI_PASSWORD" || { echo "WiFi password must not contain a newline." >&2; exit 1; }
fi

# Resolve the actual NetworkManager connection profile for this
# interface. On stock Bookworm this is often NOT the interface name
# itself (e.g. "Wired connection 1"); fall back to the interface name
# only when nmcli reports nothing usable, which is a defined fallback,
# not a silently-swallowed error.
CONNECTION_ID=$(nmcli -g GENERAL.CONNECTION device show "$INTERFACE" 2>/dev/null || echo "")
if [[ -z "$CONNECTION_ID" || "$CONNECTION_ID" == "--" ]]; then
  CONNECTION_ID="$INTERFACE"
fi

# Back up the CURRENT settings before changing anything. A read failure
# here aborts the whole operation rather than recording a default
# ("auto", empty addresses) — a backup that doesn't reflect the real
# previous settings is worse than none, because rollback-network.sh
# would "restore" the wrong thing with total confidence (final review:
# Important I3).
read_current() {
  local field="$1"
  nmcli -g "$field" connection show "$CONNECTION_ID" 2>&1
}
if ! CURRENT_MODE=$(read_current ipv4.method); then
  echo "Could not read the current ipv4.method for '$CONNECTION_ID'; aborting without changing anything: $CURRENT_MODE" >&2
  exit 1
fi
if ! CURRENT_IP=$(read_current ipv4.addresses); then
  echo "Could not read the current ipv4.addresses for '$CONNECTION_ID'; aborting without changing anything: $CURRENT_IP" >&2
  exit 1
fi
if ! CURRENT_GATEWAY=$(read_current ipv4.gateway); then
  echo "Could not read the current ipv4.gateway for '$CONNECTION_ID'; aborting without changing anything: $CURRENT_GATEWAY" >&2
  exit 1
fi
if ! CURRENT_DNS=$(read_current ipv4.dns); then
  echo "Could not read the current ipv4.dns for '$CONNECTION_ID'; aborting without changing anything: $CURRENT_DNS" >&2
  exit 1
fi
CURRENT_WIFI_SSID=""
CURRENT_WIFI_PASSWORD=""
if [[ "$INTERFACE" == "wlan0" ]]; then
  CURRENT_WIFI_SSID=$(nmcli -g 802-11-wireless.ssid connection show "$CONNECTION_ID" 2>/dev/null || echo "")
  CURRENT_WIFI_PASSWORD=$(nmcli -s -g 802-11-wireless-security.psk connection show "$CONNECTION_ID" 2>/dev/null || echo "")
fi

# The backup now also captures the WiFi SSID/password (for wlan0), so a
# bad new SSID/PSK can actually be rolled back too, not just the IPv4
# fields (final review: Important I2). Written atomically (temp file +
# rename within the same root-owned, mode-0700 directory) rather than
# redirected straight into the final path.
TMP_BACKUP_FILE="${BACKUP_FILE}.tmp.$$"
jq -n \
  --arg interface "$INTERFACE" \
  --arg connectionId "$CONNECTION_ID" \
  --arg mode "$CURRENT_MODE" \
  --arg staticIp "$CURRENT_IP" \
  --arg gateway "$CURRENT_GATEWAY" \
  --arg dns "$CURRENT_DNS" \
  --arg wifiSsid "$CURRENT_WIFI_SSID" \
  --arg wifiPassword "$CURRENT_WIFI_PASSWORD" \
  '{interface: $interface, connectionId: $connectionId, mode: $mode, staticIp: $staticIp, gateway: $gateway, dns: $dns, wifiSsid: $wifiSsid, wifiPassword: $wifiPassword}' \
  > "$TMP_BACKUP_FILE"
mv -f "$TMP_BACKUP_FILE" "$BACKUP_FILE"

# Clear any failed unit left over from an earlier apply before
# scheduling, so stale state can never block this one.
systemctl reset-failed "${ROLLBACK_UNIT}.service" "${ROLLBACK_UNIT}.timer" 2>/dev/null || true

# Kernel-level timer (not an in-process JS timeout) so the rollback still
# fires even if the dashboard process crashes or restarts in the
# meantime. Scheduled BEFORE any risky nmcli call below — under `set -e`,
# a failure partway through applying the new settings (a bad gateway, a
# wrong WiFi password, an unplugged cable) must still leave a rollback
# scheduled, or the device could be left in a half-changed state with no
# safety net at all (final review: Critical C5).
systemd-run --unit="$ROLLBACK_UNIT" --on-active="${ROLLBACK_DELAY_SECONDS}s" "$ROLLBACK_SCRIPT"

# Apply the new settings as an nmcli argument array — never a shell-
# interpolated string — so none of these validated-but-still-dashboard-
# supplied values can be read as an extra nmcli flag.
if [[ "$MODE" == "dhcp" ]]; then
  nmcli connection modify "$CONNECTION_ID" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
else
  nmcli connection modify "$CONNECTION_ID" ipv4.method manual ipv4.addresses "$STATIC_IP" ipv4.gateway "$GATEWAY" ipv4.dns "$DNS"
fi

if [[ "$INTERFACE" == "wlan0" ]]; then
  # The WiFi PSK is fed to nmcli over its own STDIN via "connection
  # edit", never as a command-line argument — argv is readable by any
  # local user via /proc/<pid>/cmdline while nmcli is running, the same
  # reason every other secret in this project travels over stdin instead
  # (final review: Important I1).
  nmcli connection edit "$CONNECTION_ID" <<NMCLI_EDIT
set wifi-sec.key-mgmt wpa-psk
set wifi-sec.psk $WIFI_PASSWORD
set 802-11-wireless.ssid $WIFI_SSID
save
quit
NMCLI_EDIT
fi

nmcli connection up "$CONNECTION_ID"

echo "Network configuration applied to $INTERFACE ($CONNECTION_ID). Automatic rollback scheduled in ${ROLLBACK_DELAY_SECONDS}s unless confirmed."
