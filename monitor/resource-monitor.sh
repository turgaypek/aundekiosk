#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

MONITOR_CONFIG_FILE="${AUNDEKIOSK_MONITOR_CONFIG_FILE:-/opt/aundekiosk/monitor-config.json}"
AUDIT_LOG_FILE="${AUNDEKIOSK_AUDIT_LOG_FILE:-/opt/aundekiosk/audit.log}"
STAT_FILE="${AUNDEKIOSK_PROC_STAT_FILE:-/proc/stat}"
MEMINFO_FILE="${AUNDEKIOSK_PROC_MEMINFO_FILE:-/proc/meminfo}"
RESTART_HELPER="${AUNDEKIOSK_RESTART_HELPER:-/opt/aundekiosk/privileged/restart-kiosk-services.sh}"
REBOOT_HELPER="${AUNDEKIOSK_REBOOT_HELPER:-/opt/aundekiosk/privileged/reboot-device.sh}"

# 2 percentage points — see spec §7.3 and monitor/lib.sh's update_consecutive_count.
readonly HYSTERESIS_MARGIN=2

declare -A TIER_COUNT_CPU
declare -A TIER_COUNT_RAM
declare -A TIER_COOLDOWN_UNTIL
PREV_CONFIG=""

echo "AundeKiosk resource monitor started."

# Startup grace: suppress restart_services/reboot for at least as long as
# the longest configured cooldown (minimum 60s) after this process starts
# — including right after a reboot the monitor itself just caused. Without
# this, an in-memory-only cooldown (see below) can't survive the very
# reboot it's meant to rate-limit, which is exactly how a reboot loop
# would happen. Computed once from whatever config exists at startup;
# later edits don't shrink an already-running grace period.
STARTUP_GRACE_SECONDS=$(jq -r '([.tiers[]?.cooldownSeconds] | max) // 60' "$MONITOR_CONFIG_FILE" 2>/dev/null || echo 60)
DAEMON_START_EPOCH=$(date +%s)

PREV_STAT_SNAPSHOT=$(mktemp)
cp "$STAT_FILE" "$PREV_STAT_SNAPSHOT"
trap 'rm -f "$PREV_STAT_SNAPSHOT"' EXIT

while true; do
  CONFIG=$(cat "$MONITOR_CONFIG_FILE")

  # The dashboard can edit tiers (add/remove/reorder/change threshold or
  # action) at any time. Tier state below is keyed by array index, which
  # has no stable identity across such an edit — index 0 might mean a
  # different tier than it did a moment ago. Rather than try to match old
  # and new tiers up, any change at all resets every count and cooldown:
  # the safe default is re-establishing sustained-sample evidence under
  # the *current* config, never carrying state forward under a config it
  # was never measured against.
  if [[ "$CONFIG" != "$PREV_CONFIG" ]]; then
    if [[ -n "$PREV_CONFIG" ]]; then
      echo "Resource monitor: configuration changed, resetting all tier state (hysteresis counts and cooldowns)."
    fi
    TIER_COUNT_CPU=()
    TIER_COUNT_RAM=()
    TIER_COOLDOWN_UNTIL=()
    PREV_CONFIG="$CONFIG"
  fi

  SAMPLE_INTERVAL=$(echo "$CONFIG" | jq -r '.sampleIntervalSeconds')
  WINDOW_START=$(echo "$CONFIG" | jq -r '.activeWindow.start // "00:00"')
  WINDOW_END=$(echo "$CONFIG" | jq -r '.activeWindow.end // "23:59"')

  sleep "$SAMPLE_INTERVAL"

  NOW_HHMM=$(date +%H:%M)
  if ! is_within_monitoring_window "$NOW_HHMM" "$WINDOW_START" "$WINDOW_END"; then
    # Outside the configured window: no measurement, no action (spec §7.4).
    continue
  fi

  CURR_STAT_SNAPSHOT=$(mktemp)
  cp "$STAT_FILE" "$CURR_STAT_SNAPSHOT"
  CPU_PERCENT=$(compute_cpu_percent "$PREV_STAT_SNAPSHOT" "$CURR_STAT_SNAPSHOT")
  rm -f "$PREV_STAT_SNAPSHOT"
  PREV_STAT_SNAPSHOT="$CURR_STAT_SNAPSHOT"

  RAM_PERCENT=$(compute_ram_percent "$MEMINFO_FILE")
  NOW_EPOCH=$(date +%s)

  TRIGGERED_ACTIONS=()
  TIER_COUNT_TOTAL=$(echo "$CONFIG" | jq -r '.tiers | length')

  for ((i = 0; i < TIER_COUNT_TOTAL; i++)); do
    THRESHOLD=$(echo "$CONFIG" | jq -r ".tiers[$i].threshold")
    SUSTAINED=$(echo "$CONFIG" | jq -r ".tiers[$i].sustainedSamples")
    ACTION=$(echo "$CONFIG" | jq -r ".tiers[$i].action")
    COOLDOWN_SECONDS=$(echo "$CONFIG" | jq -r ".tiers[$i].cooldownSeconds")

    for METRIC in cpu ram; do
      if [[ "$METRIC" == "cpu" ]]; then
        VALUE="$CPU_PERCENT"
        PREV_COUNT="${TIER_COUNT_CPU[$i]:-0}"
      else
        VALUE="$RAM_PERCENT"
        PREV_COUNT="${TIER_COUNT_RAM[$i]:-0}"
      fi

      NEW_COUNT=$(update_consecutive_count "$VALUE" "$THRESHOLD" "$HYSTERESIS_MARGIN" "$PREV_COUNT")
      if [[ "$METRIC" == "cpu" ]]; then TIER_COUNT_CPU[$i]="$NEW_COUNT"; else TIER_COUNT_RAM[$i]="$NEW_COUNT"; fi

      COOLDOWN_KEY="${METRIC}_${i}"
      TIER_DEADLINE="${TIER_COOLDOWN_UNTIL[$COOLDOWN_KEY]:-0}"

      if [[ "$NEW_COUNT" -ge "$SUSTAINED" ]] && is_tier_ready "$NOW_EPOCH" "$TIER_DEADLINE"; then
        TIER_COOLDOWN_UNTIL[$COOLDOWN_KEY]=$((NOW_EPOCH + COOLDOWN_SECONDS))
        # Records which tier/metric crossed and what it calls for — not
        # necessarily what runs: if several tiers fire in the same cycle,
        # only the single harshest resolved action below actually executes.
        append_monitor_audit_event "$AUDIT_LOG_FILE" "threshold_triggered" "$METRIC" "$VALUE" "$THRESHOLD" "$ACTION"
        TRIGGERED_ACTIONS+=("$ACTION")
      fi
    done
  done

  if [[ "${#TRIGGERED_ACTIONS[@]}" -gt 0 ]]; then
    FINAL_ACTION=$(resolve_triggered_action "${TRIGGERED_ACTIONS[@]}")
    ELAPSED_SINCE_START=$((NOW_EPOCH - DAEMON_START_EPOCH))

    if [[ "$FINAL_ACTION" != "log" ]] && is_within_startup_grace "$ELAPSED_SINCE_START" "$STARTUP_GRACE_SECONDS"; then
      echo "Resource monitor: suppressing '$FINAL_ACTION' during the ${STARTUP_GRACE_SECONDS}s startup grace period (${ELAPSED_SINCE_START}s elapsed) to avoid a reboot loop."
      append_monitor_audit_event "$AUDIT_LOG_FILE" "action_suppressed_startup_grace" "system" 0 0 "$FINAL_ACTION"
    else
      # The one action that actually ran — see the comment above
      # threshold_triggered for why this is a separate event.
      append_monitor_audit_event "$AUDIT_LOG_FILE" "action_executed" "system" 0 0 "$FINAL_ACTION"
      case "$FINAL_ACTION" in
        restart_services)
          echo "Resource monitor: restarting kiosk services."
          sudo "$RESTART_HELPER"
          ;;
        reboot)
          echo "Resource monitor: rebooting device."
          sudo "$REBOOT_HELPER"
          ;;
        log)
          echo "Resource monitor: threshold logged, no action taken."
          ;;
      esac
    fi
  fi
done
