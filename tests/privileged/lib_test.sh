#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"
source "$SCRIPT_DIR/../../privileged/lib.sh"

# --- is_valid_interface ---
for good in eth0 wlan0; do
  if is_valid_interface "$good"; then
    assert_eq "valid" "valid" "is_valid_interface accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_interface accepts '$good'"
  fi
done
if is_valid_interface "eth1"; then
  assert_eq "invalid" "valid" "is_valid_interface rejects an interface outside eth0/wlan0"
else
  assert_eq "invalid" "invalid" "is_valid_interface rejects an interface outside eth0/wlan0"
fi

# --- is_valid_network_mode ---
for good in dhcp static; do
  if is_valid_network_mode "$good"; then
    assert_eq "valid" "valid" "is_valid_network_mode accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_network_mode accepts '$good'"
  fi
done
if is_valid_network_mode "bridge"; then
  assert_eq "invalid" "valid" "is_valid_network_mode rejects an unknown mode"
else
  assert_eq "invalid" "invalid" "is_valid_network_mode rejects an unknown mode"
fi

# --- is_valid_ipv4 ---
for good in "192.168.1.1" "255.255.255.255" "0.0.0.0"; do
  if is_valid_ipv4 "$good"; then
    assert_eq "valid" "valid" "is_valid_ipv4 accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_ipv4 accepts '$good'"
  fi
done
for bad in "999.1.1.1" "1.2.3" "1.2.3.4.5" "abc.1.1.1" "192.168.1.1; rm -rf /"; do
  if is_valid_ipv4 "$bad"; then
    assert_eq "invalid" "valid" "is_valid_ipv4 rejects '$bad'"
  else
    assert_eq "invalid" "invalid" "is_valid_ipv4 rejects '$bad'"
  fi
done

# --- is_valid_cidr ---
for good in "192.168.1.0/24" "10.0.0.1/32"; do
  if is_valid_cidr "$good"; then
    assert_eq "valid" "valid" "is_valid_cidr accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_cidr accepts '$good'"
  fi
done
for bad in "10.0.0.1/33" "999.1.1.1/24" "192.168.1.0"; do
  if is_valid_cidr "$bad"; then
    assert_eq "invalid" "valid" "is_valid_cidr rejects '$bad'"
  else
    assert_eq "invalid" "invalid" "is_valid_cidr rejects '$bad'"
  fi
done

# --- is_valid_wifi_ssid ---
if is_valid_wifi_ssid "MyNetwork"; then
  assert_eq "valid" "valid" "is_valid_wifi_ssid accepts a normal SSID"
else
  assert_eq "valid" "invalid" "is_valid_wifi_ssid accepts a normal SSID"
fi
if is_valid_wifi_ssid ""; then
  assert_eq "invalid" "valid" "is_valid_wifi_ssid rejects an empty SSID"
else
  assert_eq "invalid" "invalid" "is_valid_wifi_ssid rejects an empty SSID"
fi
TOO_LONG_SSID=$(printf 'a%.0s' $(seq 1 33))
if is_valid_wifi_ssid "$TOO_LONG_SSID"; then
  assert_eq "invalid" "valid" "is_valid_wifi_ssid rejects an SSID over 32 characters"
else
  assert_eq "invalid" "invalid" "is_valid_wifi_ssid rejects an SSID over 32 characters"
fi

# --- is_valid_wifi_password ---
if is_valid_wifi_password "longenough1"; then
  assert_eq "valid" "valid" "is_valid_wifi_password accepts an 11-character password (WPA2 minimum is 8)"
else
  assert_eq "valid" "invalid" "is_valid_wifi_password accepts an 11-character password (WPA2 minimum is 8)"
fi
if is_valid_wifi_password "short12"; then
  assert_eq "invalid" "valid" "is_valid_wifi_password rejects a 7-character password (below WPA2's 8-char minimum)"
else
  assert_eq "invalid" "invalid" "is_valid_wifi_password rejects a 7-character password (below WPA2's 8-char minimum)"
fi
TOO_LONG_PASSWORD=$(printf 'a%.0s' $(seq 1 64))
if is_valid_wifi_password "$TOO_LONG_PASSWORD"; then
  assert_eq "invalid" "valid" "is_valid_wifi_password rejects a password over 63 characters (WPA2/3's maximum)"
else
  assert_eq "invalid" "invalid" "is_valid_wifi_password rejects a password over 63 characters (WPA2/3's maximum)"
fi

# --- is_valid_snmp_username ---
if is_valid_snmp_username "monitor_user-1"; then
  assert_eq "valid" "valid" "is_valid_snmp_username accepts alphanumerics, underscore and hyphen"
else
  assert_eq "valid" "invalid" "is_valid_snmp_username accepts alphanumerics, underscore and hyphen"
fi
if is_valid_snmp_username "bad user"; then
  assert_eq "invalid" "valid" "is_valid_snmp_username rejects a space"
else
  assert_eq "invalid" "invalid" "is_valid_snmp_username rejects a space"
fi
if is_valid_snmp_username ""; then
  assert_eq "invalid" "valid" "is_valid_snmp_username rejects an empty username"
else
  assert_eq "invalid" "invalid" "is_valid_snmp_username rejects an empty username"
fi

# --- is_valid_snmp_auth_protocol / is_valid_snmp_priv_protocol ---
for good in SHA SHA-256; do
  if is_valid_snmp_auth_protocol "$good"; then
    assert_eq "valid" "valid" "is_valid_snmp_auth_protocol accepts '$good'"
  else
    assert_eq "valid" "invalid" "is_valid_snmp_auth_protocol accepts '$good'"
  fi
done
if is_valid_snmp_auth_protocol "MD5"; then
  assert_eq "invalid" "valid" "is_valid_snmp_auth_protocol rejects MD5 (not in the allowed set)"
else
  assert_eq "invalid" "invalid" "is_valid_snmp_auth_protocol rejects MD5 (not in the allowed set)"
fi
if is_valid_snmp_priv_protocol "AES"; then
  assert_eq "valid" "valid" "is_valid_snmp_priv_protocol accepts AES"
else
  assert_eq "valid" "invalid" "is_valid_snmp_priv_protocol accepts AES"
fi
if is_valid_snmp_priv_protocol "DES"; then
  assert_eq "invalid" "valid" "is_valid_snmp_priv_protocol rejects DES (not in the allowed set)"
else
  assert_eq "invalid" "invalid" "is_valid_snmp_priv_protocol rejects DES (not in the allowed set)"
fi


# --- is_safe_secret_value ---
# Final review (Critical C1, C3): a secret with an embedded newline, piped
# into `chpasswd` or written into snmpd's config file, is interpreted as a
# SECOND line — letting an attacker who can submit one validated secret
# field smuggle a second `user:password` pair or a second config directive
# past every other check. Every secret value that gets written into
# another program's line-oriented config/input must be rejected if it
# contains a newline or carriage return.
if is_safe_secret_value "a-normal-password"; then
  assert_eq "valid" "valid" "is_safe_secret_value accepts a normal password"
else
  assert_eq "valid" "invalid" "is_safe_secret_value accepts a normal password"
fi
if is_safe_secret_value $'line-one\nline-two'; then
  assert_eq "invalid" "valid" "is_safe_secret_value rejects an embedded newline"
else
  assert_eq "invalid" "invalid" "is_safe_secret_value rejects an embedded newline"
fi
if is_safe_secret_value $'line-one\rline-two'; then
  assert_eq "invalid" "valid" "is_safe_secret_value rejects an embedded carriage return"
else
  assert_eq "invalid" "invalid" "is_safe_secret_value rejects an embedded carriage return"
fi

assert_summary
