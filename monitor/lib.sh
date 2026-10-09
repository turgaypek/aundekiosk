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
