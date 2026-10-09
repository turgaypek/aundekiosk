# AundeKiosk Plan 3 — Resource Monitor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CPU/RAM threshold monitor that samples `/proc/stat` and `/proc/meminfo`, runs a kademeli (tiered) hysteresis + cooldown state machine per spec §7, triggers `restart_services`/`reboot` only through Plan 1's privileged-helper pattern (never `systemctl`/`reboot` directly), audit-logs every trigger, and exposes its tier configuration to the dashboard behind Plan 2's session auth.

**Architecture:** Pure, side-effect-free bash functions (`monitor/lib.sh`) implement the measurement formulas and the hysteresis/cooldown/multi-tier-resolution decision logic, each independently fixture-tested — same pattern as `platform/lib.sh` in Plan 1. A new daemon script (`monitor/resource-monitor.sh`) owns the untested orchestration loop (sampling, sleeping, calling the privileged helpers via `sudo`), mirroring `runtime/switcher.sh`'s split between tested decisions and untested I/O. The dashboard gets one more authenticated JSON endpoint (`/monitor-config`), built exactly like Plan 1's `/config` + Plan 2's session gate.

**Tech Stack:** Bash (`monitor/lib.sh`, `monitor/resource-monitor.sh`) + `jq` (unchanged from Plan 1), Deno/TypeScript for the dashboard endpoint (unchanged from Plan 1/2).

**Spec:** [docs/superpowers/specs/2026-10-09-aundekiosk-design.md](../specs/2026-10-09-aundekiosk-design.md) (section 7, and section 5.1/8.4's privileged-helper principle)

## Global Constraints

- **CPU%** formula: `Δbusy / Δtotal × 100` between two `/proc/stat` samples — never an instantaneous reading, never `/proc/loadavg`. (Spec §7.1)
- **RAM%** formula: `(MemTotal - MemAvailable) / MemTotal × 100` — never `MemFree`. (Spec §7.1)
- Tier shape: `{ threshold, sustained_samples, action, cooldown }`; `action` is one of `log` | `restart_services` | `reboot`. (Spec §7.2)
- Hysteresis: value ≥ threshold → increment; value < threshold − 2 points → reset to 0; in between → hold steady (spec is silent on the middle band, but "hold" is the only reading consistent with both stated rules not contradicting each other). (Spec §7.3)
- If multiple tiers trigger in the same cycle, **only the single harshest action** (`reboot` > `restart_services` > `log`) runs. (Spec §7.3)
- Every trigger is audit-logged (metric, value, threshold, action, timestamp), **always in English**. (Spec §7.3, §6, §9)
- Outside the configured monitoring window, **no measurement or action** happens at all — the window gates *whether* a cycle runs, not *which* action a tier takes. (Spec §7.4)
- `restart_services`/`reboot` are triggered **only** through Plan 1's privileged helpers (`restart-kiosk-services.sh`, a new `reboot-device.sh`) via the existing `sudoers` whitelist — the monitor never calls `systemctl`/`reboot` directly. (Spec §7.5, §5.1)
- Dashboard-supplied data is never interpolated into a shell string; the config API validates with a fixed shape/enum, same as Plan 1/2. (Spec §5.1, §8.4)

## Review Focus

- CPU/RAM oscillating right at a tier's threshold does not repeatedly reset the sustained-sample counter to 0 — the 2-point hysteresis band holds the count steady instead — Task 2.
- Two tiers triggering in the same cycle (e.g. CPU crosses 80% and RAM crosses 90% together) result in exactly **one** action (the harsher one), not both actions running — Task 2.
- A tier already in its cooldown window does not re-trigger even if the threshold is crossed again — Task 2.
- Outside the configured monitoring window, a threshold breach produces **no** action and **no** audit entry — Task 2.
- `/monitor-config` is gated by Plan 2's session auth exactly like `/config` — a request with no/invalid session never reads or writes tier data — Task 4.

---

### Task 1: CPU/RAM Measurement & Audit Logging (`monitor/lib.sh`)

**Files:**
- Create: `monitor/lib.sh`
- Test: `tests/monitor/lib_test.sh`

**Interfaces:**
- Produces: `compute_cpu_percent(prev_stat_file, curr_stat_file)` → stdout: CPU% as a decimal string (e.g. `75.00`); `compute_ram_percent(meminfo_file)` → stdout: RAM% as a decimal string; `append_monitor_audit_event(log_path, event, metric, value, threshold, action)` → appends one English JSON line

- [ ] **Step 1: Başarısız olacak testi yaz**

`tests/monitor/lib_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"
source "$SCRIPT_DIR/../../monitor/lib.sh"

FIXTURES="$SCRIPT_DIR/fixtures"
mkdir -p "$FIXTURES"

# --- compute_cpu_percent ---
# prev: busy=1000+50+200+5+10+0=1265, idle=8000+30=8030, total=9295
# curr: busy=1100+50+250+5+10+0=1415, idle=8050+30=8080, total=9495
# delta busy=150, delta total=200 -> 75.00%
cat > "$FIXTURES/stat_prev.txt" <<'EOF'
cpu  1000 50 200 8000 30 5 10 0 0 0
cpu0 500 25 100 4000 15 2 5 0 0 0
intr 12345
EOF
cat > "$FIXTURES/stat_curr.txt" <<'EOF'
cpu  1100 50 250 8050 30 5 10 0 0 0
cpu0 550 25 125 4025 15 2 5 0 0 0
intr 12400
EOF
result=$(compute_cpu_percent "$FIXTURES/stat_prev.txt" "$FIXTURES/stat_curr.txt")
assert_eq "75.00" "$result" "compute_cpu_percent computes the delta-based CPU percentage"

# No time has passed (identical snapshots) -> 0%, not a division error.
result=$(compute_cpu_percent "$FIXTURES/stat_prev.txt" "$FIXTURES/stat_prev.txt")
assert_eq "0.00" "$result" "compute_cpu_percent returns 0.00 when delta_total is zero (identical snapshots)"

# --- compute_ram_percent ---
# (4050000 - 1012500) / 4050000 * 100 = 75.00
cat > "$FIXTURES/meminfo.txt" <<'EOF'
MemTotal:        4050000 kB
MemFree:          120000 kB
MemAvailable:    1012500 kB
EOF
result=$(compute_ram_percent "$FIXTURES/meminfo.txt")
assert_eq "75.00" "$result" "compute_ram_percent uses MemAvailable, not MemFree"

# --- append_monitor_audit_event ---
AUDIT_LOG="$FIXTURES/audit.log"
rm -f "$AUDIT_LOG"
append_monitor_audit_event "$AUDIT_LOG" "threshold_triggered" "cpu" "82.5" "80" "restart_services"
line=$(cat "$AUDIT_LOG")
echo "$line" | jq -e '.event == "threshold_triggered"' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the event name"
echo "$line" | jq -e '.metric == "cpu"' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the metric"
echo "$line" | jq -e '.value == 82.5' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the numeric value"
echo "$line" | jq -e '.threshold == 80' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the numeric threshold"
echo "$line" | jq -e '.action == "restart_services"' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes the action"
echo "$line" | jq -e '.timestamp | type == "string"' > /dev/null
assert_status 0 $? "append_monitor_audit_event writes a timestamp"

append_monitor_audit_event "$AUDIT_LOG" "threshold_triggered" "ram" "91" "90" "reboot"
line_count=$(wc -l < "$AUDIT_LOG")
assert_eq "2" "$line_count" "append_monitor_audit_event appends, never overwrites"

rm -rf "$FIXTURES"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/monitor/lib_test.sh`
Expected: `monitor/lib.sh` henüz yok olduğu için `source` satırında hata, script sıfır olmayan kodla çıkar.

- [ ] **Step 3: `monitor/lib.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Pure, side-effect-light resource-monitor helpers. Every function takes
# its data source as a file path so it can be tested with fixtures
# instead of real /proc files.

# CPU% between two /proc/stat snapshots (never an instantaneous reading,
# never /proc/loadavg — see spec §7.1). Fields after "cpu ": user nice
# system idle iowait irq softirq steal guest guest_nice.
compute_cpu_percent() {
  local prev_file="$1" curr_file="$2"
  awk -v prevfile="$prev_file" -v currfile="$curr_file" '
    BEGIN {
      while ((getline line < prevfile) > 0) {
        if (line ~ /^cpu /) { split(line, p, " "); break }
      }
      close(prevfile)
      while ((getline line < currfile) > 0) {
        if (line ~ /^cpu /) { split(line, c, " "); break }
      }
      close(currfile)
      p_busy = p[2]+p[3]+p[4]+p[7]+p[8]+p[9]
      p_idle = p[5]+p[6]
      p_total = p_busy + p_idle
      c_busy = c[2]+c[3]+c[4]+c[7]+c[8]+c[9]
      c_idle = c[5]+c[6]
      c_total = c_busy + c_idle
      d_busy = c_busy - p_busy
      d_total = c_total - p_total
      if (d_total <= 0) { printf "0.00"; exit }
      printf "%.2f", (d_busy / d_total) * 100
    }
  '
}

# RAM% from a single /proc/meminfo snapshot. Uses MemAvailable (reclaimable
# cache/buffers excluded correctly), never MemFree (spec §7.1).
compute_ram_percent() {
  local meminfo_file="$1"
  awk '
    /^MemTotal:/ { total = $2 }
    /^MemAvailable:/ { avail = $2 }
    END { printf "%.2f", (total - avail) / total * 100 }
  ' "$meminfo_file"
}

# Appends one English, JSON-line audit event — same shape and append-only
# discipline as the dashboard's dashboard/auth/audit_log.ts (spec §6/§9:
# always English, regardless of UI language).
append_monitor_audit_event() {
  local log_path="$1" event="$2" metric="$3" value="$4" threshold="$5" action="$6"
  local timestamp
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  jq -nc \
    --arg timestamp "$timestamp" \
    --arg event "$event" \
    --arg metric "$metric" \
    --argjson value "$value" \
    --argjson threshold "$threshold" \
    --arg action "$action" \
    '{timestamp: $timestamp, event: $event, metric: $metric, value: $value, threshold: $threshold, action: $action}' \
    >> "$log_path"
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/monitor/lib_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add monitor/lib.sh tests/monitor/lib_test.sh
git commit -m "feat: add CPU/RAM measurement and monitor audit logging"
```

---

### Task 2: Histerezis, Cooldown ve Çoklu-Kademe Çözümleme Mantığı

**Files:**
- Modify: `monitor/lib.sh`
- Modify: `tests/monitor/lib_test.sh`

**Interfaces:**
- Produces (added to `monitor/lib.sh`): `update_consecutive_count(value, threshold, margin, current_count)` → stdout: new count; `is_tier_ready(now_epoch, cooldown_until_epoch)` → exit status (0 = ready, 1 = still cooling down); `action_severity(action)` → stdout: integer rank; `pick_harsher_action(action_a, action_b)` → stdout: the harsher of the two; `resolve_triggered_action(action...)` → stdout: the single harshest action among any number of triggered tiers (empty stdout if none given); `is_within_monitoring_window(current_hhmm, start_hhmm, end_hhmm)` → exit status (0 = inside the window, handles midnight-wrapping windows where start > end)

- [ ] **Step 1: Başarısız olacak testleri `tests/monitor/lib_test.sh`'ın sonuna ekle**

```bash

# --- update_consecutive_count (hysteresis) ---
result=$(update_consecutive_count 82 80 2 3)
assert_eq "4" "$result" "update_consecutive_count increments when value is at/above threshold"

result=$(update_consecutive_count 77 80 2 3)
assert_eq "0" "$result" "update_consecutive_count resets when value drops below threshold minus margin"

result=$(update_consecutive_count 79 80 2 3)
assert_eq "3" "$result" "update_consecutive_count holds steady inside the hysteresis band (neither resets nor increments)"

# Review Focus: oscillating right at the boundary never lets the count
# collapse back to 0 and restart — it holds at 3 through every wobble.
count=3
for value in 79 80.5 79.2 80 78.5; do
  count=$(update_consecutive_count "$value" 80 2 "$count")
done
assert_eq "5" "$count" "oscillation around the threshold only ever holds or increments, never resets, across repeated wobbles"

# --- is_tier_ready (cooldown) ---
if is_tier_ready 1000 1000; then
  assert_eq "ready" "ready" "is_tier_ready is true exactly at the cooldown deadline"
else
  assert_eq "ready" "not-ready" "is_tier_ready is true exactly at the cooldown deadline"
fi

if is_tier_ready 999 1000; then
  assert_eq "not-ready" "ready" "is_tier_ready is false before the cooldown deadline (no re-trigger during cooldown)"
else
  assert_eq "not-ready" "not-ready" "is_tier_ready is false before the cooldown deadline (no re-trigger during cooldown)"
fi

# --- action_severity / pick_harsher_action / resolve_triggered_action ---
result=$(action_severity "log")
assert_eq "1" "$result" "action_severity ranks log lowest"
result=$(action_severity "restart_services")
assert_eq "2" "$result" "action_severity ranks restart_services in the middle"
result=$(action_severity "reboot")
assert_eq "3" "$result" "action_severity ranks reboot highest"

result=$(pick_harsher_action "log" "restart_services")
assert_eq "restart_services" "$result" "pick_harsher_action picks restart_services over log"
result=$(pick_harsher_action "reboot" "restart_services")
assert_eq "reboot" "$result" "pick_harsher_action picks reboot over restart_services"

# Review Focus: two tiers (e.g. CPU's restart_services tier and RAM's
# reboot tier) triggering in the same cycle resolve to exactly one action.
result=$(resolve_triggered_action "log" "restart_services" "reboot" "log")
assert_eq "reboot" "$result" "resolve_triggered_action resolves several simultaneously-triggered tiers to the single harshest action"

result=$(resolve_triggered_action "log")
assert_eq "log" "$result" "resolve_triggered_action with a single triggered tier returns that tier's action"

result=$(resolve_triggered_action)
assert_eq "" "$result" "resolve_triggered_action with no triggered tiers returns nothing"

# --- is_within_monitoring_window ---
if is_within_monitoring_window "08:30" "00:00" "23:59"; then
  assert_eq "always" "always" "is_within_monitoring_window: the default 00:00-23:59 window covers any time"
else
  assert_eq "always" "outside" "is_within_monitoring_window: the default 00:00-23:59 window covers any time"
fi

if is_within_monitoring_window "02:00" "01:00" "03:00"; then
  assert_eq "inside" "inside" "is_within_monitoring_window: a simple same-day window includes a time inside it"
else
  assert_eq "inside" "outside" "is_within_monitoring_window: a simple same-day window includes a time inside it"
fi

# Review Focus: outside the window, no action should ever be considered —
# this is the function the monitor loop checks before measuring anything.
if is_within_monitoring_window "04:00" "01:00" "03:00"; then
  assert_eq "outside" "inside" "is_within_monitoring_window: a time after a simple window's end is outside it"
else
  assert_eq "outside" "outside" "is_within_monitoring_window: a time after a simple window's end is outside it"
fi

if is_within_monitoring_window "23:30" "22:00" "02:00"; then
  assert_eq "inside" "inside" "is_within_monitoring_window: a midnight-wrapping window includes a late-night time"
else
  assert_eq "inside" "outside" "is_within_monitoring_window: a midnight-wrapping window includes a late-night time"
fi

if is_within_monitoring_window "09:00" "22:00" "02:00"; then
  assert_eq "outside" "inside" "is_within_monitoring_window: a midnight-wrapping window excludes a daytime time"
else
  assert_eq "outside" "outside" "is_within_monitoring_window: a midnight-wrapping window excludes a daytime time"
fi
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/monitor/lib_test.sh`
Expected: Yeni eklenen fonksiyonlar (`update_consecutive_count`, `is_tier_ready`, `action_severity`, `pick_harsher_action`, `resolve_triggered_action`, `is_within_monitoring_window`) henüz yok, "command not found" ile başarısız olur.

- [ ] **Step 3: Fonksiyonları `monitor/lib.sh`'ın sonuna ekle**

```bash

# Hysteresis: value >= threshold increments; value < threshold - margin
# resets to 0; the band between them holds the count steady, so a value
# wobbling right at the boundary doesn't keep resetting (spec §7.3 states
# the increment and reset rules but not the band between them — holding
# steady is the only reading consistent with both, since neither stated
# condition fires there).
update_consecutive_count() {
  local value="$1" threshold="$2" margin="$3" current_count="$4"
  awk -v value="$value" -v threshold="$threshold" -v margin="$margin" -v count="$current_count" '
    BEGIN {
      if (value >= threshold) { print count + 1 }
      else if (value < threshold - margin) { print 0 }
      else { print count }
    }
  '
}

# True once a tier's cooldown has elapsed (now >= cooldown_until).
is_tier_ready() {
  local now_epoch="$1" cooldown_until_epoch="$2"
  [[ "$now_epoch" -ge "$cooldown_until_epoch" ]]
}

# log < restart_services < reboot.
action_severity() {
  case "$1" in
    log) echo 1 ;;
    restart_services) echo 2 ;;
    reboot) echo 3 ;;
    *) echo 0 ;;
  esac
}

pick_harsher_action() {
  local a="$1" b="$2"
  if [[ "$(action_severity "$a")" -ge "$(action_severity "$b")" ]]; then
    echo "$a"
  else
    echo "$b"
  fi
}

# Folds any number of simultaneously-triggered tier actions down to the
# single harshest one (spec §7.3 point 4) — this is what stops, say, a
# CPU tier's restart_services and a RAM tier's reboot from both firing in
# the same cycle.
resolve_triggered_action() {
  local result=""
  for action in "$@"; do
    if [[ -z "$result" ]]; then
      result="$action"
    else
      result=$(pick_harsher_action "$result" "$action")
    fi
  done
  echo "$result"
}

# Whether `current` (HH:MM) falls inside [start, end]. Handles a window
# that wraps midnight (start > end, e.g. 22:00-02:00) as well as a plain
# same-day window; the "10#" prefixes stop bash from misreading a
# zero-padded hour like "08" as an invalid octal literal.
is_within_monitoring_window() {
  local current="$1" start="$2" end="$3"
  local cur_min start_min end_min
  cur_min=$(( (10#${current%%:*}) * 60 + 10#${current##*:} ))
  start_min=$(( (10#${start%%:*}) * 60 + 10#${start##*:} ))
  end_min=$(( (10#${end%%:*}) * 60 + 10#${end##*:} ))
  if [[ "$start_min" -le "$end_min" ]]; then
    [[ "$cur_min" -ge "$start_min" && "$cur_min" -le "$end_min" ]]
  else
    [[ "$cur_min" -ge "$start_min" || "$cur_min" -le "$end_min" ]]
  fi
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/monitor/lib_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add monitor/lib.sh tests/monitor/lib_test.sh
git commit -m "feat: add hysteresis, cooldown, and multi-tier action resolution"
```

---

### Task 3: `reboot-device.sh` Privileged Helper

**Files:**
- Create: `privileged/reboot-device.sh`
- Test: `tests/privileged/reboot_device_test.sh`
- Modify: `privileged/sudoers.d/aundekiosk`
- Modify: `tests/privileged/sudoers_test.sh`

**Interfaces:**
- Produces: `privileged/reboot-device.sh` (argümansız, `systemctl reboot` çalıştırır)

- [ ] **Step 1: Başarısız olacak testi yaz**

`tests/privileged/reboot_device_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/reboot-device.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$@" > "$AUNDEKIOSK_TEST_SYSTEMCTL_ARGS_FILE"
EOF
chmod +x "$FAKE_BIN/systemctl"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_TEST_SYSTEMCTL_ARGS_FILE="$WORKDIR/systemctl_args.txt"

bash "$HELPER"
assert_status 0 $? "reboot-device.sh exits 0 on success"

args=$(cat "$AUNDEKIOSK_TEST_SYSTEMCTL_ARGS_FILE")
assert_eq "reboot" "$args" "reboot-device.sh calls systemctl reboot"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject_output.txt" 2>&1
assert_status 1 $? "reboot-device.sh rejects any argument"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/privileged/reboot_device_test.sh`
Expected: script henüz yok, "No such file or directory" ile başarısız olur.

- [ ] **Step 3: `privileged/reboot-device.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Privileged helper: reboots the device. Takes NO arguments by design —
# same fixed-action pattern as restart-kiosk-services.sh (Plan 1), which
# is what makes it safe to grant passwordless sudo on without validating
# any input.
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

exec systemctl reboot
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/reboot_device_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add privileged/reboot-device.sh tests/privileged/reboot_device_test.sh
git commit -m "feat: add the reboot-device privileged helper"
```

- [ ] **Step 6: Sudoers whitelist'ine satırı ve testine ekle**

`privileged/sudoers.d/aundekiosk`'a şu satırı ekle (mevcut `restart-kiosk-services.sh` satırının altına):

```
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/reboot-device.sh
```

`tests/privileged/sudoers_test.sh`'a ekle (mevcut kontrolün altına):

```bash

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/reboot-device.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the reboot-device.sh line"
```

- [ ] **Step 7: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/sudoers_test.sh`
Expected: Windows'ta `visudo` yok, o satır `SKIP` ile atlanır; diğer 3 kontrol (restart-kiosk-services.sh satırı, yeni reboot-device.sh satırı, wildcard kontrolü) `ok -` ile geçer — "3 passed, 0 failed".

- [ ] **Step 8: Commit**

```bash
git add privileged/sudoers.d/aundekiosk tests/privileged/sudoers_test.sh
git commit -m "feat: whitelist reboot-device.sh in the sudoers file"
```

---

### Task 4: Dashboard Monitor-Config API (Oturum Korumalı)

**Files:**
- Create: `dashboard/monitor_config_api.ts`
- Test: `dashboard/monitor_config_api_test.ts`
- Create: `monitor-config.json.sample`
- Modify: `dashboard/server.ts`
- Modify: `dashboard/server_test.ts`

**Interfaces:**
- Consumes: `dashboard/auth/auth_api.ts` → `authApi.requireSession` (Plan 2)
- Produces: `createMonitorConfigApi(opts: { configPath: string; samplePath?: string }): { handleGet(): Promise<Response>; handlePost(req: Request): Promise<Response> }`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/monitor_config_api_test.ts`:

```typescript
import { createMonitorConfigApi } from "./monitor_config_api.ts";
import { assertEquals } from "./test_util.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const VALID_CONFIG = {
  sampleIntervalSeconds: 10,
  activeWindow: null,
  tiers: [
    { threshold: 70, sustainedSamples: 10, action: "log", cooldownSeconds: 300 },
    { threshold: 80, sustainedSamples: 10, action: "restart_services", cooldownSeconds: 300 },
    { threshold: 90, sustainedSamples: 5, action: "reboot", cooldownSeconds: 600 },
  ],
};

Deno.test("GET returns the sample config when none has been saved yet", async () => {
  await withTempDir(async (dir) => {
    const samplePath = `${dir}/monitor-config.json.sample`;
    await Deno.writeTextFile(samplePath, JSON.stringify(VALID_CONFIG));
    const api = createMonitorConfigApi({ configPath: `${dir}/monitor-config.json`, samplePath });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    assertEquals(await res.text(), JSON.stringify(VALID_CONFIG));
  });
});

Deno.test("POST with a valid config writes the file and returns 200", async () => {
  await withTempDir(async (dir) => {
    const api = createMonitorConfigApi({ configPath: `${dir}/monitor-config.json`, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/monitor-config", {
      method: "POST",
      body: JSON.stringify(VALID_CONFIG),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 200);
    const saved = JSON.parse(await Deno.readTextFile(`${dir}/monitor-config.json`));
    assertEquals(saved.tiers.length, 3);
  });
});

Deno.test("POST rejects an unknown action value and leaves the existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/monitor-config.json`;
    const original = JSON.stringify(VALID_CONFIG);
    await Deno.writeTextFile(configPath, original);
    const api = createMonitorConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const badConfig = {
      ...VALID_CONFIG,
      tiers: [{ threshold: 80, sustainedSamples: 10, action: "shutdown", cooldownSeconds: 300 }],
    };
    const req = new Request("http://localhost/monitor-config", { method: "POST", body: JSON.stringify(badConfig) });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST rejects a threshold outside 0-100 and leaves the existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/monitor-config.json`;
    const original = JSON.stringify(VALID_CONFIG);
    await Deno.writeTextFile(configPath, original);
    const api = createMonitorConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const badConfig = {
      ...VALID_CONFIG,
      tiers: [{ threshold: 150, sustainedSamples: 10, action: "log", cooldownSeconds: 300 }],
    };
    const req = new Request("http://localhost/monitor-config", { method: "POST", body: JSON.stringify(badConfig) });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST rejects a malformed activeWindow time and leaves the existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/monitor-config.json`;
    const original = JSON.stringify(VALID_CONFIG);
    await Deno.writeTextFile(configPath, original);
    const api = createMonitorConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const badConfig = { ...VALID_CONFIG, activeWindow: { start: "25:00", end: "02:00" } };
    const req = new Request("http://localhost/monitor-config", { method: "POST", body: JSON.stringify(badConfig) });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST accepts a null activeWindow (always-on monitoring)", async () => {
  await withTempDir(async (dir) => {
    const api = createMonitorConfigApi({ configPath: `${dir}/monitor-config.json`, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/monitor-config", {
      method: "POST",
      body: JSON.stringify({ ...VALID_CONFIG, activeWindow: null }),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 200);
  });
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write dashboard/monitor_config_api_test.ts`
Expected: `monitor_config_api.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/monitor_config_api.ts`'i yaz**

```typescript
interface MonitorTier {
  threshold: number;
  sustainedSamples: number;
  action: "log" | "restart_services" | "reboot";
  cooldownSeconds: number;
}

interface MonitorConfig {
  sampleIntervalSeconds: number;
  activeWindow: { start: string; end: string } | null;
  tiers: MonitorTier[];
}

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const VALID_ACTIONS = new Set(["log", "restart_services", "reboot"]);

function isValidTier(value: unknown): value is MonitorTier {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.threshold === "number" &&
    Number.isFinite(t.threshold) &&
    t.threshold >= 0 &&
    t.threshold <= 100 &&
    typeof t.sustainedSamples === "number" &&
    Number.isInteger(t.sustainedSamples) &&
    t.sustainedSamples >= 1 &&
    typeof t.action === "string" &&
    VALID_ACTIONS.has(t.action) &&
    typeof t.cooldownSeconds === "number" &&
    Number.isInteger(t.cooldownSeconds) &&
    t.cooldownSeconds >= 0
  );
}

function isValidActiveWindow(value: unknown): value is MonitorConfig["activeWindow"] {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.start === "string" &&
    HHMM_PATTERN.test(w.start) &&
    typeof w.end === "string" &&
    HHMM_PATTERN.test(w.end)
  );
}

function isValidMonitorConfig(value: unknown): value is MonitorConfig {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.sampleIntervalSeconds === "number" &&
    Number.isInteger(c.sampleIntervalSeconds) &&
    c.sampleIntervalSeconds >= 1 &&
    c.sampleIntervalSeconds <= 3600 &&
    isValidActiveWindow(c.activeWindow) &&
    Array.isArray(c.tiers) &&
    c.tiers.every(isValidTier)
  );
}

export interface MonitorConfigApiOptions {
  configPath: string;
  samplePath?: string;
}

export function createMonitorConfigApi(opts: MonitorConfigApiOptions) {
  const { configPath } = opts;
  const samplePath = opts.samplePath ?? configPath.replace(/monitor-config\.json$/, "monitor-config.json.sample");

  async function handleGet(): Promise<Response> {
    try {
      const data = await Deno.readTextFile(configPath);
      return new Response(data, { headers: { "Content-Type": "application/json" } });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        const sample = await Deno.readTextFile(samplePath);
        return new Response(sample, { headers: { "Content-Type": "application/json" } });
      }
      console.error("Error reading monitor config:", error);
      return new Response("Could not read monitor config.", { status: 500 });
    }
  }

  async function handlePost(req: Request): Promise<Response> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await req.text());
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }

    if (!isValidMonitorConfig(parsed)) {
      return new Response(
        "Invalid monitor config shape: expected { sampleIntervalSeconds, activeWindow, tiers: [{ threshold, sustainedSamples, action, cooldownSeconds }] }.",
        { status: 400 },
      );
    }

    const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmpPath, JSON.stringify(parsed, null, 2));
    await Deno.rename(tmpPath, configPath);
    return new Response("Monitor config saved.", { status: 200 });
  }

  return { handleGet, handlePost };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write dashboard/monitor_config_api_test.ts`
Expected: 6 test de PASS.

- [ ] **Step 5: `monitor-config.json.sample`'ı proje köküne oluştur**

```json
{
  "sampleIntervalSeconds": 10,
  "activeWindow": null,
  "tiers": [
    { "threshold": 70, "sustainedSamples": 10, "action": "log", "cooldownSeconds": 300 },
    { "threshold": 80, "sustainedSamples": 10, "action": "restart_services", "cooldownSeconds": 300 },
    { "threshold": 90, "sustainedSamples": 5, "action": "reboot", "cooldownSeconds": 600 }
  ]
}
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/monitor_config_api.ts dashboard/monitor_config_api_test.ts monitor-config.json.sample
git commit -m "feat: add the monitor-config API with tier/window validation"
```

- [ ] **Step 7: `server.ts` için başarısız olacak testi yaz (oturum koruması)**

`dashboard/server_test.ts`'e ekle:

```typescript
Deno.test("GET /monitor-config without a session returns 401, never the tier data", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
      monitorConfigPath: `${dir}/monitor-config.json`,
      monitorSamplePath: `${dir}/monitor-config.json.sample`,
    });
    const res = await handle(new Request("http://localhost/monitor-config"));
    assertEquals(res.status, 401);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("GET /monitor-config with a valid session returns the tier data", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/config.json.sample`, JSON.stringify({ urls: [] }));
    await Deno.writeTextFile(`${dir}/monitor-config.json.sample`, JSON.stringify({ sampleIntervalSeconds: 10, activeWindow: null, tiers: [] }));
    const handle = createHandler({
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
      authStorePath: `${dir}/auth.db`,
      auditLogPath: `${dir}/audit.log`,
      monitorConfigPath: `${dir}/monitor-config.json`,
      monitorSamplePath: `${dir}/monitor-config.json.sample`,
    });

    await handle(
      new Request("http://localhost/api/setup", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
      }),
    );
    const loginRes = await handle(
      new Request("http://localhost/api/login", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "a-long-enough-password" }),
      }),
    );
    const cookiePair = (loginRes.headers.get("Set-Cookie") ?? "").split(";")[0];

    const res = await handle(new Request("http://localhost/monitor-config", { headers: { Cookie: cookiePair } }));
    assertEquals(res.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

- [ ] **Step 8: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`
Expected: `createHandler`'ın `monitorConfigPath`/`monitorSamplePath` seçeneklerini tanımadığı ve `/monitor-config` rotasını hiç yönlendirmediği (404/static'e düştüğü) için başarısız olur.

- [ ] **Step 9: `dashboard/server.ts`'i güncelle**

```typescript
import { createMonitorConfigApi } from "./monitor_config_api.ts";
```

satırını diğer import'ların yanına ekle. `DEFAULT_SAMPLE_PATH`'in altına:

```typescript
const DEFAULT_MONITOR_CONFIG_PATH = "/opt/aundekiosk/monitor-config.json";
const DEFAULT_MONITOR_SAMPLE_PATH = `${import.meta.dirname}/../monitor-config.json.sample`;
```

`HandlerOptions`'a ekle:

```typescript
  monitorConfigPath?: string;
  monitorSamplePath?: string;
```

`createHandler`'ın içine, `configApi` tanımının yanına:

```typescript
  const monitorConfigPath = options.monitorConfigPath ?? Deno.env.get("AUNDEKIOSK_MONITOR_CONFIG_FILE") ?? DEFAULT_MONITOR_CONFIG_PATH;
  const monitorSamplePath = options.monitorSamplePath ?? DEFAULT_MONITOR_SAMPLE_PATH;
  const monitorConfigApi = createMonitorConfigApi({ configPath: monitorConfigPath, samplePath: monitorSamplePath });
```

`/config` bloğunun hemen altına (aynı oturum kontrolü deseniyle):

```typescript
    if (url.pathname === "/monitor-config") {
      if (!authApi.requireSession(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (req.method === "GET") return monitorConfigApi.handleGet();
      if (req.method === "POST") return monitorConfigApi.handlePost(req);
      return new Response("Method Not Allowed", { status: 405 });
    }
```

- [ ] **Step 10: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/server_test.ts`
Expected: Tüm testler PASS (9 eski + 2 yeni = 11).

- [ ] **Step 11: Commit**

```bash
git add dashboard/server.ts dashboard/server_test.ts
git commit -m "feat: gate /monitor-config behind a session, completing the dashboard side"
```

---

### Task 5: Resource Monitor Daemon ve Systemd Servisi

**Files:**
- Create: `monitor/resource-monitor.sh`
- Create: `services/aundekiosk-monitor.service.template`

**Interfaces:**
- Consumes: `monitor/lib.sh` → tüm Task 1/2 fonksiyonları; `privileged/restart-kiosk-services.sh`, `privileged/reboot-device.sh` (sudo ile)

Bu görevin ana döngüsü, Plan 1'in `switcher.sh`'ı gibi **otomatik test kapsamı dışında** — gerçek `/proc` örnekleme + `sleep` + `sudo` çağrıları içerdiği için bu doğaldır (spec §11: gerçek donanımda manuel QA). Döngünün çağırdığı HER karar fonksiyonu (Task 1/2) ayrı ayrı zaten kanıtlanmış durumda.

- [ ] **Step 1: `monitor/resource-monitor.sh`'ı yaz**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

MONITOR_CONFIG_FILE="${AUNDEKIOSK_MONITOR_CONFIG_FILE:-/opt/aundekiosk/monitor-config.json}"
AUDIT_LOG_FILE="${AUNDEKIOSK_AUDIT_LOG_FILE:-/opt/aundekiosk/audit.log}"
STAT_FILE="${AUNDEKIOSK_PROC_STAT_FILE:-/proc/stat}"
MEMINFO_FILE="${AUNDEKIOSK_PROC_MEMINFO_FILE:-/proc/meminfo}"
RESTART_HELPER="${AUNDEKIOSK_RESTART_HELPER:-/opt/aundekiosk/privileged/restart-kiosk-services.sh}"
REBOOT_HELPER="${AUNDEKIOSK_REBOOT_HELPER:-/opt/aundekiosk/privileged/reboot-device.sh}"

# 2 percentage points — see spec §7.3 and monitor/lib.sh's update_consecutive_count.
readonly HYSTERESIS_MARGIN=2

declare -A TIER_COUNT_CPU
declare -A TIER_COUNT_RAM
declare -A TIER_COOLDOWN_UNTIL

echo "AundeKiosk resource monitor started."

PREV_STAT_SNAPSHOT=$(mktemp)
cp "$STAT_FILE" "$PREV_STAT_SNAPSHOT"

while true; do
  CONFIG=$(cat "$MONITOR_CONFIG_FILE")
  SAMPLE_INTERVAL=$(echo "$CONFIG" | jq -r '.sampleIntervalSeconds')
  WINDOW_START=$(echo "$CONFIG" | jq -r '.activeWindow.start // "00:00"')
  WINDOW_END=$(echo "$CONFIG" | jq -r '.activeWindow.end // "23:59"')

  sleep "$SAMPLE_INTERVAL"

  NOW_HHMM=$(date +%H:%M)
  if ! is_within_monitoring_window "$NOW_HHMM" "$WINDOW_START" "$WINDOW_END"; then
    # Outside the configured window: no measurement, no action (spec §7.4).
    continue
  fi

  CURR_STAT_SNAPSHOT=$(mktemp)
  cp "$STAT_FILE" "$CURR_STAT_SNAPSHOT"
  CPU_PERCENT=$(compute_cpu_percent "$PREV_STAT_SNAPSHOT" "$CURR_STAT_SNAPSHOT")
  rm -f "$PREV_STAT_SNAPSHOT"
  PREV_STAT_SNAPSHOT="$CURR_STAT_SNAPSHOT"

  RAM_PERCENT=$(compute_ram_percent "$MEMINFO_FILE")
  NOW_EPOCH=$(date +%s)

  TRIGGERED_ACTIONS=()
  TIER_COUNT_TOTAL=$(echo "$CONFIG" | jq -r '.tiers | length')

  for ((i = 0; i < TIER_COUNT_TOTAL; i++)); do
    THRESHOLD=$(echo "$CONFIG" | jq -r ".tiers[$i].threshold")
    SUSTAINED=$(echo "$CONFIG" | jq -r ".tiers[$i].sustainedSamples")
    ACTION=$(echo "$CONFIG" | jq -r ".tiers[$i].action")
    COOLDOWN_SECONDS=$(echo "$CONFIG" | jq -r ".tiers[$i].cooldownSeconds")

    for METRIC in cpu ram; do
      if [[ "$METRIC" == "cpu" ]]; then
        VALUE="$CPU_PERCENT"
        PREV_COUNT="${TIER_COUNT_CPU[$i]:-0}"
      else
        VALUE="$RAM_PERCENT"
        PREV_COUNT="${TIER_COUNT_RAM[$i]:-0}"
      fi

      NEW_COUNT=$(update_consecutive_count "$VALUE" "$THRESHOLD" "$HYSTERESIS_MARGIN" "$PREV_COUNT")
      if [[ "$METRIC" == "cpu" ]]; then TIER_COUNT_CPU[$i]="$NEW_COUNT"; else TIER_COUNT_RAM[$i]="$NEW_COUNT"; fi

      COOLDOWN_KEY="${METRIC}_${i}"
      TIER_DEADLINE="${TIER_COOLDOWN_UNTIL[$COOLDOWN_KEY]:-0}"

      if [[ "$NEW_COUNT" -ge "$SUSTAINED" ]] && is_tier_ready "$NOW_EPOCH" "$TIER_DEADLINE"; then
        TIER_COOLDOWN_UNTIL[$COOLDOWN_KEY]=$((NOW_EPOCH + COOLDOWN_SECONDS))
        append_monitor_audit_event "$AUDIT_LOG_FILE" "threshold_triggered" "$METRIC" "$VALUE" "$THRESHOLD" "$ACTION"
        TRIGGERED_ACTIONS+=("$ACTION")
      fi
    done
  done

  if [[ "${#TRIGGERED_ACTIONS[@]}" -gt 0 ]]; then
    FINAL_ACTION=$(resolve_triggered_action "${TRIGGERED_ACTIONS[@]}")
    case "$FINAL_ACTION" in
      restart_services)
        echo "Resource monitor: restarting kiosk services."
        sudo "$RESTART_HELPER"
        ;;
      reboot)
        echo "Resource monitor: rebooting device."
        sudo "$REBOOT_HELPER"
        ;;
      log)
        echo "Resource monitor: threshold logged, no action taken."
        ;;
    esac
  fi
done
```

- [ ] **Step 2: systemd servis şablonunu oluştur**

`services/aundekiosk-monitor.service.template`:

```ini
[Unit]
Description=Run AundeKiosk resource monitor
After=network.target

[Service]
Type=simple
ExecStart=/opt/aundekiosk/monitor/resource-monitor.sh
WorkingDirectory=/opt/aundekiosk
User=aundekiosk
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Söz dizimini doğrula (çalıştırmadan)**

Run: `bash -n monitor/resource-monitor.sh`
Expected: Çıktı yok, exit code 0. (Bu script gerçek `/proc` dosyalarını, `sleep` döngüsünü ve `sudo`'yu kullandığı için otomatik olarak çalıştırılmaz — spec §11'e göre gerçek Pi donanımında manuel QA ile doğrulanır.)

- [ ] **Step 4: Commit**

```bash
git add monitor/resource-monitor.sh services/aundekiosk-monitor.service.template
git commit -m "feat: add the resource monitor daemon and its systemd service"
```

---

### Task 6: Kurulum Entegrasyonu ve Tam Doğrulama

**Files:**
- Modify: `scripts/setup/install.sh`
- Modify: `tests/run_all.sh`

**Interfaces:**
- Consumes: Task 1–5'in ürettiği her şey (bu task sadece bunları kuruluma bağlar)

- [ ] **Step 1: `install.sh`'ı güncelle**

`chmod +x` satırına `monitor/*.sh`'ı ekle:

```bash
chmod +x "$AUNDEKIOSK_INSTALL_DIR"/runtime/*.sh "$AUNDEKIOSK_INSTALL_DIR"/privileged/*.sh "$AUNDEKIOSK_INSTALL_DIR"/monitor/*.sh
```

"Setting up configuration file..." bloğunun altına, monitor-config için aynı deseni ekle:

```bash
msg "$INFO" "Setting up resource monitor configuration..."
AUNDEKIOSK_MONITOR_CONFIG_FILE="$AUNDEKIOSK_INSTALL_DIR/monitor-config.json"
if [ ! -f "$AUNDEKIOSK_MONITOR_CONFIG_FILE" ]; then
    cp "$AUNDEKIOSK_INSTALL_DIR/monitor-config.json.sample" "$AUNDEKIOSK_MONITOR_CONFIG_FILE"
    msg "$DEBUG" "Created default monitor-config.json from sample."
fi
```

Diğer systemd servis kurulum satırlarının yanına (`aundekiosk-dashboard.service.template` satırının altına):

```bash
cp "$AUNDEKIOSK_INSTALL_DIR/services/aundekiosk-monitor.service.template" /etc/systemd/system/aundekiosk-monitor.service
```

`systemctl enable`/`start` satırlarını güncelle:

```bash
systemctl enable aundekiosk-runner.service aundekiosk-switcher.service aundekiosk-dashboard.service aundekiosk-monitor.service
systemctl start aundekiosk-dashboard.service aundekiosk-monitor.service
```

(`aundekiosk-runner`/`aundekiosk-switcher` yalnızca `enable` edilir, grafik oturumu başladığında başlar — mevcut davranış korunuyor; sadece `monitor`'ü `dashboard` ile birlikte `start` listesine ekliyoruz.)

- [ ] **Step 2: Söz dizimini doğrula**

Run: `bash -n scripts/setup/install.sh`
Expected: Çıktı yok, exit code 0.

- [ ] **Step 3: `tests/run_all.sh`'a yeni test dosyalarını ekle**

```bash
  "$SCRIPT_DIR/monitor/lib_test.sh" \
  "$SCRIPT_DIR/privileged/reboot_device_test.sh" \
```

satırlarını, mevcut listeye (örn. `platform/lib_test.sh`'ın altına, `privileged/restart_kiosk_services_test.sh`'ın yanına) ekle.

- [ ] **Step 4: Tüm test paketini çalıştır**

Run: `bash tests/run_all.sh`
Expected: Her bölüm için `0 failed`, "All bash test suites passed."

Run: `deno test --allow-read --allow-write --allow-net --allow-env dashboard/`
Expected: Task 4'teki tüm Deno testleri dahil, tamamı PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup/install.sh tests/run_all.sh
git commit -m "feat: wire the resource monitor into install.sh, completing Plan 3"
```
