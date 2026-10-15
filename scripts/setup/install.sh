#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "$SCRIPT_DIR/common.sh"

msg "$INFO" "Starting AundeKiosk installation..."

# Deno (the dashboard's entire runtime) has no official build for
# 32-bit ARM — only Linux x64 and Linux aarch64. Pi 1, Pi 2 (the
# original, non-"+"), and the original Pi Zero are 32-bit-only chips
# with no 64-bit OS option at all; Pi 3/3+/4/5/Zero 2 W can run either
# OS width, but only the 64-bit image works here. Checking this first
# means a mismatched device/OS fails with one clear message instead of
# a confusing error deep inside the Deno install step below.
ARCH=$(uname -m)
case "$ARCH" in
  armv6l|armv7l)
    msg "$ERROR" "AundeKiosk's dashboard requires a 64-bit OS; Deno has no official build for 32-bit ARM ($ARCH). Re-flash this Pi with the 64-bit Raspberry Pi OS image (Pi 3/3+/4/5/Zero 2 W only — Pi 1, Pi 2, and the original Pi Zero cannot run a 64-bit OS at all and cannot run the dashboard)."
    exit 1
    ;;
esac

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
PI_HOME=$(getent passwd "$PI_USER" | cut -d: -f6)
PI_SUID=$(id -u "$PI_USER")

msg "$INFO" "Creating the root-owned privileged-state directory..."
install -d -m 0700 -o root -g root "$AUNDEKIOSK_PRIV_DIR"

msg "$INFO" "Recording the target user for OS password changes..."
echo "$PI_USER" > "$AUNDEKIOSK_PRIV_DIR/pi-user.txt"
chmod 0600 "$AUNDEKIOSK_PRIV_DIR/pi-user.txt"

msg "$INFO" "Installing runtime dependencies (jq, chromium, wtype, xdotool, deno, snmpd, iptables, novnc)..."
apt-get update
apt-get install -y jq chromium wtype xdotool openssl snmpd iptables unzip novnc unclutter-xfixes
# ttyd is not in Debian Trixie repos; install the prebuilt binary from GitHub.
if ! command -v ttyd &>/dev/null; then
  TTYD_VER="1.7.7"
  TTYD_ARCH=$(uname -m)
  case "$TTYD_ARCH" in
    aarch64) TTYD_BIN="ttyd.aarch64" ;;
    x86_64)  TTYD_BIN="ttyd.x86_64" ;;
    *)       msg "$WARNING" "No prebuilt ttyd binary for $TTYD_ARCH — browser terminal will be unavailable." ; TTYD_BIN="" ;;
  esac
  if [ -n "$TTYD_BIN" ]; then
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VER}/${TTYD_BIN}" -o /usr/local/bin/ttyd
    chmod +x /usr/local/bin/ttyd
    msg "$SUCCESS" "ttyd ${TTYD_VER} installed from GitHub."
  fi
fi
curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

msg "$INFO" "Restricting wayvnc to localhost to prevent direct LAN access to the desktop..."
install -d -m 0700 -o "$PI_USER" -g "$PI_USER" "$PI_HOME/.config/wayvnc"
cat > "$PI_HOME/.config/wayvnc/config" << 'EOF'
address=127.0.0.1
EOF
chown "$PI_USER:$PI_USER" "$PI_HOME/.config/wayvnc/config"
chmod 0600 "$PI_HOME/.config/wayvnc/config"
msg "$WARNING" "wayvnc restriction written. A running wayvnc session must be restarted (or the Pi rebooted) for the bind-address change to take effect."

msg "$INFO" "Installing the TTY service (browser terminal access via ttyd)..."
cp "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-tty.service.template" /etc/systemd/system/aundekiosk-tty.service

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
# Self-heal a config.json left mode 600 by the dashboard's UMask=0077
# before config_api.ts's handlePost started chmodding its own writes to
# 0644 — otherwise a Pi that already hit this bug stays broken until the
# dashboard happens to rewrite the file again. Safe on every run: config.json
# holds no secrets, only display URLs/durations.
if [ -f "$AUNDEKIOSK_CONFIG_FILE" ]; then
    chmod 644 "$AUNDEKIOSK_CONFIG_FILE"
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

msg "$INFO" "Setting directory ownership (aundekiosk owns the install tree so it can write config.json; root reclaims 'privileged' and 'recovery' so a dashboard-level bug can never rewrite a script sudo/root will run)..."
chown -R aundekiosk:aundekiosk "$AUNDEKIOSK_INSTALL_DIR"
chown -R root:root "$AUNDEKIOSK_INSTALL_DIR/privileged"
chmod -R go-w "$AUNDEKIOSK_INSTALL_DIR/privileged"
chown -R root:root "$AUNDEKIOSK_INSTALL_DIR/recovery"
chmod -R go-w "$AUNDEKIOSK_INSTALL_DIR/recovery"
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

msg "$INFO" "Installing the aundekiosk-recover command (standalone password-recovery tool; never installed as a service)..."
install -m 0755 "$AUNDEKIOSK_INSTALL_DIR/scripts/setup/aundekiosk-recover-wrapper.sh" /usr/local/bin/aundekiosk-recover

msg "$INFO" "Installing the aundekiosk-update command (shorthand for update.sh)..."
install -m 0755 "$AUNDEKIOSK_INSTALL_DIR/scripts/setup/aundekiosk-update-wrapper.sh" /usr/local/bin/aundekiosk-update

# Found live: Chromium's default profile (~/.config/chromium) had grown
# to 1.7GB on the SD card, rewritten constantly as switcher.sh cycles
# pages every few seconds — exactly the write pattern that wears out or
# stalls a slower card. A kiosk showing fixed public URLs never needs
# that profile to survive a reboot, so a RAM-backed tmpfs (sized to this
# board's own RAM, never a fixed size that could strain a low-RAM board)
# is strictly better here, not just a workaround.
msg "$INFO" "Setting up a RAM-backed cache for Chromium's profile, sized to this board's RAM..."
source "$AUNDEKIOSK_INSTALL_DIR/platform/lib.sh"
AUNDEKIOSK_CHROMIUM_CACHE_DIR="/var/cache/aundekiosk-chromium"
TMPFS_MB=$(compute_tmpfs_cache_mb "$(detect_ram_mb)")
install -d -m 0700 -o "$PI_USER" -g "$PI_USER" "$AUNDEKIOSK_CHROMIUM_CACHE_DIR"
# Self-heals a line an earlier version of this script could have left
# behind without uid=/gid= — without them, a tmpfs mounted straight from
# fstab (as every reboot's automount does) comes up owned by root, not
# PI_USER, and chromium can't create its own profile lock file there
# (found live: crash-looped all night, kiosk stuck on the desktop by
# morning). Always rewriting the line, not just adding it when absent,
# means a previously-broken line gets corrected on the next update, too.
sed -i "\\|^tmpfs[[:space:]]\\+$AUNDEKIOSK_CHROMIUM_CACHE_DIR[[:space:]]|d" /etc/fstab
echo "tmpfs $AUNDEKIOSK_CHROMIUM_CACHE_DIR tmpfs size=${TMPFS_MB}m,mode=0700,uid=$PI_SUID,gid=$PI_SUID 0 0" >> /etc/fstab
# Found live, on an update run: chromium (under aundekiosk-runner) was
# actively using the existing mount, so a plain `umount` failed with
# "target is busy" and — under `set -e` — aborted the rest of install.sh
# entirely (systemd services never got reinstalled or restarted). If a
# plain unmount fails, the kiosk is stopped just long enough to force it,
# then restarted once the rest of this script (including the services
# restart below) has run.
STOPPED_KIOSK_FOR_TMPFS_REMOUNT=0
if mountpoint -q "$AUNDEKIOSK_CHROMIUM_CACHE_DIR"; then
    if ! umount "$AUNDEKIOSK_CHROMIUM_CACHE_DIR" 2>/dev/null; then
        systemctl stop aundekiosk-runner.service aundekiosk-switcher.service 2>/dev/null || true
        STOPPED_KIOSK_FOR_TMPFS_REMOUNT=1
        umount "$AUNDEKIOSK_CHROMIUM_CACHE_DIR"
    fi
fi
mount "$AUNDEKIOSK_CHROMIUM_CACHE_DIR"
chown "$PI_USER:$PI_USER" "$AUNDEKIOSK_CHROMIUM_CACHE_DIR"

# A kiosk left running for months must not let its own logs quietly fill
# up a card that may already be small and slow.
msg "$INFO" "Capping systemd-journald's on-disk log size..."
if ! grep -q "^SystemMaxUse=" /etc/systemd/journald.conf; then
    sed -i '/^\[Journal\]/a SystemMaxUse=50M' /etc/systemd/journald.conf
fi
systemctl restart systemd-journald

msg "$INFO" "Installing a logrotate policy for audit.log (shared by the dashboard and the resource monitor)..."
cat > /etc/logrotate.d/aundekiosk <<EOF
$AUNDEKIOSK_INSTALL_DIR/audit.log {
    size 5M
    rotate 4
    compress
    missingok
    notifempty
    create 0600 aundekiosk aundekiosk
}
EOF

msg "$INFO" "Installing systemd services..."

sed -e "s|PI_HOME|$PI_HOME|g" -e "s|PI_SUID|$PI_SUID|g" -e "s|PI_USER|$PI_USER|g" \
    "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-runner.service.template" > /etc/systemd/system/aundekiosk-runner.service

sed -e "s|PI_HOME|$PI_HOME|g" -e "s|PI_SUID|$PI_SUID|g" -e "s|PI_USER|$PI_USER|g" \
    "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-switcher.service.template" > /etc/systemd/system/aundekiosk-switcher.service

cp "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-dashboard.service.template" /etc/systemd/system/aundekiosk-dashboard.service
cp "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-monitor.service.template" /etc/systemd/system/aundekiosk-monitor.service
cp "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-recovery.service.template" /etc/systemd/system/aundekiosk-recovery.service

msg "$INFO" "Reloading systemd and enabling services..."
systemctl daemon-reload
systemctl enable aundekiosk-runner.service aundekiosk-switcher.service aundekiosk-dashboard.service aundekiosk-monitor.service aundekiosk-tty.service
# restart, not start: on a fresh install nothing is running yet, so this
# behaves identically to start; on an update (update.sh re-running this
# script after `git pull`) it's the only way the already-running
# services actually pick up new code or a changed unit file.
systemctl restart aundekiosk-dashboard.service aundekiosk-monitor.service aundekiosk-tty.service

if [[ "$STOPPED_KIOSK_FOR_TMPFS_REMOUNT" -eq 1 ]]; then
    msg "$INFO" "Restarting the kiosk display (stopped earlier to force the corrected Chromium cache mount)..."
    systemctl start aundekiosk-runner.service aundekiosk-switcher.service
fi

echo
msg "$CALLOUT" "AundeKiosk is now installed."
echo -e "Dashboard: ${SUCCESS}https://$(hostname -I | cut -d ' ' -f 1):8080/${RESET}"
msg "$WARNING" "The TLS certificate is self-signed — your browser will warn about it once; this is expected for a LAN-only kiosk tool."
msg "$WARNING" "Kiosk mode will launch on the next startup."
