#!/usr/bin/env bash
# Pure, side-effect-free input validators shared by every SSH/network/SNMP
# privileged helper. Every helper that reads dashboard-supplied data
# validates it with one of these before ever using it in an nmcli/systemctl
# call — never eval, never a shell-interpolated string (spec §5.1, §8.4).

is_valid_interface() {
  [[ "$1" == "eth0" || "$1" == "wlan0" ]]
}

is_valid_network_mode() {
  [[ "$1" == "dhcp" || "$1" == "static" ]]
}

is_valid_ipv4() {
  local ip="$1"
  [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  local IFS='.'
  local octets=($ip)
  for octet in "${octets[@]}"; do
    [[ "$octet" -le 255 ]] || return 1
  done
  return 0
}

is_valid_cidr() {
  local cidr="$1"
  [[ "$cidr" =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
  local ip="${BASH_REMATCH[1]}"
  local prefix="${BASH_REMATCH[2]}"
  is_valid_ipv4 "$ip" || return 1
  [[ "$prefix" -ge 0 && "$prefix" -le 32 ]]
}

# IEEE 802.11 allows an SSID of 1-32 bytes.
is_valid_wifi_ssid() {
  local ssid="$1"
  local len=${#ssid}
  [[ "$len" -ge 1 && "$len" -le 32 ]]
}

# WPA2/WPA3-PSK passphrases are 8-63 characters.
is_valid_wifi_password() {
  local password="$1"
  local len=${#password}
  [[ "$len" -ge 8 && "$len" -le 63 ]]
}

is_valid_snmp_username() {
  [[ "$1" =~ ^[A-Za-z0-9_-]{1,32}$ ]]
}

is_valid_snmp_auth_protocol() {
  [[ "$1" == "SHA" || "$1" == "SHA-256" ]]
}

is_valid_snmp_priv_protocol() {
  [[ "$1" == "AES" ]]
}

# A secret that gets piped into another program's line-oriented
# input/config (chpasswd's "user:pass" line, snmpd.conf's createUser
# line) must never contain a newline or carriage return — otherwise it
# smuggles a second line past every length/format check on the field
# itself (final review: Critical C1/C3).
is_safe_secret_value() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]]
}
