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
  echo "SNMP disabled."
  exit 0
fi

USERNAME=$(echo "$PAYLOAD" | jq -r '.username')
AUTH_PROTOCOL=$(echo "$PAYLOAD" | jq -r '.authProtocol')
AUTH_PASSPHRASE=$(echo "$PAYLOAD" | jq -r '.authPassphrase')
PRIV_PROTOCOL=$(echo "$PAYLOAD" | jq -r '.privProtocol')
PRIV_PASSPHRASE=$(echo "$PAYLOAD" | jq -r '.privPassphrase')
ALLOWED_SOURCE=$(echo "$PAYLOAD" | jq -r '.allowedSource')

is_valid_snmp_username "$USERNAME" || { echo "Invalid SNMP username." >&2; exit 1; }
is_valid_snmp_auth_protocol "$AUTH_PROTOCOL" || { echo "Invalid auth protocol (use SHA or SHA-256)." >&2; exit 1; }
is_valid_snmp_priv_protocol "$PRIV_PROTOCOL" || { echo "Invalid priv protocol (use AES)." >&2; exit 1; }
[[ "${#AUTH_PASSPHRASE}" -ge 8 ]] || { echo "Auth passphrase must be at least 8 characters." >&2; exit 1; }
[[ "${#PRIV_PASSPHRASE}" -ge 8 ]] || { echo "Priv passphrase must be at least 8 characters." >&2; exit 1; }
if ! is_valid_cidr "$ALLOWED_SOURCE" && ! is_valid_ipv4 "$ALLOWED_SOURCE"; then
  echo "Invalid allowedSource (must be an IPv4 address or CIDR)." >&2
  exit 1
fi

cat > "$SNMPD_USER_CONF" <<EOF_USER
createUser ${USERNAME} ${AUTH_PROTOCOL} '${AUTH_PASSPHRASE}' ${PRIV_PROTOCOL} '${PRIV_PASSPHRASE}'
EOF_USER
chmod 600 "$SNMPD_USER_CONF"

# SNMPv3 only: rouser + agentAddress, no com2sec/rocommunity line anywhere
# — those are the v1/v2c community-string directives spec §8.3 forbids.
cat > "$SNMPD_CONF" <<EOF_CONF
rouser ${USERNAME} priv
agentAddress udp:161
EOF_CONF

# SNMPv3's access model has no "restrict this user to this subnet"
# directive the way v1/v2c community strings do — the standard answer is
# a firewall rule. Replace any prior AundeKiosk-managed rule before adding
# the new one, so repeated configuration doesn't accumulate stale rules.
iptables -D INPUT -p udp --dport 161 -s "$ALLOWED_SOURCE" -j ACCEPT 2>/dev/null || true
iptables -D INPUT -p udp --dport 161 -j DROP 2>/dev/null || true
iptables -I INPUT -p udp --dport 161 -s "$ALLOWED_SOURCE" -j ACCEPT
iptables -A INPUT -p udp --dport 161 -j DROP

systemctl enable --now snmpd
systemctl restart snmpd
echo "SNMPv3 configured for user '${USERNAME}', restricted to ${ALLOWED_SOURCE}."
