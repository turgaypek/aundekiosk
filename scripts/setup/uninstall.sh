#!/usr/bin/env bash
# Removes AundeKiosk from this Pi — reverses what install.sh did.
# Config, TLS cert, and auth database are deleted with the install
# directory; back them up first if you want to preserve them.
#
# What is NOT removed (too risky to remove blindly):
#   - apt packages: jq, chromium, novnc, ttyd, etc. — may be used elsewhere
#   - Deno installation (/usr/local/bin/deno, /usr/local/.deno)
#   - journald SystemMaxUse= change (non-destructive to leave)
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "$SCRIPT_DIR/common.sh"

CHROMIUM_CACHE_DIR="/var/cache/aundekiosk-chromium"
SERVICES=(
    aundekiosk-dashboard
    aundekiosk-monitor
    aundekiosk-runner
    aundekiosk-switcher
    aundekiosk-tty
    aundekiosk-recovery
)

if [ "$EUID" -ne 0 ]; then
    msg "$ERROR" "uninstall.sh must be run as root (sudo bash /opt/aundekiosk/scripts/setup/uninstall.sh)."
    exit 1
fi

echo
msg "$WARNING" "This will PERMANENTLY remove AundeKiosk from this Pi."
msg "$WARNING" "All data under $AUNDEKIOSK_INSTALL_DIR will be deleted, including:"
msg "$WARNING" "  config.json (display URLs), auth.db (admin accounts), audit.log, TLS certificate."
echo
read -r -p "Type 'uninstall' to confirm: " CONFIRM
if [ "$CONFIRM" != "uninstall" ]; then
    msg "$INFO" "Aborted — nothing changed."
    exit 0
fi
echo

msg "$INFO" "Stopping and disabling AundeKiosk services..."
for svc in "${SERVICES[@]}"; do
    systemctl stop "${svc}.service" 2>/dev/null || true
    systemctl disable "${svc}.service" 2>/dev/null || true
done

msg "$INFO" "Removing systemd unit files..."
for svc in "${SERVICES[@]}"; do
    rm -f "/etc/systemd/system/${svc}.service"
done
systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true

msg "$INFO" "Removing sudoers whitelist..."
rm -f /etc/sudoers.d/aundekiosk

msg "$INFO" "Removing CLI shortcuts..."
rm -f /usr/local/bin/aundekiosk-recover
rm -f /usr/local/bin/aundekiosk-update

msg "$INFO" "Removing logrotate policy..."
rm -f /etc/logrotate.d/aundekiosk

msg "$INFO" "Unmounting and removing Chromium RAM cache..."
if mountpoint -q "$CHROMIUM_CACHE_DIR" 2>/dev/null; then
    umount -f "$CHROMIUM_CACHE_DIR" 2>/dev/null || true
fi
sed -i "\\|^tmpfs[[:space:]]\\+$CHROMIUM_CACHE_DIR[[:space:]]|d" /etc/fstab
rm -rf "$CHROMIUM_CACHE_DIR"

msg "$INFO" "Removing privileged state directory..."
rm -rf "$AUNDEKIOSK_PRIV_DIR"

msg "$INFO" "Removing install directory ($AUNDEKIOSK_INSTALL_DIR)..."
rm -rf "$AUNDEKIOSK_INSTALL_DIR"

msg "$INFO" "Removing 'aundekiosk' system user..."
if id -u aundekiosk >/dev/null 2>&1; then
    userdel aundekiosk 2>/dev/null || true
fi

echo
msg "$SUCCESS" "AundeKiosk has been removed."
msg "$INFO" "Packages installed by AundeKiosk (jq, chromium, novnc, ttyd, …) were left in place."
msg "$INFO" "Run 'sudo apt-get autoremove' if you want to remove unused packages."
