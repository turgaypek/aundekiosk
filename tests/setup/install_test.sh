#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

INSTALL_SH="$SCRIPT_DIR/../../scripts/setup/install.sh"

# This only exercises the very first check (resolving PI_USER), which exits
# before any apt-get/useradd/systemctl call — safe to run directly, unlike
# the rest of install.sh (see spec §11: real execution is Pi-only).
output=$(env -u SUDO_USER bash "$INSTALL_SH" 2>&1)
status=$?

assert_status 1 "$status" "install.sh exits non-zero when no user can be resolved"

case "$output" in
  *"unbound variable"*)
    assert_eq "friendly error" "unbound variable crash" "install.sh prints its own error message, not a raw 'unbound variable' crash"
    ;;
  *"Could not determine target user"*)
    assert_eq "friendly error" "friendly error" "install.sh prints its own error message, not a raw 'unbound variable' crash"
    ;;
  *)
    assert_eq "friendly error" "unexpected output: $output" "install.sh prints its own error message, not a raw 'unbound variable' crash"
    ;;
esac

# The dashboard's one npm dependency must be pre-cached (with its lock
# file, for integrity) during install, while there's still network access
# and before the --cached-only service unit would otherwise fail to start.
grep -q "deno cache" "$INSTALL_SH"
assert_status 0 $? "install.sh pre-caches the dashboard's Deno dependencies"

grep -q -- "--lock=" "$INSTALL_SH"
assert_status 0 $? "install.sh verifies the cached dependency against deno.lock"

# snmpd must be installed so the SNMPv3 privileged helper (Plan 4) has
# something to configure and enable.
grep -qE "^apt-get install -y .*\bsnmpd\b" "$INSTALL_SH"
assert_status 0 $? "install.sh installs the snmpd package"

# Final review (Important I4): the SNMPv3 source-restriction firewall
# rule depends on iptables, which isn't guaranteed to be preinstalled.
grep -qE "^apt-get install -y .*\biptables\b" "$INSTALL_SH"
assert_status 0 $? "install.sh installs the iptables package"

# change-os-password.sh (Plan 4) refuses to act on any username other
# than the one recorded here at install time — this is what makes that
# refusal possible, not a config the dashboard can influence at runtime.
grep -q "pi-user.txt" "$INSTALL_SH"
assert_status 0 $? "install.sh records the target user for change-os-password.sh"

# Final review (Critical C2): the whole-tree "chown -R aundekiosk:aundekiosk
# $AUNDEKIOSK_INSTALL_DIR" hands ownership of EVERYTHING under
# /opt/aundekiosk to the dashboard's own unprivileged user. Writing
# pi-user.txt (or the network rollback backup) under that same tree means
# a compromised dashboard process could simply overwrite
# "pi-user.txt" with "root" and then use the already-whitelisted
# change-os-password.sh to set root's password — the "one recorded
# username" restriction would be entirely cosmetic. Both files must live
# in a directory the dashboard user never owns and can never write to.
grep -qE "pi-user\.txt.*AUNDEKIOSK_PRIV_DIR|AUNDEKIOSK_PRIV_DIR.*pi-user\.txt" "$INSTALL_SH"
assert_status 0 $? "install.sh writes pi-user.txt into the root-owned privileged-state directory, not the dashboard-owned tree"

grep -qE "install -d -m 0700 -o root -g root \"\\\$AUNDEKIOSK_PRIV_DIR\"" "$INSTALL_SH"
assert_status 0 $? "install.sh creates the privileged-state directory as root-owned, mode 0700"

# The order matters: the directory and its root-owned contents must be
# created BEFORE the blanket chown, and the chown must never reach back
# over it (the directory lives outside $AUNDEKIOSK_INSTALL_DIR entirely,
# so the existing "chown -R ... $AUNDEKIOSK_INSTALL_DIR" line cannot touch
# it either way, but this pins "it is created" positively rather than by
# the absence of a mistake).
grep -q "AUNDEKIOSK_PRIV_DIR" "$SCRIPT_DIR/../../scripts/setup/common.sh"
assert_status 0 $? "common.sh defines AUNDEKIOSK_PRIV_DIR"

# install.sh now doubles as the update script (re-run after `git pull`):
# on an update, SUDO_USER may be whichever admin ran the pull, not the
# original target user recorded at first install — the already-recorded
# file must win, or an update could silently change which OS account
# change-os-password.sh is allowed to target.
grep -qE 'if \[ -f "\$AUNDEKIOSK_PRIV_DIR/pi-user\.txt" \]' "$INSTALL_SH"
assert_status 0 $? "install.sh prefers an already-recorded pi-user.txt over SUDO_USER on a re-run"

# The repo is cloned directly into $AUNDEKIOSK_INSTALL_DIR and `git pull`
# is how updates are fetched (scripts/setup/update.sh). The blanket
# "chown -R aundekiosk:aundekiosk" must not reach .git, or a later
# `git pull` run as root (inside update.sh, via sudo) would fight git's
# dubious-ownership checks against a non-root-owned .git.
grep -qE 'chown -R root:root "\$AUNDEKIOSK_INSTALL_DIR/\.git"' "$INSTALL_SH"
assert_status 0 $? "install.sh keeps .git root-owned so a root-run git pull never hits a dubious-ownership error"

# `systemctl start` on an already-active unit is a no-op — it would
# never pick up a changed service file or new server.ts code on an
# update. `restart` is a no-op-equivalent on a fresh install (nothing
# was running yet) and actually reloads on an update.
grep -qE '^systemctl restart aundekiosk-dashboard\.service aundekiosk-monitor\.service$' "$INSTALL_SH"
assert_status 0 $? "install.sh restarts (not just starts) the dashboard/monitor services, so an update actually takes effect"

# Found on the real Pi: the dashboard's UMask=0077 makes any config.json it
# writes mode 600 (aundekiosk-only), unreadable by the "pi" user that runs
# the kiosk display — config_api.ts's handlePost now chmods its own writes
# to 0644, but a Pi that already hit this bug (before that fix shipped) has
# a 600 config.json sitting on disk that no future dashboard write will ever
# touch again until the user changes something. update.sh re-runs
# install.sh, so this must self-heal on every update, not just fresh installs.
grep -qE 'chmod 644 "\$AUNDEKIOSK_CONFIG_FILE"' "$INSTALL_SH"
assert_status 0 $? "install.sh self-heals an already-broken (mode 600) config.json back to world-readable"

UPDATE_SH="$SCRIPT_DIR/../../scripts/setup/update.sh"
[[ -f "$UPDATE_SH" ]]
assert_status 0 $? "scripts/setup/update.sh exists"

grep -q "git pull" "$UPDATE_SH" 2>/dev/null
assert_status 0 $? "update.sh pulls the latest commits before re-running install.sh"

grep -q "install.sh" "$UPDATE_SH" 2>/dev/null
assert_status 0 $? "update.sh re-runs install.sh after pulling, reusing its idempotent setup logic rather than duplicating it"

# Verified against a real `git pull` run as root: git's dubious-ownership
# check looks at the WORKING TREE root ($AUNDEKIOSK_INSTALL_DIR itself,
# deliberately aundekiosk-owned so the dashboard can write config.json),
# not just .git — so keeping .git root-owned alone was not enough; a real
# `sudo bash update.sh` still failed with "detected dubious ownership"
# until this exception was added.
grep -qE 'git config --global --add safe\.directory "\$AUNDEKIOSK_INSTALL_DIR"' "$UPDATE_SH" 2>/dev/null
assert_status 0 $? "update.sh adds a git safe.directory exception for the aundekiosk-owned working tree before pulling"

# Verified against a real `git pull` on the deployed Pi: install.sh's own
# "chmod +x privileged/*.sh" flips the executable bit on any script that
# wasn't already committed as executable (e.g. lib.sh, a sourced library,
# never meant to be run directly). Git tracks that bit as part of a
# file's tracked state, so the very first install already leaves the
# working tree "locally modified" relative to the commit it came from —
# and the next `git pull` that touches that same file refuses with
# "Your local changes ... would be overwritten by merge", even though
# nothing a human would call a real edit ever happened.
grep -qE 'git .*config.* core\.fileMode false' "$UPDATE_SH" 2>/dev/null
assert_status 0 $? "update.sh tells git to ignore file-mode (executable-bit) changes, which install.sh's own chmod would otherwise cause"

# Deno has no official build for 32-bit ARM (armv6l/armv7l) — only
# Linux x64 and Linux aarch64. Letting install.sh reach the Deno
# install step on a 32-bit Pi (Pi 1, Pi 2, or the original Pi Zero —
# none of which can run a 64-bit OS at all, unlike Pi 3/3+/4/5/Zero 2 W)
# would fail there with a confusing curl/install-script error instead
# of a clear, immediate one.
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/uname" <<'EOF'
#!/usr/bin/env bash
echo "armv7l"
EOF
chmod +x "$FAKE_BIN/uname"

arch_output=$(PATH="$FAKE_BIN:$PATH" env -u SUDO_USER bash "$INSTALL_SH" 2>&1)
arch_status=$?
assert_status 1 "$arch_status" "install.sh exits non-zero on a 32-bit ARM architecture"
case "$arch_output" in
  *"64-bit"*)
    assert_eq "clear 64-bit message" "clear 64-bit message" "install.sh explains the 64-bit requirement instead of failing deep inside the Deno install step"
    ;;
  *)
    assert_eq "clear 64-bit message" "unexpected output: $arch_output" "install.sh explains the 64-bit requirement instead of failing deep inside the Deno install step"
    ;;
esac

# A 64-bit architecture (this dev machine's own real `uname -m`, e.g.
# x86_64) must fall through past the arch check to the next one (user
# resolution) — proving the check does not also reject valid
# architectures. This is the same early-exit path the very first test
# above already exercises, run again here to confirm the new arch
# check sits before it without swallowing non-32-bit-ARM values.
real_arch_output=$(env -u SUDO_USER bash "$INSTALL_SH" 2>&1)
case "$real_arch_output" in
  *"Could not determine target user"*)
    assert_eq "falls through on 64-bit" "falls through on 64-bit" "install.sh does not reject this machine's own (non-32-bit-ARM) architecture"
    ;;
  *)
    assert_eq "falls through on 64-bit" "unexpected output: $real_arch_output" "install.sh does not reject this machine's own (non-32-bit-ARM) architecture"
    ;;
esac
rm -rf "$WORKDIR"

# Found live: Chromium's default profile location (~/.config/chromium)
# had grown to 1.7GB of constant SD-card rewrites, since switcher.sh
# cycles pages every few seconds and each one touches the disk cache.
# install.sh must set up a RAM-backed (tmpfs) replacement, sized to the
# board's own RAM (platform/lib.sh's compute_tmpfs_cache_mb), and point
# runner.sh's --user-data-dir there via AUNDEKIOSK_CHROMIUM_CACHE_DIR.
grep -q "source \"\$AUNDEKIOSK_INSTALL_DIR/platform/lib.sh\"" "$INSTALL_SH"
assert_status 0 $? "install.sh sources platform/lib.sh to reach compute_tmpfs_cache_mb/detect_ram_mb"

grep -q "compute_tmpfs_cache_mb" "$INSTALL_SH"
assert_status 0 $? "install.sh sizes the tmpfs cache against this board's detected RAM"

grep -qE "tmpfs[[:space:]]+\\\$AUNDEKIOSK_CHROMIUM_CACHE_DIR[[:space:]]+tmpfs[[:space:]]+size=" "$INSTALL_SH"
assert_status 0 $? "install.sh writes an fstab tmpfs entry for the Chromium cache directory"

# Found live, the morning after this feature shipped: install.sh's own
# "chown PI_USER" only applies at install time. On every *subsequent*
# boot, systemd mounts the tmpfs straight from fstab — with no uid=/gid=
# in that line, a bare "mode=0700" tmpfs comes up owned by root:root, not
# the pi user chromium actually runs as. Chromium couldn't create its
# own SingletonLock file in a directory it doesn't own, crash-looped
# (systemd restart counter past 18) all night, and the kiosk display was
# just stuck on the desktop by the time anyone looked at it in the
# morning. The fstab line itself has to carry the ownership so every
# boot gets it right, not just the one install.sh happens to run during.
grep -qE "tmpfs[[:space:]]+\\\$AUNDEKIOSK_CHROMIUM_CACHE_DIR[[:space:]]+tmpfs[[:space:]]+size=\\\$\\{TMPFS_MB\\}m,mode=0700,uid=\\\$PI_SUID,gid=\\\$PI_SUID" "$INSTALL_SH"
assert_status 0 $? "install.sh's fstab tmpfs entry sets uid=/gid= so a post-reboot automount is owned by the pi user, not root"

# Found live on an update run: a plain `umount` of the Chromium cache
# tmpfs fails with "target is busy" while aundekiosk-runner (chromium)
# is actively using it — under `set -e`, that aborted the rest of
# install.sh entirely, so systemd services were never reinstalled or
# restarted. The kiosk must be stopped just long enough to force the
# remount, then started again once the rest of the script has run —
# never left stopped.
grep -q "STOPPED_KIOSK_FOR_TMPFS_REMOUNT=1" "$INSTALL_SH"
assert_status 0 $? "install.sh stops the kiosk before forcing a remount when a plain umount fails (target busy)"

grep -qE 'systemctl stop aundekiosk-runner\.service aundekiosk-switcher\.service' "$INSTALL_SH"
assert_status 0 $? "install.sh stops aundekiosk-runner/switcher before forcing the busy unmount"

grep -qE 'systemctl start aundekiosk-runner\.service aundekiosk-switcher\.service' "$INSTALL_SH"
assert_status 0 $? "install.sh restarts the kiosk at the end if it was stopped to force the tmpfs remount"

grep -q "mountpoint -q" "$INSTALL_SH"
assert_status 0 $? "install.sh only mounts the tmpfs cache if it isn't already mounted (idempotent re-runs)"

# Long-running kiosks (months of uptime) must not let systemd's own
# journal or the dashboard/monitor's shared audit.log grow unbounded on
# a card that may already be small and slow.
grep -q "SystemMaxUse=" "$INSTALL_SH"
assert_status 0 $? "install.sh caps systemd-journald's on-disk log size"

grep -q "/etc/logrotate.d/aundekiosk" "$INSTALL_SH"
assert_status 0 $? "install.sh installs a logrotate policy for audit.log"

# The recovery tool (sub-project D) is a standalone command, never a
# systemd service — this only installs the wrapper binary, nothing
# that starts automatically.
grep -qE 'install -m 0755 "\$AUNDEKIOSK_INSTALL_DIR/scripts/setup/aundekiosk-recover-wrapper\.sh" /usr/local/bin/aundekiosk-recover' "$INSTALL_SH"
assert_status 0 $? "install.sh installs the aundekiosk-recover wrapper to /usr/local/bin"

# Same reasoning as the existing "privileged/" ownership hardening
# (Critical C2, see the chown -R root:root privileged check above): the
# unprivileged aundekiosk dashboard user must never be able to modify
# code that will later run as root via "sudo aundekiosk-recover".
grep -qE 'chown -R root:root "\$AUNDEKIOSK_INSTALL_DIR/recovery"' "$INSTALL_SH"
assert_status 0 $? "install.sh makes the recovery/ directory root-owned, not dashboard-owned"

grep -qE 'chmod -R go-w "\$AUNDEKIOSK_INSTALL_DIR/recovery"' "$INSTALL_SH"
assert_status 0 $? "install.sh removes group/other write access from the recovery/ directory"

# install.sh must never enable or start a recovery-tool service — it
# has none; this pins the negative as a safety net against someone
# later adding one by mistake.
! grep -qi "aundekiosk-recover.*\.service\|aundekiosk-recovery\.service" "$INSTALL_SH"
assert_status 0 $? "install.sh never installs/enables a systemd service for the recovery tool"

assert_summary
