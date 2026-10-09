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

extract_urls_from_config() {
  local config_file="$1"
  jq -r '.urls | map(.url) | join(" ")' "$config_file"
}

extract_durations_from_config() {
  local config_file="$1"
  jq -r '.urls[].duration' "$config_file"
}

extract_cycles_from_config() {
  local config_file="$1"
  jq -r '.urls[].cycles' "$config_file"
}

has_urls() {
  local config_file="$1"
  local count
  count=$(jq -r '.urls | length' "$config_file")
  [[ "$count" -gt 0 ]]
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
