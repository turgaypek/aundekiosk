#!/usr/bin/env bash
# Convenience wrapper: lets an admin type "sudo aundekiosk-update" from
# anywhere instead of the full path below. update.sh already does the
# real work (git pull + re-run install.sh); this adds nothing of its
# own, including no root check — update.sh already refuses to run as
# anyone but root.
set -euo pipefail

exec bash /opt/aundekiosk/scripts/setup/update.sh "$@"
