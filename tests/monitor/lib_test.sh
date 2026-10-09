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


# --- update_consecutive_count (hysteresis) ---
result=$(update_consecutive_count 82 80 2 3)
assert_eq "4" "$result" "update_consecutive_count increments when value is at/above threshold"

result=$(update_consecutive_count 77 80 2 3)
assert_eq "0" "$result" "update_consecutive_count resets when value drops below threshold minus margin"

result=$(update_consecutive_count 79 80 2 3)
assert_eq "3" "$result" "update_consecutive_count holds steady inside the hysteresis band (neither resets nor increments)"

# Review Focus: oscillating right at the boundary never lets the count
# collapse back to 0 and restart — it holds at 3 through every wobble.
count=3
for value in 79 80.5 79.2 80 78.5; do
  count=$(update_consecutive_count "$value" 80 2 "$count")
done
assert_eq "5" "$count" "oscillation around the threshold only ever holds or increments, never resets, across repeated wobbles"

# --- is_tier_ready (cooldown) ---
if is_tier_ready 1000 1000; then
  assert_eq "ready" "ready" "is_tier_ready is true exactly at the cooldown deadline"
else
  assert_eq "ready" "not-ready" "is_tier_ready is true exactly at the cooldown deadline"
fi

if is_tier_ready 999 1000; then
  assert_eq "not-ready" "ready" "is_tier_ready is false before the cooldown deadline (no re-trigger during cooldown)"
else
  assert_eq "not-ready" "not-ready" "is_tier_ready is false before the cooldown deadline (no re-trigger during cooldown)"
fi

# --- action_severity / pick_harsher_action / resolve_triggered_action ---
result=$(action_severity "log")
assert_eq "1" "$result" "action_severity ranks log lowest"
result=$(action_severity "restart_services")
assert_eq "2" "$result" "action_severity ranks restart_services in the middle"
result=$(action_severity "reboot")
assert_eq "3" "$result" "action_severity ranks reboot highest"

result=$(pick_harsher_action "log" "restart_services")
assert_eq "restart_services" "$result" "pick_harsher_action picks restart_services over log"
result=$(pick_harsher_action "reboot" "restart_services")
assert_eq "reboot" "$result" "pick_harsher_action picks reboot over restart_services"

# Review Focus: two tiers (e.g. CPU's restart_services tier and RAM's
# reboot tier) triggering in the same cycle resolve to exactly one action.
result=$(resolve_triggered_action "log" "restart_services" "reboot" "log")
assert_eq "reboot" "$result" "resolve_triggered_action resolves several simultaneously-triggered tiers to the single harshest action"

result=$(resolve_triggered_action "log")
assert_eq "log" "$result" "resolve_triggered_action with a single triggered tier returns that tier's action"

result=$(resolve_triggered_action)
assert_eq "" "$result" "resolve_triggered_action with no triggered tiers returns nothing"

# --- is_within_monitoring_window ---
if is_within_monitoring_window "08:30" "00:00" "23:59"; then
  assert_eq "always" "always" "is_within_monitoring_window: the default 00:00-23:59 window covers any time"
else
  assert_eq "always" "outside" "is_within_monitoring_window: the default 00:00-23:59 window covers any time"
fi

if is_within_monitoring_window "02:00" "01:00" "03:00"; then
  assert_eq "inside" "inside" "is_within_monitoring_window: a simple same-day window includes a time inside it"
else
  assert_eq "inside" "outside" "is_within_monitoring_window: a simple same-day window includes a time inside it"
fi

# Review Focus: outside the window, no action should ever be considered —
# this is the function the monitor loop checks before measuring anything.
if is_within_monitoring_window "04:00" "01:00" "03:00"; then
  assert_eq "outside" "inside" "is_within_monitoring_window: a time after a simple window's end is outside it"
else
  assert_eq "outside" "outside" "is_within_monitoring_window: a time after a simple window's end is outside it"
fi

if is_within_monitoring_window "23:30" "22:00" "02:00"; then
  assert_eq "inside" "inside" "is_within_monitoring_window: a midnight-wrapping window includes a late-night time"
else
  assert_eq "inside" "outside" "is_within_monitoring_window: a midnight-wrapping window includes a late-night time"
fi

if is_within_monitoring_window "09:00" "22:00" "02:00"; then
  assert_eq "outside" "inside" "is_within_monitoring_window: a midnight-wrapping window excludes a daytime time"
else
  assert_eq "outside" "outside" "is_within_monitoring_window: a midnight-wrapping window excludes a daytime time"
fi

rm -rf "$FIXTURES"
assert_summary
