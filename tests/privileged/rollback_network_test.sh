#!/usr/bin/env bash
set -uo pipefail

# Final review (Important I9): rollback-network.sh had no test coverage
# at all before this — the exact script a failed/unconfirmed network
# change depends on to recover the device was untested.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/rollback-network.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/nmcli" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_NMCLI_LOG"
if [[ "$1" == "connection" && "$2" == "edit" ]]; then
  cat > "${AUNDEKIOSK_TEST_NMCLI_STDIN_LOG:-/dev/null}"
fi
exit 0
EOF
chmod +x "$FAKE_BIN/nmcli"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_NMCLI_LOG="$WORKDIR/nmcli.log"
export AUNDEKIOSK_TEST_NMCLI_STDIN_LOG="$WORKDIR/nmcli-stdin.log"
export AUNDEKIOSK_NETWORK_BACKUP_FILE="$WORKDIR/network-backup.json"

cat > "$WORKDIR/network-backup.json" <<'EOF'
{"interface":"eth0","connectionId":"Wired connection 1","mode":"manual","staticIp":"10.0.0.5/24","gateway":"10.0.0.1","dns":"1.1.1.1","wifiSsid":"","wifiPassword":""}
EOF

bash "$HELPER"
assert_status 0 $? "rollback-network.sh exits 0 when a backup exists"
grep -q "10.0.0.5/24" "$WORKDIR/nmcli.log"
assert_status 0 $? "rollback-network.sh restores the static IP from the backup"
grep -q "Wired connection 1" "$WORKDIR/nmcli.log"
assert_status 0 $? "rollback-network.sh addresses nmcli by the backed-up connectionId, not just the interface name"
[[ ! -f "$WORKDIR/network-backup.json" ]]
assert_status 0 $? "rollback-network.sh deletes the backup file after a successful rollback"

rm -f "$WORKDIR/nmcli.log"
bash "$HELPER"
assert_status 0 $? "rollback-network.sh exits 0 (not an error) when no backup file exists"
[[ ! -s "$WORKDIR/nmcli.log" ]]
assert_status 0 $? "rollback-network.sh never calls nmcli when there is nothing to roll back"

# Final review (Important I2): restoring wlan0 must also restore the
# previous WiFi SSID/password, over nmcli's stdin — never argv.
rm -f "$WORKDIR/nmcli.log" "$WORKDIR/nmcli-stdin.log"
cat > "$WORKDIR/network-backup.json" <<'EOF'
{"interface":"wlan0","connectionId":"wlan0","mode":"auto","staticIp":"","gateway":"","dns":"","wifiSsid":"PreviousNetwork","wifiPassword":"previous-wifi-password"}
EOF
bash "$HELPER"
assert_status 0 $? "rollback-network.sh exits 0 for a wlan0 backup"
grep -q "previous-wifi-password" "$WORKDIR/nmcli.log"
if [[ $? -eq 0 ]]; then
  assert_eq "psk-off-argv" "psk-on-argv" "rollback-network.sh never passes the restored WiFi password to nmcli as a command-line argument"
else
  assert_eq "psk-off-argv" "psk-off-argv" "rollback-network.sh never passes the restored WiFi password to nmcli as a command-line argument"
fi
grep -q "previous-wifi-password" "$WORKDIR/nmcli-stdin.log"
assert_status 0 $? "rollback-network.sh restores the WiFi password via nmcli's stdin"
grep -q "PreviousNetwork" "$WORKDIR/nmcli-stdin.log"
assert_status 0 $? "rollback-network.sh restores the WiFi SSID"

# A backup naming an invalid interface must never be trusted, even
# though the backup directory is root-owned (final review: Critical C2's
# directory move is the primary defense; this is defense in depth).
rm -f "$WORKDIR/nmcli.log"
cat > "$WORKDIR/network-backup.json" <<'EOF'
{"interface":"eth99","connectionId":"eth99","mode":"auto","staticIp":"","gateway":"","dns":"","wifiSsid":"","wifiPassword":""}
EOF
bash "$HELPER" > "$WORKDIR/reject.txt" 2>&1
assert_status 1 $? "rollback-network.sh refuses a backup naming an invalid interface"
[[ ! -s "$WORKDIR/nmcli.log" ]]
assert_status 0 $? "rollback-network.sh never calls nmcli for a backup with an invalid interface"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "rollback-network.sh rejects any command-line argument"

grep -q "AUNDEKIOSK_NETWORK_BACKUP_FILE:-/etc/aundekiosk-priv/network-backup.json" "$HELPER"
assert_status 0 $? "rollback-network.sh's default backup path is outside the dashboard-owned tree"

rm -rf "$WORKDIR"
assert_summary
