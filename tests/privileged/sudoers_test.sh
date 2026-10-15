#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

SUDOERS_FILE="$SCRIPT_DIR/../../privileged/sudoers.d/aundekiosk"

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/restart-kiosk-services.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the restart-kiosk-services.sh line"

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/reboot-device.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the reboot-device.sh line"

for line in \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh.sh enable" \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh.sh disable" \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh-password-auth.sh enable" \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-ssh-password-auth.sh disable"; do
  grep -qF "$line" "$SUDOERS_FILE"
  assert_status 0 $? "sudoers file grants the exact line: $line"
done

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/change-os-password.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the change-os-password.sh line"

for line in \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/apply-network-config.sh" \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/confirm-network-config.sh"; do
  grep -qF "$line" "$SUDOERS_FILE"
  assert_status 0 $? "sudoers file grants the exact line: $line"
done

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/configure-snmp.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the configure-snmp.sh line"

for line in \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-vnc.sh enable" \
  "aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-vnc.sh disable"; do
  grep -qF "$line" "$SUDOERS_FILE"
  assert_status 0 $? "sudoers file grants the exact line: $line"
done

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/change-hostname.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the change-hostname.sh line"

for service in aundekiosk-dashboard aundekiosk-monitor aundekiosk-runner aundekiosk-switcher; do
  for action in start stop; do
    line="aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/toggle-service.sh $service $action"
    grep -qF "$line" "$SUDOERS_FILE"
    assert_status 0 $? "sudoers file grants the exact line: $line"
  done
done

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/apt-upgrade.sh start$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the apt-upgrade.sh start line"

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/apt-upgrade.sh run$" "$SUDOERS_FILE"
if [[ $? -eq 0 ]]; then
  assert_eq "not-whitelisted" "whitelisted" "sudoers file must NOT grant 'run' directly — it's only ever reached via 'start''s own systemd-run call, already running as root"
else
  assert_eq "not-whitelisted" "not-whitelisted" "sudoers file must NOT grant 'run' directly — it's only ever reached via 'start''s own systemd-run call, already running as root"
fi

grep -qE '\*|\$\{|\$\(' "$SUDOERS_FILE"
if [[ $? -eq 0 ]]; then
  assert_eq "no-wildcards" "has-wildcards" "sudoers file contains no wildcard or variable-expansion patterns"
else
  assert_eq "no-wildcards" "no-wildcards" "sudoers file contains no wildcard or variable-expansion patterns"
fi

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/manage-reboot-timer.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the manage-reboot-timer.sh line"

if command -v visudo >/dev/null 2>&1; then
  visudo -c -f "$SUDOERS_FILE" > /tmp/aundekiosk_visudo_check.txt 2>&1
  assert_status 0 $? "sudoers file passes visudo syntax check"
else
  echo "SKIP - visudo not available on this machine; this will be validated for real on the target Raspberry Pi during install."
fi

assert_summary
