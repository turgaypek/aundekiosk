#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/apply-network-config.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/nmcli" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_NMCLI_LOG"
# Fake enough output for the backup step's `nmcli -g ... connection show` reads.
if [[ "$1" == "-g" ]]; then echo ""; fi
EOF
chmod +x "$FAKE_BIN/nmcli"

cat > "$FAKE_BIN/systemd-run" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMD_RUN_LOG"
EOF
chmod +x "$FAKE_BIN/systemd-run"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_NMCLI_LOG="$WORKDIR/nmcli.log"
export AUNDEKIOSK_TEST_SYSTEMD_RUN_LOG="$WORKDIR/systemd-run.log"
export AUNDEKIOSK_NETWORK_BACKUP_FILE="$WORKDIR/network-backup.json"

echo '{"interface":"eth0","mode":"static","staticIp":"192.168.1.50/24","gateway":"192.168.1.1","dns":"8.8.8.8","wifiSsid":null,"wifiPassword":null}' \
  | bash "$HELPER"
assert_status 0 $? "apply-network-config.sh exits 0 for a valid static eth0 config"
grep -q "192.168.1.50/24" "$WORKDIR/nmcli.log"
assert_status 0 $? "apply-network-config.sh passes the validated static IP to nmcli"
[[ -f "$WORKDIR/network-backup.json" ]]
assert_status 0 $? "apply-network-config.sh writes a backup file before applying the new config"
grep -q "aundekiosk-network-rollback" "$WORKDIR/systemd-run.log"
assert_status 0 $? "apply-network-config.sh schedules the rollback timer"

rm -f "$WORKDIR/nmcli.log" "$WORKDIR/network-backup.json"
echo '{"interface":"eth0","mode":"static","staticIp":"not-an-ip","gateway":"192.168.1.1","dns":"8.8.8.8","wifiSsid":null,"wifiPassword":null}' \
  | bash "$HELPER" > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects an invalid static IP"
[[ ! -f "$WORKDIR/nmcli.log" ]]
assert_status 0 $? "apply-network-config.sh never calls nmcli when validation fails"

echo '{"interface":"wlan0","mode":"dhcp","staticIp":null,"gateway":null,"dns":null,"wifiSsid":"MyNet","wifiPassword":"short"}' \
  | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects a WiFi password shorter than 8 characters"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects any command-line argument (data comes from stdin only)"

rm -rf "$WORKDIR"
assert_summary
