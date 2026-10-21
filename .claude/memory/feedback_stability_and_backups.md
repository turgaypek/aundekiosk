---
name: feedback-stability-and-backups
description: "Stability-first rule: backup before every change, test on all Pi models and 32/64-bit, keep it smooth"
metadata:
  type: feedback
---

Before any code change: always create a git checkpoint commit or ensure the working tree is clean and committed first, so the stable baseline is recoverable.

- **Backup before every change** — tag or commit the current stable state before touching anything.
- **Cross-Pi compatibility** — every change must work on all Raspberry Pi models (Pi 3, Pi 4, Pi 5) and both 32-bit (armhf) and 64-bit (arm64/aarch64) Raspberry Pi OS Bookworm.
- **Smooth and stable** — no regressions; if a change risks breaking existing behavior, test scope must cover all affected code paths first.
- **Don't break what's working** — when in doubt, do less. Stability over features.

**Why:** The system is currently in active testing across real Pi hardware. A regression means a kiosk goes down in production.

**How to apply:** At the start of any change session, check `git status` and `git log --oneline -5`. If current HEAD is the stable baseline, note the commit hash. For risky changes, create a `git tag stable-YYYYMMDD` before touching code. For cross-arch concerns, flag any arm-specific packages, paths, or flags.
