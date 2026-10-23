#!/usr/bin/env bash
# Privileged helper: configures net-snmp for SNMPv3-only access (spec
# §8.3 — v1/v2c community strings are never written). Credentials arrive
# over stdin as JSON, never as command-line arguments.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments; configuration is read from stdin as JSON." >&2
  exit 1
fi

SNMPD_CONF="${AUNDEKIOSK_SNMPD_CONF:-/etc/snmp/snmpd.conf}"
# net-snmp expects createUser directives in its persistent state directory,
# not the main config file — it rewrites this file at runtime, replacing
# the plaintext passphrase with a derived key after first use.
SNMPD_USER_CONF="${AUNDEKIOSK_SNMPD_USER_CONF:-/var/lib/snmp/snmpd.conf}"

PAYLOAD=$(cat)
ENABLED=$(echo "$PAYLOAD" | jq -r '.enabled')

if [[ "$ENABLED" == "false" ]]; then
  systemctl disable --now snmpd
  # Flush the SNMP chain so the port-161 restriction doesn't linger after
  # snmpd is gone, then persist so the flushed state survives reboot.
  iptables -F AUNDEKIOSK-SNMP 2>/dev/null || true
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
  printf '{"enabled":false}\n' > /opt/aundekiosk/state/snmp-status.json
  chmod 0644 /opt/aundekiosk/state/snmp-status.json
  echo "SNMP disabled."
  exit 0
fi

USERNAME=$(echo "$PAYLOAD" | jq -r '.username')
AUTH_PROTOCOL=$(echo "$PAYLOAD" | jq -r '.authProtocol')
AUTH_PASSPHRASE=$(echo "$PAYLOAD" | jq -r '.authPassphrase')
PRIV_PROTOCOL=$(echo "$PAYLOAD" | jq -r '.privProtocol')
PRIV_PASSPHRASE=$(echo "$PAYLOAD" | jq -r '.privPassphrase')
# Support both allowedSources (array) and legacy allowedSource (string).
readarray -t ALLOWED_SOURCES < <(echo "$PAYLOAD" | jq -r '
  if .allowedSources and (.allowedSources | length) > 0
  then .allowedSources[]
  else .allowedSource
  end')

is_valid_snmp_username "$USERNAME" || { echo "Invalid SNMP username." >&2; exit 1; }
is_valid_snmp_auth_protocol "$AUTH_PROTOCOL" || { echo "Invalid auth protocol (use SHA or SHA-256)." >&2; exit 1; }
is_valid_snmp_priv_protocol "$PRIV_PROTOCOL" || { echo "Invalid priv protocol (use AES)." >&2; exit 1; }
[[ "${#AUTH_PASSPHRASE}" -ge 8 ]] || { echo "Auth passphrase must be at least 8 characters." >&2; exit 1; }
[[ "${#PRIV_PASSPHRASE}" -ge 8 ]] || { echo "Priv passphrase must be at least 8 characters." >&2; exit 1; }
# A newline here would be written verbatim into net-snmp's config files
# and read as a SECOND, attacker-chosen directive — demonstrated to
# re-enable v1/v2c (rocommunity) and gain command execution via "extend"
# (final review: Critical C3).
is_safe_secret_value "$AUTH_PASSPHRASE" || { echo "Auth passphrase must not contain a newline." >&2; exit 1; }
is_safe_secret_value "$PRIV_PASSPHRASE" || { echo "Priv passphrase must not contain a newline." >&2; exit 1; }
[[ "${#ALLOWED_SOURCES[@]}" -gt 0 ]] || { echo "allowedSource or allowedSources is required." >&2; exit 1; }
for _SRC in "${ALLOWED_SOURCES[@]}"; do
  if ! is_valid_cidr "$_SRC" && ! is_valid_ipv4 "$_SRC"; then
    echo "Invalid allowedSource '$_SRC' (must be an IPv4 address or CIDR)." >&2
    exit 1
  fi
done

# Stop snmpd BEFORE writing the config files below. net-snmp rewrites
# its own persistent user-config file on normal shutdown — writing while
# an old instance is still running and merely restarting afterward would
# let that shutdown clobber what was just written with stale, in-memory
# state, so a reconfiguration could silently fail (final review:
# Important I5).
systemctl stop snmpd 2>/dev/null || true

cat > "$SNMPD_USER_CONF" <<EOF_USER
createUser ${USERNAME} ${AUTH_PROTOCOL} '${AUTH_PASSPHRASE}' ${PRIV_PROTOCOL} '${PRIV_PASSPHRASE}'
EOF_USER
chmod 600 "$SNMPD_USER_CONF"

# SNMPv3 only: rouser + agentAddress, no com2sec/rocommunity line anywhere
# — those are the v1/v2c community-string directives spec §8.3 forbids.
# disk / enables dskTable OIDs (1.3.6.1.4.1.2021.9.*) for disk metrics.
# extend throttled exposes vcgencmd get_throttled via NET-SNMP-EXTEND-MIB.
cat > /usr/local/bin/pi-throttled <<'EOF_SCRIPT'
#!/bin/sh
out=$(vcgencmd get_throttled 2>/dev/null)
if [ $? -eq 0 ] && echo "$out" | grep -q "throttled="; then
    echo "$out" | cut -d= -f2
else
    echo "0x0"
fi
EOF_SCRIPT
chmod 0755 /usr/local/bin/pi-throttled

# snmpd (Debian-snmp user) needs video group to run vcgencmd
usermod -aG video Debian-snmp 2>/dev/null || true

cat > "$SNMPD_CONF" <<EOF_CONF
rouser ${USERNAME} priv
agentAddress udp:161
disk /
diskio mmcblk0
extend throttled /usr/local/bin/pi-throttled
EOF_CONF

# SNMPv3's access model has no "restrict this user to this subnet"
# directive the way v1/v2c community strings do — the standard answer is
# a firewall rule. Use a DEDICATED chain, flushed and rebuilt on every
# call, rather than deleting one specific "old" rule: deleting only
# protects against the exact source last configured, so reconfiguring
# to a genuinely different source left the previous source's ACCEPT
# rule in place indefinitely (final review: Important I4). Flushing the
# whole chain every time is correct regardless of history.
iptables -N AUNDEKIOSK-SNMP 2>/dev/null || true
iptables -F AUNDEKIOSK-SNMP
iptables -C INPUT -p udp --dport 161 -j AUNDEKIOSK-SNMP 2>/dev/null || iptables -I INPUT -p udp --dport 161 -j AUNDEKIOSK-SNMP
for _SRC in "${ALLOWED_SOURCES[@]}"; do
  iptables -A AUNDEKIOSK-SNMP -s "$_SRC" -j ACCEPT
done
iptables -A AUNDEKIOSK-SNMP -j DROP

# Persist so the source-IP restriction survives reboot.
# Without this, snmpd would start on boot with no iptables chain in place
# and be reachable from any host (until the dashboard reconfigures it).
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4

systemctl enable snmpd
systemctl start snmpd

# Write non-secret config for the dashboard's GET /snmp-config endpoint.
# All values are pre-validated by lib.sh so no JSON-special chars can appear.
SOURCES_JSON=$(printf '%s\n' "${ALLOWED_SOURCES[@]}" | jq -R . | jq -s .)
printf '{"enabled":true,"username":"%s","authProtocol":"%s","privProtocol":"%s","allowedSource":"%s","allowedSources":%s}\n' \
  "$USERNAME" "$AUTH_PROTOCOL" "$PRIV_PROTOCOL" "${ALLOWED_SOURCES[0]}" "$SOURCES_JSON" \
  > /opt/aundekiosk/state/snmp-status.json
chmod 0644 /opt/aundekiosk/state/snmp-status.json

echo "SNMPv3 configured for user '${USERNAME}', restricted to ${ALLOWED_SOURCES[*]}."
