#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/toggle-service.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMCTL_LOG"
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_LOG="$WORKDIR/systemctl.log"

bash "$HELPER" aundekiosk-runner stop
assert_status 0 $? "toggle-service.sh aundekiosk-runner stop exits 0"
grep -q "^stop aundekiosk-runner$" "$WORKDIR/systemctl.log"
assert_status 0 $? "toggle-service.sh calls systemctl stop <service>"

rm -f "$WORKDIR/systemctl.log"
bash "$HELPER" aundekiosk-dashboard start
assert_status 0 $? "toggle-service.sh aundekiosk-dashboard start exits 0"
grep -q "^start aundekiosk-dashboard$" "$WORKDIR/systemctl.log"
assert_status 0 $? "toggle-service.sh calls systemctl start <service>"

rm -f "$WORKDIR/systemctl.log"
bash "$HELPER" sshd stop > "$WORKDIR/reject1.txt" 2>&1
assert_status 1 $? "toggle-service.sh rejects a service outside the four AundeKiosk units"
[[ ! -s "$WORKDIR/systemctl.log" ]]
assert_status 0 $? "toggle-service.sh never calls systemctl for a disallowed service"

bash "$HELPER" aundekiosk-monitor restart > "$WORKDIR/reject2.txt" 2>&1
assert_status 1 $? "toggle-service.sh rejects an action outside start/stop"

bash "$HELPER" aundekiosk-runner > "$WORKDIR/reject3.txt" 2>&1
assert_status 1 $? "toggle-service.sh rejects a missing action argument"

bash "$HELPER" > "$WORKDIR/reject4.txt" 2>&1
assert_status 1 $? "toggle-service.sh rejects a missing service argument"

rm -rf "$WORKDIR"
assert_summary
