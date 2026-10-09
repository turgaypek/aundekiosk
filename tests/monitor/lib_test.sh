#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"
source "$SCRIPT_DIR/../../monitor/lib.sh"

FIXTURES="$SCRIPT_DIR/fixtures"
mkdir -p "$FIXTURES"

# --- compute_cpu_percent ---
# prev: busy=1000+50+200+5+10+0=1265, idle=8000+30=8030, total=9295
# curr: busy=1100+50+250+5+10+0=1415, idle=8050+30=8080, total=9495
# delta busy=150, delta total=200 -> 75.00%
cat > "$FIXTURES/stat_prev.txt" <<'EOF'
cpu  1000 50 200 8000 30 5 10 0 0 0
cpu0 500 25 100 4000 15 2 5 0 0 0
intr 12345
EOF
cat > "$FIXTURES/stat_curr.txt" <<'EOF'
cpu  1100 50 250 8050 30 5 10 0 0 0
cpu0 550 25 125 4025 15 2 5 0 0 0
intr 12400
EOF
result=$(compute_cpu_percent "$FIXTURES/stat_prev.txt" "$FIXTURES/stat_curr.txt")
assert_eq "75.00" "$result" "compute_cpu_percent computes the delta-based CPU percentage"

# No time has passed (identical snapshots) -> 0%, not a division error.
result=$(compute_cpu_percent "$FIXTURES/stat_prev.txt" "$FIXTURES/stat_prev.txt")
assert_eq "0.00" "$result" "compute_cpu_percent returns 0.00 when delta_total is zero (identical snapshots)"

# --- compute_ram_percent ---
# (4050000 - 1012500) / 4050000 * 100 = 75.00
cat > "$FIXTURES/meminfo.txt" <<'EOF'
MemTotal:        4050000 kB
MemFree:          120000 kB
MemAvailable:    1012500 kB
EOF
result=$(compute_ram_percent "$FIXTURES/meminfo.txt")
assert_eq "75.00" "$result" "compute_ram_percent uses MemAvailable, not MemFree"

# --- append_monitor_audit_event ---
AUDIT_LOG="$FIXTURES/audit.log"
rm -f "$AUDIT_LOG"
append_monitor_audit_event "$AUDIT_LOG" "threshold_triggered" "cpu" "82.5" "80" "restart_services"
line=$(cat "$AUDIT_LOG")
echo "$line" | jq -e '.event == "threshold_triggered"' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the event name"
echo "$line" | jq -e '.metric == "cpu"' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the metric"
echo "$line" | jq -e '.value == 82.5' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the numeric value"
echo "$line" | jq -e '.threshold == 80' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the numeric threshold"
echo "$line" | jq -e '.action == "restart_services"' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the action"
echo "$line" | jq -e '.timestamp | type == "string"' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes a timestamp"

append_monitor_audit_event "$AUDIT_LOG" "threshold_triggered" "ram" "91" "90" "reboot"
line_count=$(wc -l < "$AUDIT_LOG")
assert_eq "2" "$line_count" "append_monitor_audit_event appends, never overwrites"

rm -rf "$FIXTURES"
assert_summary
