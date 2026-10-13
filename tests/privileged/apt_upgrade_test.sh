#!/usr/bin/env bash
set -uo pipefail

# apt-upgrade.sh runs "apt-get update && apt-get upgrade" as a detached
# systemd transient unit ("start" launches "run" via systemd-run, so the
# upgrade survives a dashboard restart or a closed browser tab). "run" is
# never sudo-whitelisted directly — only reachable through "start"'s own
# systemd-run call, which is already root by the time it makes it.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/apt-upgrade.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMCTL_LOG"
if [[ "$1" == "is-active" ]]; then
  [[ "${AUNDEKIOSK_TEST_UNIT_ACTIVE:-}" == "1" ]]
  exit $?
fi
exit 0
EOF
chmod +x "$FAKE_BIN/systemctl"

cat > "$FAKE_BIN/systemd-run" <<'EOF'
#!/usr/bin/env bash
echo "$@" >> "$AUNDEKIOSK_TEST_SYSTEMD_RUN_LOG"
EOF
chmod +x "$FAKE_BIN/systemd-run"

cat > "$FAKE_BIN/apt-get" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "update" ]]; then
  echo "Fetched 1kB"
  exit "${AUNDEKIOSK_TEST_APT_UPDATE_CODE:-0}"
fi
echo "Unpacking stuff..."
exit "${AUNDEKIOSK_TEST_APT_UPGRADE_CODE:-0}"
EOF
chmod +x "$FAKE_BIN/apt-get"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_LOG="$WORKDIR/systemctl.log"
export AUNDEKIOSK_TEST_SYSTEMD_RUN_LOG="$WORKDIR/systemd-run.log"
export AUNDEKIOSK_APT_UPGRADE_LOG_FILE="$WORKDIR/apt-upgrade.log"
export AUNDEKIOSK_AUDIT_LOG_FILE="$WORKDIR/audit.log"
export AUNDEKIOSK_REBOOT_REQUIRED_FILE="$WORKDIR/reboot-required"

# --- start --------------------------------------------------------------

bash "$HELPER" start > "$WORKDIR/start-out.txt" 2>&1
assert_status 0 $? "apt-upgrade.sh start exits 0 when nothing is already running"
grep -q "started" "$WORKDIR/start-out.txt"
assert_status 0 $? "apt-upgrade.sh start reports that it started"
grep -q "aundekiosk-apt-upgrade" "$WORKDIR/systemd-run.log"
assert_status 0 $? "apt-upgrade.sh start launches the detached unit via systemd-run"
grep -q " run$" "$WORKDIR/systemd-run.log"
assert_status 0 $? "apt-upgrade.sh start's systemd-run call re-invokes the script with 'run'"
[[ -f "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE" ]]
assert_status 0 $? "apt-upgrade.sh start creates a fresh log file"
PERMS=$(stat -c '%a' "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE" 2>/dev/null || stat -f '%Lp' "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE")
assert_eq "644" "$PERMS" "apt-upgrade.sh start's log file is world-readable (mode 644) so the dashboard user can read it back"

rm -f "$WORKDIR/systemd-run.log" "$WORKDIR/systemctl.log"
export AUNDEKIOSK_TEST_UNIT_ACTIVE=1
bash "$HELPER" start > "$WORKDIR/already-running.txt" 2>&1
assert_status 2 $? "apt-upgrade.sh start exits with a distinct code when an upgrade is already running"
grep -qi "already" "$WORKDIR/already-running.txt"
assert_status 0 $? "apt-upgrade.sh start's message says an upgrade is already running"
[[ ! -s "$WORKDIR/systemd-run.log" ]]
assert_status 0 $? "apt-upgrade.sh start never launches a second systemd-run while one is already active"
unset AUNDEKIOSK_TEST_UNIT_ACTIVE

bash "$HELPER" start extra-arg > "$WORKDIR/reject.txt" 2>&1
assert_status 1 $? "apt-upgrade.sh start rejects an extra argument"

# --- run: success ---------------------------------------------------------

rm -f "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE" "$AUNDEKIOSK_AUDIT_LOG_FILE"
bash "$HELPER" run
assert_status 0 $? "apt-upgrade.sh run exits 0 when both apt-get update and upgrade succeed"
grep -q "running apt-get update" "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE"
assert_status 0 $? "apt-upgrade.sh run logs the update phase"
grep -q "running apt-get upgrade" "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE"
assert_status 0 $? "apt-upgrade.sh run logs the upgrade phase"
grep -q "finished successfully" "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE"
assert_status 0 $? "apt-upgrade.sh run logs the success marker apt_upgrade_api.ts looks for"

STARTED_EVENT=$(jq -c 'select(.event == "apt_upgrade_started")' "$AUNDEKIOSK_AUDIT_LOG_FILE")
assert_status 0 $? "apt-upgrade.sh run's audit log has a parseable apt_upgrade_started line"
echo "$STARTED_EVENT" | grep -q '"ok":true'
assert_status 0 $? "apt-upgrade.sh run audit-logs apt_upgrade_started with ok:true"

FINISHED_EVENT=$(jq -c 'select(.event == "apt_upgrade_finished")' "$AUNDEKIOSK_AUDIT_LOG_FILE")
echo "$FINISHED_EVENT" | grep -q '"ok":true'
assert_status 0 $? "apt-upgrade.sh run audit-logs apt_upgrade_finished with ok:true on success"
echo "$FINISHED_EVENT" | grep -q '"rebootRequired":false'
assert_status 0 $? "apt-upgrade.sh run audit-logs rebootRequired:false when no reboot is pending"

# --- run: reboot required --------------------------------------------------

rm -f "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE" "$AUNDEKIOSK_AUDIT_LOG_FILE"
touch "$AUNDEKIOSK_REBOOT_REQUIRED_FILE"
bash "$HELPER" run
assert_status 0 $? "apt-upgrade.sh run still exits 0 when a reboot is required"
FINISHED_EVENT=$(jq -c 'select(.event == "apt_upgrade_finished")' "$AUNDEKIOSK_AUDIT_LOG_FILE")
echo "$FINISHED_EVENT" | grep -q '"rebootRequired":true'
assert_status 0 $? "apt-upgrade.sh run audit-logs rebootRequired:true when /var/run/reboot-required exists"
rm -f "$AUNDEKIOSK_REBOOT_REQUIRED_FILE"

# --- run: apt-get update fails (upgrade never runs) ------------------------

rm -f "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE" "$AUNDEKIOSK_AUDIT_LOG_FILE"
export AUNDEKIOSK_TEST_APT_UPDATE_CODE=1
bash "$HELPER" run
assert_status 1 $? "apt-upgrade.sh run exits non-zero when apt-get update fails"
unset AUNDEKIOSK_TEST_APT_UPDATE_CODE
grep -q "FAILED" "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE"
assert_status 0 $? "apt-upgrade.sh run logs FAILED when apt-get update fails"
grep -q "running apt-get upgrade" "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE"
assert_status 1 $? "apt-upgrade.sh run never attempts the upgrade phase after update fails"
FINISHED_EVENT=$(jq -c 'select(.event == "apt_upgrade_finished")' "$AUNDEKIOSK_AUDIT_LOG_FILE")
echo "$FINISHED_EVENT" | grep -q '"ok":false'
assert_status 0 $? "apt-upgrade.sh run audit-logs apt_upgrade_finished with ok:false when update fails"

# --- run: apt-get upgrade fails ---------------------------------------------

rm -f "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE" "$AUNDEKIOSK_AUDIT_LOG_FILE"
export AUNDEKIOSK_TEST_APT_UPGRADE_CODE=1
bash "$HELPER" run
assert_status 1 $? "apt-upgrade.sh run exits non-zero when apt-get upgrade fails"
unset AUNDEKIOSK_TEST_APT_UPGRADE_CODE
grep -q "FAILED" "$AUNDEKIOSK_APT_UPGRADE_LOG_FILE"
assert_status 0 $? "apt-upgrade.sh run logs FAILED when apt-get upgrade fails"
FINISHED_EVENT=$(jq -c 'select(.event == "apt_upgrade_finished")' "$AUNDEKIOSK_AUDIT_LOG_FILE")
echo "$FINISHED_EVENT" | grep -q '"ok":false'
assert_status 0 $? "apt-upgrade.sh run audit-logs apt_upgrade_finished with ok:false when upgrade fails"

bash "$HELPER" run extra-arg > "$WORKDIR/reject-run.txt" 2>&1
assert_status 1 $? "apt-upgrade.sh run rejects an extra argument"

bash "$HELPER" > "$WORKDIR/reject-missing.txt" 2>&1
assert_status 1 $? "apt-upgrade.sh rejects a missing action argument"

bash "$HELPER" frobnicate > "$WORKDIR/reject-invalid.txt" 2>&1
assert_status 1 $? "apt-upgrade.sh rejects an action other than start/run"

rm -rf "$WORKDIR"
assert_summary
