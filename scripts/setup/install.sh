#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "$SCRIPT_DIR/common.sh"

msg "$INFO" "Starting AundeKiosk installation..."

# This script doubles as the update path (update.sh re-runs it after
# `git pull`). On an update, SUDO_USER is whichever admin happened to run
# it, not necessarily the original target user — the already-recorded
# file wins, so an update can never silently change which OS account
# change-os-password.sh is allowed to target. An explicit argument still
# overrides, for intentionally re-pointing an existing install. This read
# happens before the directory below is (re-)created, so a first-ever
# install (no directory yet) safely falls through to SUDO_USER.
if [ -n "${1:-}" ]; then
    PI_USER="$1"
elif [ -f "$AUNDEKIOSK_PRIV_DIR/pi-user.txt" ]; then
    PI_USER=$(cat "$AUNDEKIOSK_PRIV_DIR/pi-user.txt")
else
    PI_USER="${SUDO_USER:-}"
fi
if [ -z "$PI_USER" ]; then
    msg "$ERROR" "Could not determine target user. Ensure SUDO_USER is set."
    exit 1
fi
msg "$SUCCESS" "Target user identified as '$PI_USER'."

msg "$INFO" "Creating the root-owned privileged-state directory..."
install -d -m 0700 -o root -g root "$AUNDEKIOSK_PRIV_DIR"

msg "$INFO" "Recording the target user for OS password changes..."
echo "$PI_USER" > "$AUNDEKIOSK_PRIV_DIR/pi-user.txt"
chmod 0600 "$AUNDEKIOSK_PRIV_DIR/pi-user.txt"

msg "$INFO" "Installing runtime dependencies (jq, chromium, wtype, xdotool, deno, snmpd, iptables)..."
apt-get update
apt-get install -y jq chromium wtype xdotool openssl snmpd iptables unzip
curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

msg "$INFO" "Creating dedicated 'aundekiosk' system user for the dashboard..."
if ! id -u aundekiosk >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin aundekiosk
fi

msg "$INFO" "Making runtime and privileged scripts executable..."
chmod +x "$AUNDEKIOSK_INSTALL_DIR"/runtime/*.sh "$AUNDEKIOSK_INSTALL_DIR"/privileged/*.sh "$AUNDEKIOSK_INSTALL_DIR"/monitor/*.sh

msg "$INFO" "Setting up configuration file..."
if [ ! -f "$AUNDEKIOSK_CONFIG_FILE" ]; then
    cp "$AUNDEKIOSK_INSTALL_DIR/config.json.sample" "$AUNDEKIOSK_CONFIG_FILE"
    msg "$DEBUG" "Created default config.json from sample."
fi

msg "$INFO" "Setting up resource monitor configuration..."
AUNDEKIOSK_MONITOR_CONFIG_FILE="$AUNDEKIOSK_INSTALL_DIR/monitor-config.json"
if [ ! -f "$AUNDEKIOSK_MONITOR_CONFIG_FILE" ]; then
    cp "$AUNDEKIOSK_INSTALL_DIR/monitor-config.json.sample" "$AUNDEKIOSK_MONITOR_CONFIG_FILE"
    msg "$DEBUG" "Created default monitor-config.json from sample."
fi

msg "$INFO" "Generating the self-signed TLS certificate (if one doesn't exist yet)..."
bash "$AUNDEKIOSK_INSTALL_DIR/scripts/setup/generate-tls-cert.sh" "$AUNDEKIOSK_INSTALL_DIR/tls"

msg "$INFO" "Pre-caching the dashboard's Deno dependencies (so the service never has to reach the network at startup)..."
# DENO_DIR lives under the install tree (not a user $HOME) because the
# 'aundekiosk' service user has none (--no-create-home); the chown below
# hands this directory to it along with everything else. --lock verifies
# the one pinned dependency's integrity hash instead of trusting whatever
# the registry serves at cache time.
DENO_DIR="$AUNDEKIOSK_INSTALL_DIR/.deno" /usr/local/bin/deno cache \
    --lock="$AUNDEKIOSK_INSTALL_DIR/dashboard/deno.lock" \
    "$AUNDEKIOSK_INSTALL_DIR/dashboard/server.ts"

msg "$INFO" "Setting directory ownership (aundekiosk owns the install tree so it can write config.json; root reclaims 'privileged' so a dashboard-level bug can never rewrite a script sudo will run as root)..."
chown -R aundekiosk:aundekiosk "$AUNDEKIOSK_INSTALL_DIR"
chown -R root:root "$AUNDEKIOSK_INSTALL_DIR/privileged"
chmod -R go-w "$AUNDEKIOSK_INSTALL_DIR/privileged"
# The repo lives directly at $AUNDEKIOSK_INSTALL_DIR and update.sh's
# `git pull` runs as root (via sudo), right before it re-execs this
# script. Keeping .git root-owned avoids git's dubious-ownership
# refusal that the blanket chown above would otherwise trigger.
if [ -d "$AUNDEKIOSK_INSTALL_DIR/.git" ]; then
    chown -R root:root "$AUNDEKIOSK_INSTALL_DIR/.git"
fi

msg "$INFO" "Installing the privileged helper whitelist (sudoers)..."
SUDOERS_SRC="$AUNDEKIOSK_INSTALL_DIR/privileged/sudoers.d/aundekiosk"
SUDOERS_DST="/etc/sudoers.d/aundekiosk"
if ! visudo -c -f "$SUDOERS_SRC"; then
    msg "$ERROR" "Sudoers whitelist failed syntax validation. Aborting before install."
    exit 1
fi
install -m 0440 "$SUDOERS_SRC" "$SUDOERS_DST"

msg "$INFO" "Installing systemd services..."
PI_HOME=$(getent passwd "$PI_USER" | cut -d: -f6)
PI_SUID=$(id -u "$PI_USER")

sed -e "s|PI_HOME|$PI_HOME|g" -e "s|PI_SUID|$PI_SUID|g" -e "s|PI_USER|$PI_USER|g" \
    "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-runner.service.template" > /etc/systemd/system/aundekiosk-runner.service

sed -e "s|PI_HOME|$PI_HOME|g" -e "s|PI_SUID|$PI_SUID|g" -e "s|PI_USER|$PI_USER|g" \
    "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-switcher.service.template" > /etc/systemd/system/aundekiosk-switcher.service

cp "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-dashboard.service.template" /etc/systemd/system/aundekiosk-dashboard.service
cp "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-monitor.service.template" /etc/systemd/system/aundekiosk-monitor.service

msg "$INFO" "Reloading systemd and enabling services..."
systemctl daemon-reload
systemctl enable aundekiosk-runner.service aundekiosk-switcher.service aundekiosk-dashboard.service aundekiosk-monitor.service
# restart, not start: on a fresh install nothing is running yet, so this
# behaves identically to start; on an update (update.sh re-running this
# script after `git pull`) it's the only way the already-running
# services actually pick up new code or a changed unit file.
systemctl restart aundekiosk-dashboard.service aundekiosk-monitor.service

echo
msg "$CALLOUT" "AundeKiosk is now installed."
echo -e "Dashboard: ${SUCCESS}https://$(hostname -I | cut -d ' ' -f 1):8080/${RESET}"
msg "$WARNING" "The TLS certificate is self-signed — your browser will warn about it once; this is expected for a LAN-only kiosk tool."
msg "$WARNING" "Kiosk mode will launch on the next startup."
