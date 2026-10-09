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
if [[ -n "${AUNDEKIOSK_TEST_SEQUENCE_LOG:-}" && "$1" == "connection" && "$2" == "up" ]]; then
  echo "nmcli-connection-up" >> "$AUNDEKIOSK_TEST_SEQUENCE_LOG"
fi
if [[ "$1" == "connection" && "$2" == "edit" ]]; then
  cat > "${AUNDEKIOSK_TEST_NMCLI_STDIN_LOG:-/dev/null}"
  exit 0
fi
if [[ "$1" == "-g" ]]; then
  if [[ -n "${AUNDEKIOSK_TEST_NMCLI_FAIL_READS:-}" ]]; then
    echo "simulated read failure" >&2
    exit 1
  fi
  echo ""
fi
exit 0
EOF
chmod +x "$FAKE_BIN/nmcli"

cat > "$FAKE_BIN/systemd-run" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMD_RUN_LOG"
if [[ -n "${AUNDEKIOSK_TEST_SEQUENCE_LOG:-}" ]]; then
  echo "systemd-run" >> "$AUNDEKIOSK_TEST_SEQUENCE_LOG"
fi
exit 0
EOF
chmod +x "$FAKE_BIN/systemd-run"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "is-active" ]]; then
  [[ "${AUNDEKIOSK_TEST_ROLLBACK_PENDING:-}" == "1" ]]
  exit $?
fi
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMCTL_LOG"
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_NMCLI_LOG="$WORKDIR/nmcli.log"
export AUNDEKIOSK_TEST_SYSTEMD_RUN_LOG="$WORKDIR/systemd-run.log"
export AUNDEKIOSK_TEST_SYSTEMCTL_LOG="$WORKDIR/systemctl.log"
export AUNDEKIOSK_TEST_SEQUENCE_LOG="$WORKDIR/sequence.log"
export AUNDEKIOSK_TEST_NMCLI_STDIN_LOG="$WORKDIR/nmcli-stdin.log"
export AUNDEKIOSK_NETWORK_BACKUP_FILE="$WORKDIR/network-backup.json"

STATIC_PAYLOAD='{"interface":"eth0","mode":"static","staticIp":"192.168.1.50/24","gateway":"192.168.1.1","dns":"8.8.8.8","wifiSsid":null,"wifiPassword":null}'

echo "$STATIC_PAYLOAD" | bash "$HELPER"
assert_status 0 $? "apply-network-config.sh exits 0 for a valid static eth0 config"
grep -q "192.168.1.50/24" "$WORKDIR/nmcli.log"
assert_status 0 $? "apply-network-config.sh passes the validated static IP to nmcli"
[[ -f "$WORKDIR/network-backup.json" ]]
assert_status 0 $? "apply-network-config.sh writes a backup file before applying the new config"
grep -q "aundekiosk-network-rollback" "$WORKDIR/systemd-run.log"
assert_status 0 $? "apply-network-config.sh schedules the rollback timer"

# Final review (Critical C5): the rollback timer must be scheduled
# BEFORE the risky nmcli calls run, not after -- otherwise a failure in
# "connection up" (e.g. a bad WiFi password, a bad gateway, an unplugged
# cable) leaves the new, possibly-broken config applied with no rollback
# ever scheduled to undo it.
rm -f "$WORKDIR/sequence.log"
echo "$STATIC_PAYLOAD" | bash "$HELPER" > /dev/null
SEQUENCE=$(cat "$WORKDIR/sequence.log" | tr '\n' ',')
case "$SEQUENCE" in
  systemd-run,*nmcli-connection-up*)
    assert_eq "scheduled-before-apply" "scheduled-before-apply" "apply-network-config.sh schedules the rollback timer before calling nmcli connection up"
    ;;
  *)
    assert_eq "scheduled-before-apply" "wrong order: $SEQUENCE" "apply-network-config.sh schedules the rollback timer before calling nmcli connection up"
    ;;
esac

# Final review (Critical C5): a second apply while a rollback from an
# earlier, unconfirmed apply is still pending must be refused outright --
# otherwise it overwrites the backup with the first (still-unconfirmed)
# settings, so the pending rollback restores the WRONG state, and
# scheduling a second timer under the same unit name conflicts with the
# first.
rm -f "$WORKDIR/nmcli.log" "$WORKDIR/systemd-run.log"
export AUNDEKIOSK_TEST_ROLLBACK_PENDING=1
echo "$STATIC_PAYLOAD" | bash "$HELPER" > "$WORKDIR/reject-pending.txt" 2>&1
assert_status 1 $? "apply-network-config.sh refuses to apply while a previous rollback is still pending"
[[ ! -s "$WORKDIR/nmcli.log" ]]
assert_status 0 $? "apply-network-config.sh never touches nmcli when a rollback is already pending"
unset AUNDEKIOSK_TEST_ROLLBACK_PENDING

# Final review (Important I3): if the CURRENT settings can't actually be
# read, the script must abort rather than silently recording a default
# ("auto", empty addresses) as the backup -- a backup that doesn't
# reflect the real previous settings is worse than no backup, since
# rollback-network.sh would "restore" the wrong thing with total
# confidence.
rm -f "$WORKDIR/network-backup.json" "$WORKDIR/nmcli.log" "$WORKDIR/systemd-run.log"
export AUNDEKIOSK_TEST_NMCLI_FAIL_READS=1
echo "$STATIC_PAYLOAD" | bash "$HELPER" > "$WORKDIR/reject-readfail.txt" 2>&1
assert_status 1 $? "apply-network-config.sh aborts when the current settings can't be read"
[[ ! -f "$WORKDIR/network-backup.json" ]]
assert_status 0 $? "apply-network-config.sh never writes a backup file when the current-settings read failed"
grep -q "connection up" "$WORKDIR/nmcli.log" 2>/dev/null
if [[ $? -eq 0 ]]; then
  assert_eq "never-applied" "applied-anyway" "apply-network-config.sh never applies a change when the current-settings read failed"
else
  assert_eq "never-applied" "never-applied" "apply-network-config.sh never applies a change when the current-settings read failed"
fi
unset AUNDEKIOSK_TEST_NMCLI_FAIL_READS

# Final review (Important I1): the WiFi PSK must never be passed to nmcli
# as a command-line argument -- /proc/<pid>/cmdline is readable by any
# local user while nmcli is running. It goes over nmcli's own stdin
# instead (via "nmcli connection edit"), matching how every other secret
# in this project reaches a privileged helper.
rm -f "$WORKDIR/nmcli.log" "$WORKDIR/systemd-run.log" "$WORKDIR/network-backup.json" "$WORKDIR/nmcli-stdin.log"
WIFI_PAYLOAD='{"interface":"wlan0","mode":"dhcp","staticIp":null,"gateway":null,"dns":null,"wifiSsid":"MyNetwork","wifiPassword":"a-secret-wifi-password"}'
echo "$WIFI_PAYLOAD" | bash "$HELPER"
assert_status 0 $? "apply-network-config.sh exits 0 for a valid wlan0 config"
grep -q "a-secret-wifi-password" "$WORKDIR/nmcli.log"
if [[ $? -eq 0 ]]; then
  assert_eq "psk-off-argv" "psk-on-argv" "apply-network-config.sh never passes the WiFi password to nmcli as a command-line argument"
else
  assert_eq "psk-off-argv" "psk-off-argv" "apply-network-config.sh never passes the WiFi password to nmcli as a command-line argument"
fi
grep -q "a-secret-wifi-password" "$WORKDIR/nmcli-stdin.log"
assert_status 0 $? "apply-network-config.sh sends the WiFi password to nmcli over stdin instead"

# Final review (Important I2): the backup must capture the WiFi
# SSID/password too (for wlan0), so a bad new SSID/PSK can actually be
# rolled back -- not just the IPv4 fields.
grep -q '"wifiSsid"' "$WORKDIR/network-backup.json"
assert_status 0 $? "apply-network-config.sh's backup includes a wifiSsid field for wlan0"
grep -q '"wifiPassword"' "$WORKDIR/network-backup.json"
assert_status 0 $? "apply-network-config.sh's backup includes a wifiPassword field for wlan0"

rm -f "$WORKDIR/nmcli.log" "$WORKDIR/network-backup.json"
INVALID_IP_PAYLOAD='{"interface":"eth0","mode":"static","staticIp":"not-an-ip","gateway":"192.168.1.1","dns":"8.8.8.8","wifiSsid":null,"wifiPassword":null}'
echo "$INVALID_IP_PAYLOAD" | bash "$HELPER" > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects an invalid static IP"
[[ ! -f "$WORKDIR/nmcli.log" ]]
assert_status 0 $? "apply-network-config.sh never calls nmcli when validation fails"

SHORT_WIFI_PASSWORD_PAYLOAD='{"interface":"wlan0","mode":"dhcp","staticIp":null,"gateway":null,"dns":null,"wifiSsid":"MyNet","wifiPassword":"short"}'
echo "$SHORT_WIFI_PASSWORD_PAYLOAD" | bash "$HELPER" > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects a WiFi password shorter than 8 characters"

NEWLINE_WIFI_PASSWORD_PAYLOAD=$(printf '%s' '{"interface":"wlan0","mode":"dhcp","staticIp":null,"gateway":null,"dns":null,"wifiSsid":"MyNet","wifiPassword":"long-enough\npassword"}')
echo "$NEWLINE_WIFI_PASSWORD_PAYLOAD" | bash "$HELPER" > "$WORKDIR/reject5.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects a WiFi password containing a newline"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "apply-network-config.sh rejects any command-line argument (data comes from stdin only)"

grep -q "AUNDEKIOSK_NETWORK_BACKUP_FILE:-/etc/aundekiosk-priv/network-backup.json" "$HELPER"
assert_status 0 $? "apply-network-config.sh's default backup path is outside the dashboard-owned tree"

rm -rf "$WORKDIR"
assert_summary
