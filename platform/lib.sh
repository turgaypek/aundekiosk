#!/usr/bin/env bash
# Pure, side-effect-light detection helpers for AundeKiosk runtime scripts.
# Every function takes its data source as a parameter so it can be tested
# with fixture files instead of real Raspberry Pi hardware.

detect_pi_model() {
  local model_file="${1:-/proc/device-tree/model}"
  if [[ -r "$model_file" ]]; then
    tr -d '\0' < "$model_file"
  else
    echo "unknown"
  fi
}

detect_display_server() {
  local wayland_display="$1"
  local x_display="$2"
  if [[ -n "$wayland_display" ]]; then
    echo "wayland"
  elif [[ -n "$x_display" ]]; then
    echo "x11"
  else
    echo "unknown"
  fi
}

# Unknown display server defaults to xdotool: it also works under XWayland
# compatibility layers and fails loudly (clear error) if truly absent,
# which is safer than silently doing nothing.
select_switch_tool() {
  local display_server="$1"
  if [[ "$display_server" == "wayland" ]]; then
    echo "wtype"
  else
    echo "xdotool"
  fi
}

detect_ram_mb() {
  local meminfo_file="${1:-/proc/meminfo}"
  local kb
  kb=$(awk '/^MemTotal:/ { print $2 }' "$meminfo_file")
  echo $(( kb / 1024 ))
}

# Sizes the RAM-backed (tmpfs) cache install.sh gives Chromium, in MB.
# RAM/16 scales with the board, floored at 64MB (a cache that small is
# still useful) and capped at 512MB (so it can never itself become a
# meaningful chunk of RAM on a high-RAM board — this is a fixed ceiling,
# not a target).
compute_tmpfs_cache_mb() {
  local ram_mb="$1"
  local mb=$(( ram_mb / 16 ))
  if (( mb < 64 )); then
    mb=64
  elif (( mb > 512 )); then
    mb=512
  fi
  echo "$mb"
}

# Every jq call below pipes through `tr -d '\r'`: on at least one platform
# (jq.exe on Windows) `jq -r` emits CRLF line endings, which otherwise
# leaves a trailing \r on every line `mapfile` reads — invisible in
# terminal output but breaking exact string/number comparisons downstream.
# A no-op on Linux, where jq already emits plain \n.

# One URL per output line (like extract_durations_from_config /
# extract_cycles_from_config), so callers read it with `mapfile` into a
# real array instead of a space-joined string — a single string would
# have to be word-split to launch chromium, which lets a URL containing
# a space or a leading "--" inject extra argv entries.
extract_urls_from_config() {
  local config_file="$1"
  jq -r '.urls[].url' "$config_file" | tr -d '\r'
}

extract_durations_from_config() {
  local config_file="$1"
  jq -r '.urls[].duration' "$config_file" | tr -d '\r'
}

extract_cycles_from_config() {
  local config_file="$1"
  jq -r '.urls[].cycles' "$config_file" | tr -d '\r'
}

url_count_in_config() {
  local config_file="$1"
  jq -r '.urls | length' "$config_file" | tr -d '\r'
}

has_urls() {
  local config_file="$1"
  [[ "$(url_count_in_config "$config_file")" -gt 0 ]]
}

# Read straight from the file on every call, never from a cached array —
# switcher.sh calls these once per loop iteration so a dashboard edit
# (new duration, new cycle target, a changed URL) takes effect on the
# very next iteration, instead of only after the switcher service is
# restarted. Found live: an admin changed a URL's duration from 10s to
# 30s and applied it, but the already-running switcher kept using the
# 10s it had loaded once at its own startup, minutes earlier.
url_at_index() {
  local config_file="$1"
  local index="$2"
  jq -r ".urls[$index].url" "$config_file" | tr -d '\r'
}

duration_at_index() {
  local config_file="$1"
  local index="$2"
  jq -r ".urls[$index].duration" "$config_file" | tr -d '\r'
}

cycles_at_index() {
  local config_file="$1"
  local index="$2"
  jq -r ".urls[$index].cycles" "$config_file" | tr -d '\r'
}

# One jq call, one read of the file, returning count+url+duration+cycles
# together — switcher.sh's main loop uses this instead of calling
# url_count_in_config/url_at_index/duration_at_index/cycles_at_index
# separately. Four separate reads left a window where a config rewrite
# landing between them could make an in-range count's read race a
# since-shrunk array's per-field read, surfacing jq's "null" for every
# field (which a "set -u" caller then aborts on as an unbound variable)
# instead of a clean, immediately-correctable "out of range". An
# out-of-range index gets placeholder url/duration/cycles ("", 0, 0)
# rather than jq's "null" — count is still the real one, so a caller can
# tell the two cases apart and clamp its own index instead of acting on
# placeholder data.
#
# Fields are joined with \x1f (unit separator), not a tab: bash's `read`
# treats tab as "IFS whitespace" even when IFS is set to just tab alone,
# so it silently collapses consecutive tabs and shifts every field after
# an empty one — exactly the case a url="" placeholder hits. \x1f is not
# whitespace to bash, so empty fields come through as genuinely empty.
tab_snapshot() {
  local config_file="$1"
  local index="$2"
  jq -j --argjson idx "$index" '
    (.urls | length) as $n
    | if $idx < $n then
        [$n, .urls[$idx].url, (.urls[$idx].duration | tostring), (.urls[$idx].cycles | tostring)]
      else
        [$n, "", "0", "0"]
      end
    | join("\u001f")
  ' "$config_file" | tr -d '\r'
  echo
}

should_refresh() {
  local count="$1"
  local target="$2"
  if [[ "$target" -le 0 ]]; then
    return 1
  fi
  [[ "$count" -ge "$target" ]]
}

next_tab_index() {
  local current="$1"
  local total="$2"
  echo $(( (current + 1) % total ))
}
