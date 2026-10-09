#!/usr/bin/env bash
# Pure, side-effect-light resource-monitor helpers. Every function takes
# its data source as a file path so it can be tested with fixtures
# instead of real /proc files.

# CPU% between two /proc/stat snapshots (never an instantaneous reading,
# never /proc/loadavg — see spec §7.1). Fields after "cpu ": user nice
# system idle iowait irq softirq steal guest guest_nice.
compute_cpu_percent() {
  local prev_file="$1" curr_file="$2"
  awk -v prevfile="$prev_file" -v currfile="$curr_file" '
    BEGIN {
      while ((getline line < prevfile) > 0) {
        if (line ~ /^cpu /) { split(line, p, " "); break }
      }
      close(prevfile)
      while ((getline line < currfile) > 0) {
        if (line ~ /^cpu /) { split(line, c, " "); break }
      }
      close(currfile)
      p_busy = p[2]+p[3]+p[4]+p[7]+p[8]+p[9]
      p_idle = p[5]+p[6]
      p_total = p_busy + p_idle
      c_busy = c[2]+c[3]+c[4]+c[7]+c[8]+c[9]
      c_idle = c[5]+c[6]
      c_total = c_busy + c_idle
      d_busy = c_busy - p_busy
      d_total = c_total - p_total
      if (d_total <= 0) { printf "0.00"; exit }
      printf "%.2f", (d_busy / d_total) * 100
    }
  '
}

# RAM% from a single /proc/meminfo snapshot. Uses MemAvailable (reclaimable
# cache/buffers excluded correctly), never MemFree (spec §7.1).
compute_ram_percent() {
  local meminfo_file="$1"
  awk '
    /^MemTotal:/ { total = $2 }
    /^MemAvailable:/ { avail = $2 }
    END { printf "%.2f", (total - avail) / total * 100 }
  ' "$meminfo_file"
}

# Appends one English, JSON-line audit event — same shape and append-only
# discipline as the dashboard's dashboard/auth/audit_log.ts (spec §6/§9:
# always English, regardless of UI language).
append_monitor_audit_event() {
  local log_path="$1" event="$2" metric="$3" value="$4" threshold="$5" action="$6"
  local timestamp
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  jq -nc \
    --arg timestamp "$timestamp" \
    --arg event "$event" \
    --arg metric "$metric" \
    --argjson value "$value" \
    --argjson threshold "$threshold" \
    --arg action "$action" \
    '{timestamp: $timestamp, event: $event, metric: $metric, value: $value, threshold: $threshold, action: $action}' \
    >> "$log_path"
}

# Hysteresis: value >= threshold increments; value < threshold - margin
# resets to 0; the band between them holds the count steady, so a value
# wobbling right at the boundary doesn't keep resetting (spec §7.3 states
# the increment and reset rules but not the band between them — holding
# steady is the only reading consistent with both, since neither stated
# condition fires there).
update_consecutive_count() {
  local value="$1" threshold="$2" margin="$3" current_count="$4"
  awk -v value="$value" -v threshold="$threshold" -v margin="$margin" -v count="$current_count" '
    BEGIN {
      if (value >= threshold) { print count + 1 }
      else if (value < threshold - margin) { print 0 }
      else { print count }
    }
  '
}

# True once a tier's cooldown has elapsed (now >= cooldown_until).
is_tier_ready() {
  local now_epoch="$1" cooldown_until_epoch="$2"
  [[ "$now_epoch" -ge "$cooldown_until_epoch" ]]
}

# log < restart_services < reboot.
action_severity() {
  case "$1" in
    log) echo 1 ;;
    restart_services) echo 2 ;;
    reboot) echo 3 ;;
    *) echo 0 ;;
  esac
}

pick_harsher_action() {
  local a="$1" b="$2"
  if [[ "$(action_severity "$a")" -ge "$(action_severity "$b")" ]]; then
    echo "$a"
  else
    echo "$b"
  fi
}

# Folds any number of simultaneously-triggered tier actions down to the
# single harshest one (spec §7.3 point 4) — this is what stops, say, a
# CPU tier's restart_services and a RAM tier's reboot from both firing in
# the same cycle.
resolve_triggered_action() {
  local result=""
  for action in "$@"; do
    if [[ -z "$result" ]]; then
      result="$action"
    else
      result=$(pick_harsher_action "$result" "$action")
    fi
  done
  echo "$result"
}

# Whether `current` (HH:MM) falls inside [start, end]. Handles a window
# that wraps midnight (start > end, e.g. 22:00-02:00) as well as a plain
# same-day window; the "10#" prefixes stop bash from misreading a
# zero-padded hour like "08" as an invalid octal literal.
is_within_monitoring_window() {
  local current="$1" start="$2" end="$3"
  local cur_min start_min end_min
  cur_min=$(( (10#${current%%:*}) * 60 + 10#${current##*:} ))
  start_min=$(( (10#${start%%:*}) * 60 + 10#${start##*:} ))
  end_min=$(( (10#${end%%:*}) * 60 + 10#${end##*:} ))
  if [[ "$start_min" -le "$end_min" ]]; then
    [[ "$cur_min" -ge "$start_min" && "$cur_min" -le "$end_min" ]]
  else
    [[ "$cur_min" -ge "$start_min" || "$cur_min" -le "$end_min" ]]
  fi
}
