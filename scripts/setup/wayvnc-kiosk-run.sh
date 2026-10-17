#!/bin/sh
# Wrapper for the system wayvnc service on AundeKiosk.
#
# The stock /usr/sbin/wayvnc-run.sh hard-codes XDG_RUNTIME_DIR=/tmp/wayvnc,
# which prevents wayvnc from finding the kiosk user's Wayland socket at
# /run/user/<uid>/wayland-0.  This wrapper keeps all the original logic but
# uses the XDG_RUNTIME_DIR and WAYLAND_DISPLAY injected by the systemd
# drop-in at /etc/systemd/system/wayvnc.service.d/kiosk-display.conf.

. /etc/default/keyboard

# Control socket goes in /tmp/wayvnc so wayvncctl can find it at the
# original path regardless of XDG_RUNTIME_DIR.
mkdir -p /tmp/wayvnc

export XKB_DEFAULT_MODEL="$XKBMODEL"
export XKB_DEFAULT_LAYOUT="$XKBLAYOUT"

# XDG_RUNTIME_DIR and WAYLAND_DISPLAY are set by the systemd drop-in
# so wayvnc finds the kiosk compositor socket: /run/user/<uid>/wayland-0.

SELF_PID=$$

{
    while ! wayvncctl --socket=/tmp/wayvnc/wayvncctl.sock version >/dev/null 2>&1; do
        sleep 0.1
    done
    systemd-notify --ready --pid=$SELF_PID
} &

if ! raspi-config nonint is_pifive 2>/dev/null; then
    export WAYVNC_CMA=/dev/dma_heap/linux,cma
fi

exec wayvnc --detached \
    --config /etc/wayvnc/config \
    --socket /tmp/wayvnc/wayvncctl.sock
