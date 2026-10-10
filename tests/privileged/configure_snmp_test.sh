#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/configure-snmp.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMCTL_LOG"
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

cat > "$FAKE_BIN/iptables" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_IPTABLES_LOG"
# -C (check) must fail by default so the script's "-C || -I" fallback
# exercises the -I branch exactly once per run, matching real iptables
# behavior for a rule that isn't there yet.
[[ "$1" == "-C" ]] && exit 1
exit 0
EOF
chmod +x "$FAKE_BIN/iptables"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_LOG="$WORKDIR/systemctl.log"
export AUNDEKIOSK_TEST_IPTABLES_LOG="$WORKDIR/iptables.log"
export AUNDEKIOSK_SNMPD_CONF="$WORKDIR/snmpd.conf"
export AUNDEKIOSK_SNMPD_USER_CONF="$WORKDIR/snmpd-user.conf"

VALID_PAYLOAD='{"enabled":true,"username":"monitor_user","authProtocol":"SHA-256","authPassphrase":"a-long-enough-auth-pass","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"192.168.1.0/24"}'

echo "$VALID_PAYLOAD" | bash "$HELPER"
assert_status 0 $? "configure-snmp.sh exits 0 for a valid SNMPv3-only payload"
grep -q "createUser monitor_user SHA-256" "$WORKDIR/snmpd-user.conf"
assert_status 0 $? "configure-snmp.sh writes a createUser line with the chosen protocols"
grep -q "^rouser monitor_user priv$" "$WORKDIR/snmpd.conf"
assert_status 0 $? "configure-snmp.sh grants read-only access to the SNMPv3 user only"
grep -qE "(rocommunity|com2sec)" "$WORKDIR/snmpd.conf"
if [[ $? -eq 0 ]]; then
  assert_eq "no-v1v2c" "has-v1v2c" "configure-snmp.sh never writes a v1/v2c community-string directive"
else
  assert_eq "no-v1v2c" "no-v1v2c" "configure-snmp.sh never writes a v1/v2c community-string directive"
fi
grep -q "192.168.1.0/24" "$WORKDIR/iptables.log"
assert_status 0 $? "configure-snmp.sh restricts UDP 161 to the allowed source via a firewall rule"

# Final review (Important I5): snmpd must be stopped BEFORE the config
# files are (re)written and started AFTER — net-snmp rewrites its own
# persistent user-config file on normal shutdown, so writing while an
# old instance is still running and merely restarting afterward would
# let it clobber what was just written with its own stale state.
STOP_LINE=$(grep -n "^stop snmpd$" "$WORKDIR/systemctl.log" | head -1 | cut -d: -f1)
START_LINE=$(grep -n "^start snmpd$" "$WORKDIR/systemctl.log" | head -1 | cut -d: -f1)
if [[ -n "$STOP_LINE" && -n "$START_LINE" && "$STOP_LINE" -lt "$START_LINE" ]]; then
  assert_eq "stop-before-start" "stop-before-start" "configure-snmp.sh stops snmpd before writing config and starts it afterward"
else
  assert_eq "stop-before-start" "wrong order or missing (stop=$STOP_LINE, start=$START_LINE)" "configure-snmp.sh stops snmpd before writing config and starts it afterward"
fi

# Final review (Important I4): reconfiguring to a NEW allowed source must
# never leave the OLD source's ACCEPT rule in place. Using a dedicated,
# flushed-and-rebuilt chain (rather than deleting one specific old rule)
# guarantees this regardless of history — verified here by confirming
# the chain is flushed (-F) on every single run, and the fresh log only
# ever shows the CURRENT run's source.
rm -f "$WORKDIR/iptables.log"
SECOND_SOURCE_PAYLOAD='{"enabled":true,"username":"monitor_user","authProtocol":"SHA-256","authPassphrase":"a-long-enough-auth-pass","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"10.0.0.0/8"}'
echo "$SECOND_SOURCE_PAYLOAD" | bash "$HELPER"
assert_status 0 $? "configure-snmp.sh exits 0 when reconfiguring with a different allowed source"
grep -qE "^-F AUNDEKIOSK-SNMP$|^-F +AUNDEKIOSK-SNMP$" "$WORKDIR/iptables.log"
assert_status 0 $? "configure-snmp.sh flushes its dedicated chain every time, so a prior source's rule can never survive a reconfiguration"
grep -q "192.168.1.0/24" "$WORKDIR/iptables.log"
if [[ $? -eq 0 ]]; then
  assert_eq "no-stale-source" "stale source still referenced" "configure-snmp.sh's second run never re-adds the first run's now-stale source"
else
  assert_eq "no-stale-source" "no-stale-source" "configure-snmp.sh's second run never re-adds the first run's now-stale source"
fi
grep -q "10.0.0.0/8" "$WORKDIR/iptables.log"
assert_status 0 $? "configure-snmp.sh's second run accepts the new source"

rm -f "$WORKDIR/snmpd.conf" "$WORKDIR/snmpd-user.conf"
BAD_PROTOCOL='{"enabled":true,"username":"monitor_user","authProtocol":"MD5","authPassphrase":"a-long-enough-auth-pass","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"192.168.1.0/24"}'
echo "$BAD_PROTOCOL" | bash "$HELPER" > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects an auth protocol outside SHA/SHA-256 (e.g. MD5)"
[[ ! -f "$WORKDIR/snmpd.conf" ]]
assert_status 0 $? "configure-snmp.sh never writes snmpd.conf when validation fails"

SHORT_PASSPHRASE='{"enabled":true,"username":"monitor_user","authProtocol":"SHA","authPassphrase":"short","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"192.168.1.0/24"}'
echo "$SHORT_PASSPHRASE" | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects an auth passphrase shorter than 8 characters"

# Final review (Critical C3): a newline in either passphrase would be
# written verbatim into net-snmp's config files and read as a SECOND,
# attacker-chosen directive — the reviewer demonstrated this re-enabling
# v1/v2c (rocommunity) and gaining command execution via "extend".
rm -f "$WORKDIR/snmpd.conf" "$WORKDIR/snmpd-user.conf"
NEWLINE_AUTH_PAYLOAD=$(printf '%s' '{"enabled":true,"username":"monitor_user","authProtocol":"SHA-256","authPassphrase":"x\nrocommunity public default\nextend pwn /bin/sh -c id","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"192.168.1.0/24"}')
echo "$NEWLINE_AUTH_PAYLOAD" | bash "$HELPER" > "$WORKDIR/reject4.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects an authPassphrase containing a newline"
[[ ! -f "$WORKDIR/snmpd-user.conf" ]]
assert_status 0 $? "configure-snmp.sh never writes snmpd-user.conf when authPassphrase contains a newline"

NEWLINE_PRIV_PAYLOAD=$(printf '%s' '{"enabled":true,"username":"monitor_user","authProtocol":"SHA-256","authPassphrase":"a-long-enough-auth-pass","privProtocol":"AES","privPassphrase":"x\nrocommunity public default","allowedSource":"192.168.1.0/24"}')
echo "$NEWLINE_PRIV_PAYLOAD" | bash "$HELPER" > "$WORKDIR/reject5.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects a privPassphrase containing a newline"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects any command-line argument (data comes from stdin only)"

# Review Focus #4 (plan's own checklist): a v1/v2c-shaped payload — a
# bare community string, no SNMPv3 fields at all — must be rejected,
# never silently accepted as "enabled" with missing fields treated as
# defaults.
rm -f "$WORKDIR/snmpd.conf" "$WORKDIR/snmpd-user.conf"
V1V2C_PAYLOAD='{"enabled":true,"community":"public"}'
echo "$V1V2C_PAYLOAD" | bash "$HELPER" > "$WORKDIR/reject6.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects a v1/v2c-shaped payload (bare community string, no SNMPv3 fields)"
[[ ! -f "$WORKDIR/snmpd.conf" ]]
assert_status 0 $? "configure-snmp.sh never writes snmpd.conf for a v1/v2c-shaped payload"

rm -f "$WORKDIR/systemctl.log"
echo '{"enabled":false}' | bash "$HELPER"
assert_status 0 $? "configure-snmp.sh disabled:true path exits 0"
grep -q "disable --now snmpd" "$WORKDIR/systemctl.log"
assert_status 0 $? "configure-snmp.sh stops and disables snmpd when enabled:false"

rm -rf "$WORKDIR"
assert_summary
