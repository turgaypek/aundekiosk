#!/usr/bin/env bash
# Pulls the latest commits for an already-installed AundeKiosk (cloned
# directly into /opt/aundekiosk) and re-runs install.sh, which is safe
# to re-run: it never recreates the system user or overwrites an
# existing config.json/monitor-config.json, but it DOES refresh
# executable bits, the sudoers whitelist, systemd unit files, cached
# Deno dependencies, and (via install.sh's own restart, not start) the
# running dashboard/monitor services — so a plan's worth of changes
# actually takes effect, not just a `git pull`.
#
# LOCAL MODE (no .git directory): downloads a new package from the
# internal IIS distribution server instead of using git.
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "$SCRIPT_DIR/common.sh"

DIST_URL="http://192.168.6.80/aundekiosk-dist"

if [ "$EUID" -ne 0 ]; then
    msg "$ERROR" "update.sh must be run as root (sudo), same as install.sh."
    exit 1
fi

# Systemd transient units don't set $HOME; git config --global needs it
# to locate ~/.gitconfig. Root's home is always /root.
export HOME="${HOME:-/root}"

local_update() {
    local preserve=(config.json monitor-config.json auth.db audit.log tls videos state)
    local stash="/tmp/aundekiosk-update-stash-$$"

    msg "$INFO" "Local mode: downloading update from $DIST_URL..."

    # Stash preserved files so the tarball extraction does not overwrite them
    mkdir -p "$stash"
    for item in "${preserve[@]}"; do
        if [ -e "$AUNDEKIOSK_INSTALL_DIR/$item" ]; then
            cp -a "$AUNDEKIOSK_INSTALL_DIR/$item" "$stash/"
        fi
    done

    # Download and extract new package
    if ! curl -fsSL --connect-timeout 30 "$DIST_URL/aundekiosk-latest.tar.gz" \
            | tar xz -C "$AUNDEKIOSK_INSTALL_DIR"; then
        msg "$ERROR" "Failed to download update from $DIST_URL — is the distribution server reachable?"
        # Restore preserved files; app code may be partially overwritten
        for item in "${preserve[@]}"; do
            if [ -e "$stash/$item" ]; then
                cp -a "$stash/$item" "$AUNDEKIOSK_INSTALL_DIR/"
            fi
        done
        rm -rf "$stash"
        exit 1
    fi

    # Restore preserved files over the freshly extracted package
    for item in "${preserve[@]}"; do
        if [ -e "$stash/$item" ]; then
            cp -a "$stash/$item" "$AUNDEKIOSK_INSTALL_DIR/"
        fi
    done
    rm -rf "$stash"

    msg "$INFO" "Re-running install.sh to apply the update..."
    export LOCAL_INSTALL=1
    exec bash "$AUNDEKIOSK_INSTALL_DIR/scripts/setup/install.sh" "$@"
}

# Local mode: no git checkout present — download from IIS instead
if [ ! -d "$AUNDEKIOSK_INSTALL_DIR/.git" ]; then
    local_update "$@"
    exit  # exec'd above, but be explicit
fi

# Git mode (original flow) ------------------------------------------------

# Git's dubious-ownership check looks at the WORKING TREE root
# ($AUNDEKIOSK_INSTALL_DIR itself, deliberately owned by aundekiosk so
# the dashboard can write config.json), not just .git — without this,
# `git pull` as root refuses with "detected dubious ownership" even
# though .git itself stays root-owned (install.sh's own defense in
# depth against the dashboard user tampering with history/hooks).
git config --global --add safe.directory "$AUNDEKIOSK_INSTALL_DIR"

# install.sh's own "chmod +x privileged/*.sh" flips the executable bit
# on every privileged script — including ones like lib.sh (a sourced
# library, never committed as executable since it's never run
# directly) whose committed mode has no +x. Git tracks that bit as part
# of the file, so the very first install already leaves this checkout
# "locally modified" relative to its own commit; without this, the next
# pull that touches any of those files refuses with "Your local changes
# ... would be overwritten by merge" — not a real edit, just the mode
# bit install.sh itself is responsible for setting (verified against a
# real `git pull` on the deployed Pi).
git -C "$AUNDEKIOSK_INSTALL_DIR" config core.fileMode false

# Stash any local modifications (mode-bit flips from install.sh, deploy-time
# file edits, untracked files added at runtime) so git pull can fast-forward.
git -C "$AUNDEKIOSK_INSTALL_DIR" stash -u 2>/dev/null || true

msg "$INFO" "Pulling the latest AundeKiosk commits..."
git -C "$AUNDEKIOSK_INSTALL_DIR" pull --ff-only

msg "$INFO" "Re-running install.sh to apply the update..."
exec bash "$AUNDEKIOSK_INSTALL_DIR/scripts/setup/install.sh" "$@"
