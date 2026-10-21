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
# A newline here would be written verbatim into net-snmp's config files
# and read as a SECOND, attacker-chosen directive — demonstrated to
# re-enable v1/v2c (rocommunity) and gain command execution via "extend"
# (final review: Critical C3).
is_safe_secret_value "$AUTH_PASSPHRASE" || { echo "Auth passphrase must not contain a newline." >&2; exit 1; }
is_safe_secret_value "$PRIV_PASSPHRASE" || { echo "Priv passphrase must not contain a newline." >&2; exit 1; }
if ! is_valid_cidr "$ALLOWED_SOURCE" && ! is_valid_ipv4 "$ALLOWED_SOURCE"; then
  echo "Invalid allowedSource (must be an IPv4 address or CIDR)." >&2
  exit 1
fi

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
cat > "$SNMPD_CONF" <<EOF_CONF
rouser ${USERNAME} priv
agentAddress udp:161
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
iptables -A AUNDEKIOSK-SNMP -s "$ALLOWED_SOURCE" -j ACCEPT
iptables -A AUNDEKIOSK-SNMP -j DROP

# Persist so the source-IP restriction survives reboot.
# Without this, snmpd would start on boot with no iptables chain in place
# and be reachable from any host (until the dashboard reconfigures it).
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4

systemctl enable snmpd
systemctl start snmpd
echo "SNMPv3 configured for user '${USERNAME}', restricted to ${ALLOWED_SOURCE}."
