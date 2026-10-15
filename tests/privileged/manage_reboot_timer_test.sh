#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/manage-reboot-timer.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$WORKDIR/systemctl.log"
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_TIMER_FILE="$WORKDIR/aundekiosk-reboot.timer"
export AUNDEKIOSK_TEST_SERVICE_FILE="$WORKDIR/aundekiosk-reboot.service"
export WORKDIR

# Case 1: enable with valid time writes timer file with correct OnCalendar
echo '{"action":"enable","time":"03:00"}' | bash "$HELPER"
assert_status 0 $? "manage-reboot-timer.sh enable exits 0"

grep -q "^OnCalendar=\*-\*-\* 03:00:00$" "$AUNDEKIOSK_TEST_TIMER_FILE"
assert_status 0 $? "timer file contains the correct OnCalendar line"

[ -f "$AUNDEKIOSK_TEST_SERVICE_FILE" ]
assert_status 0 $? "service file is created alongside the timer file"

grep -q "daemon-reload" "$WORKDIR/systemctl.log"
assert_status 0 $? "systemctl daemon-reload was called"

grep -q "enable --now aundekiosk-reboot.timer" "$WORKDIR/systemctl.log"
assert_status 0 $? "systemctl enables the timer"

# Case 2: enable with invalid time (25:00) exits 1
: > "$WORKDIR/systemctl.log"
echo '{"action":"enable","time":"25:00"}' | bash "$HELPER"
assert_status 1 $? "manage-reboot-timer.sh rejects hour 25"

[ ! -f "$AUNDEKIOSK_TEST_TIMER_FILE" ] || grep -qv "25:00" "$AUNDEKIOSK_TEST_TIMER_FILE"
assert_status 0 $? "invalid time does not produce a timer file with 25:00"

# Case 3: enable with newline injection attempt exits 1 (HH:MM pattern disallows it)
echo '{"action":"enable","time":"03:00\nExecStart=evil"}' | bash "$HELPER"
assert_status 1 $? "manage-reboot-timer.sh rejects time with embedded newline"

# Case 4: disable removes files and calls systemctl
echo '{"action":"enable","time":"04:00"}' | bash "$HELPER"  # re-enable so files exist
echo '{"action":"disable"}' | bash "$HELPER"
assert_status 0 $? "disable exits 0"

[ ! -f "$AUNDEKIOSK_TEST_TIMER_FILE" ]
assert_status 0 $? "timer file is removed after disable"

[ ! -f "$AUNDEKIOSK_TEST_SERVICE_FILE" ]
assert_status 0 $? "service file is removed after disable"

# Case 5: unknown action exits 1
echo '{"action":"unknown"}' | bash "$HELPER"
assert_status 1 $? "unknown action exits 1"

rm -rf "$WORKDIR"
assert_summary
