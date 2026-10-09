#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/configure-snmp.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

for cmd in systemctl iptables; do
  cat > "$FAKE_BIN/$cmd" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "\$AUNDEKIOSK_TEST_${cmd^^}_LOG"
EOF
  chmod +x "$FAKE_BIN/$cmd"
done

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

rm -f "$WORKDIR/snmpd.conf" "$WORKDIR/snmpd-user.conf"
BAD_PROTOCOL='{"enabled":true,"username":"monitor_user","authProtocol":"MD5","authPassphrase":"a-long-enough-auth-pass","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"192.168.1.0/24"}'
echo "$BAD_PROTOCOL" | bash "$HELPER" > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects an auth protocol outside SHA/SHA-256 (e.g. MD5)"
[[ ! -f "$WORKDIR/snmpd.conf" ]]
assert_status 0 $? "configure-snmp.sh never writes snmpd.conf when validation fails"

SHORT_PASSPHRASE='{"enabled":true,"username":"monitor_user","authProtocol":"SHA","authPassphrase":"short","privProtocol":"AES","privPassphrase":"a-long-enough-priv-pass","allowedSource":"192.168.1.0/24"}'
echo "$SHORT_PASSPHRASE" | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects an auth passphrase shorter than 8 characters"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "configure-snmp.sh rejects any command-line argument (data comes from stdin only)"

rm -f "$WORKDIR/systemctl.log"
echo '{"enabled":false}' | bash "$HELPER"
assert_status 0 $? "configure-snmp.sh disabled:true path exits 0"
grep -q "disable --now snmpd" "$WORKDIR/systemctl.log"
assert_status 0 $? "configure-snmp.sh stops and disables snmpd when enabled:false"

rm -rf "$WORKDIR"
assert_summary
