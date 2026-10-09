# AundeKiosk Plan 1 — Temel Platform & Kiosk Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the foundation every later AundeKiosk plan depends on: runtime hardware/display-server detection, the kiosk runner/switcher scripts, an unprivileged Deno dashboard that serves static files and the `config.json` API, the whitelist-based privileged-helper pattern (proven with one real helper), tr/en/de i18n, and the install script that wires it all together on a Raspberry Pi.

**Architecture:** Pure, side-effect-light Bash functions (`platform/lib.sh`) are unit-tested with fixture files and consumed by `runner.sh`/`switcher.sh`. The dashboard is a dependency-injected Deno/TS handler (`createStaticHandler`, `createConfigApi`, `createHandler`) so every route is testable without a running HTTP server. System-changing actions never run inline in the dashboard process — they go through fixed, argument-free scripts in `privileged/`, granted passwordless `sudo` via a narrow `sudoers.d` whitelist. The dashboard runs as its own unprivileged system user on port 8080, never as root.

**Tech Stack:** Bash (`set -euo pipefail`), Deno + TypeScript (dashboard backend), vanilla JS + Bootstrap 5 (frontend, no bundler), `jq` for JSON extraction in shell, `systemd` for service management.

**Spec:** [docs/superpowers/specs/2026-10-09-aundekiosk-design.md](../specs/2026-10-09-aundekiosk-design.md)

## Global Constraints

- Dashboard süreci **root olarak çalışmaz**; ayrıcalıksız bir sistem kullanıcısıyla, yüksek bir portta dinler (bu planda **8080**). (Spec §5.1, §10)
- Privileged helper script'ler **tek amaçlı** olur; `sudoers`'ta **parametresiz, sabit yol** olarak NOPASSWD tanımlanır — wildcard veya serbest parametre yok. (Spec §5.1, §8.4)
- Dashboard'dan/kullanıcıdan gelen veri **asla doğrudan shell string'ine eklenmez**; `eval` kullanılmaz, parametreler array olarak geçirilir. (Spec §5.1, §8.4)
- Tüm Bash script'leri `set -euo pipefail` ile başlar. (Spec §10)
- `config.json` **hassas veri içermez**; kimlik bilgisi/credential verisi bu dosyaya asla yazılmaz. (Spec §6, §10)
- Konsol/sistem log mesajları **her zaman İngilizce** yazılır, UI dilinden bağımsız. (Spec §9)
- UI varsayılan dili **Türkçe**'dir; eksik çeviri anahtarı önce İngilizce'ye, sonra anahtar adına düşer. (Spec §9)
- Ekran sunucusu (Wayland/X11) ve donanım tespiti **runtime'da** yapılır, build-time'da sabitlenmez. (Spec §2)

## Review Focus

- Statik dosya sunumunda path-traversal denemesi (`/../`'lı istekler) **404 döner, hedef dizin dışına çıkmaz** — Task 4'te test edilir.
- `config.json` hiç yoksa (ilk kurulum), GET `/config` hata vermez, `config.json.sample` içeriğini döner — Task 5'te test edilir.
- `/config`'e bozuk JSON veya yanlış şekilli veri POST edilirse 400 döner ve **mevcut geçerli `config.json` değişmeden kalır** — Task 5'te test edilir.
- `config.json`'da hiç URL yoksa, `runner.sh` chromium'u hiç başlatmadan temiz bir şekilde çıkar — Task 2'de test edilir.
- Ne `WAYLAND_DISPLAY` ne de `DISPLAY` set edilmemişse, `switcher.sh` sessizce donmaz; açık bir uyarı loglar ve güvenli bir varsayılana (`xdotool`) düşer — Task 1 ve Task 3'te test edilir.

---

## Ortam Notu

Bu plan `jq` ve `deno`'yu doğrudan kullanır. Bu makinede ikisi de kurulu değil (kontrol edildi). Task 1'in ilk adımı bunları kurar.

### Task 1: Platform Tespit Kütüphanesi (`platform/lib.sh`)

**Files:**
- Create: `platform/lib.sh`
- Create: `tests/assert.sh`
- Test: `tests/platform/lib_test.sh`

**Interfaces:**
- Produces (tüm fonksiyonlar `platform/lib.sh` içinde, sonraki her task bunları `source` eder):
  - `detect_pi_model(model_file=/proc/device-tree/model)` → stdout: model string veya `"unknown"`
  - `detect_display_server(wayland_display, x_display)` → stdout: `"wayland"` | `"x11"` | `"unknown"`
  - `select_switch_tool(display_server)` → stdout: `"wtype"` | `"xdotool"` (unknown → `xdotool`)
  - `detect_ram_mb(meminfo_file=/proc/meminfo)` → stdout: integer MB
  - `extract_urls_from_config(config_file)` → stdout: boşlukla ayrılmış URL listesi
  - `extract_durations_from_config(config_file)` → stdout: her satırda bir duration
  - `extract_cycles_from_config(config_file)` → stdout: her satırda bir cycle değeri
  - `has_urls(config_file)` → exit status (0 = URL var, 1 = yok)
  - `should_refresh(count, target)` → exit status (0 = şimdi yenile, 1 = henüz değil; target=0 her zaman 1)
  - `next_tab_index(current, total)` → stdout: wraparound'lı bir sonraki index
- Produces (`tests/assert.sh`, tüm sonraki bash testleri bunu kullanır):
  - `assert_eq(expected, actual, description)`
  - `assert_status(expected_status, actual_status, description)`
  - `assert_summary()` → özet yazar, hiç `FAIL` yoksa 0 ile çıkar

- [ ] **Step 1: `jq` ve `deno`'yu kur ve doğrula**

```bash
winget install -e --id jqlang.jq
winget install -e --id DenoLand.Deno
```

Kurulumdan sonra terminali/Git Bash'i yeniden açıp doğrula:

```bash
jq --version
deno --version
```

Beklenen: her iki komut da bir sürüm numarası yazdırır (hata yok).

- [ ] **Step 2: Paylaşılan assertion helper'ını yaz**

`tests/assert.sh`:

```bash
#!/usr/bin/env bash
# Minimal assertion helpers shared by AundeKiosk bash tests.
# Usage: source this file, call assert_eq/assert_status repeatedly,
# then call assert_summary at the end.

ASSERT_PASS=0
ASSERT_FAIL=0

assert_eq() {
  local expected="$1"
  local actual="$2"
  local description="$3"
  if [[ "$expected" == "$actual" ]]; then
    ASSERT_PASS=$((ASSERT_PASS + 1))
    echo "ok - $description"
  else
    ASSERT_FAIL=$((ASSERT_FAIL + 1))
    echo "NOT OK - $description (expected '$expected', got '$actual')"
  fi
}

assert_status() {
  local expected_status="$1"
  local actual_status="$2"
  local description="$3"
  if [[ "$expected_status" -eq "$actual_status" ]]; then
    ASSERT_PASS=$((ASSERT_PASS + 1))
    echo "ok - $description"
  else
    ASSERT_FAIL=$((ASSERT_FAIL + 1))
    echo "NOT OK - $description (expected status '$expected_status', got '$actual_status')"
  fi
}

assert_summary() {
  echo ""
  echo "$ASSERT_PASS passed, $ASSERT_FAIL failed"
  [[ "$ASSERT_FAIL" -eq 0 ]]
}
```

- [ ] **Step 3: Başarısız olacak testi yaz**

`tests/platform/lib_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=../assert.sh
source "$SCRIPT_DIR/../assert.sh"
# shellcheck source=../../platform/lib.sh
source "$SCRIPT_DIR/../../platform/lib.sh"

FIXTURES="$SCRIPT_DIR/fixtures"
mkdir -p "$FIXTURES"

# --- detect_pi_model ---
echo "Raspberry Pi 5 Model B Rev 1.0" > "$FIXTURES/model_pi5.txt"
result=$(detect_pi_model "$FIXTURES/model_pi5.txt")
assert_eq "Raspberry Pi 5 Model B Rev 1.0" "$result" "detect_pi_model reads Pi 5 model string"

result=$(detect_pi_model "$FIXTURES/does_not_exist.txt")
assert_eq "unknown" "$result" "detect_pi_model falls back to unknown when file missing"

# --- detect_display_server ---
result=$(detect_display_server "wayland-0" "")
assert_eq "wayland" "$result" "detect_display_server prefers wayland when WAYLAND_DISPLAY is set"

result=$(detect_display_server "" ":0")
assert_eq "x11" "$result" "detect_display_server falls back to x11 when only DISPLAY is set"

result=$(detect_display_server "" "")
assert_eq "unknown" "$result" "detect_display_server reports unknown when neither is set"

# --- select_switch_tool ---
result=$(select_switch_tool "wayland")
assert_eq "wtype" "$result" "select_switch_tool picks wtype for wayland"

result=$(select_switch_tool "x11")
assert_eq "xdotool" "$result" "select_switch_tool picks xdotool for x11"

result=$(select_switch_tool "unknown")
assert_eq "xdotool" "$result" "select_switch_tool defaults to xdotool when display server is unknown"

# --- detect_ram_mb ---
cat > "$FIXTURES/meminfo_4gb.txt" <<'EOF'
MemTotal:        4050000 kB
MemFree:          120000 kB
MemAvailable:    2500000 kB
EOF
result=$(detect_ram_mb "$FIXTURES/meminfo_4gb.txt")
assert_eq "3955" "$result" "detect_ram_mb converts kB to MB"

# --- extract_urls_from_config / has_urls ---
cat > "$FIXTURES/config_two_urls.json" <<'EOF'
{
  "urls": [
    { "url": "https://example.com", "duration": 10, "cycles": 5 },
    { "url": "https://example.org", "duration": 20, "cycles": 0 }
  ]
}
EOF
result=$(extract_urls_from_config "$FIXTURES/config_two_urls.json")
assert_eq "https://example.com https://example.org" "$result" "extract_urls_from_config joins URLs with a space"

if has_urls "$FIXTURES/config_two_urls.json"; then
  assert_eq "yes" "yes" "has_urls returns true when config has URLs"
else
  assert_eq "yes" "no" "has_urls returns true when config has URLs"
fi

cat > "$FIXTURES/config_empty.json" <<'EOF'
{ "urls": [] }
EOF
if has_urls "$FIXTURES/config_empty.json"; then
  assert_eq "no" "yes" "has_urls returns false when config has no URLs"
else
  assert_eq "no" "no" "has_urls returns false when config has no URLs"
fi

# --- should_refresh ---
if should_refresh 5 10; then
  assert_eq "false" "true" "should_refresh is false before reaching the target"
else
  assert_eq "false" "false" "should_refresh is false before reaching the target"
fi

if should_refresh 10 10; then
  assert_eq "true" "true" "should_refresh is true once the target is reached"
else
  assert_eq "true" "false" "should_refresh is true once the target is reached"
fi

if should_refresh 3 0; then
  assert_eq "false" "true" "should_refresh is always false when target is 0 (disabled)"
else
  assert_eq "false" "false" "should_refresh is always false when target is 0 (disabled)"
fi

# --- next_tab_index ---
result=$(next_tab_index 0 3)
assert_eq "1" "$result" "next_tab_index advances by one"

result=$(next_tab_index 2 3)
assert_eq "0" "$result" "next_tab_index wraps around to zero"

rm -rf "$FIXTURES"
assert_summary
```

- [ ] **Step 4: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/platform/lib_test.sh`
Expected: `platform/lib.sh` henüz yok olduğu için `source` satırında hata, script sıfır olmayan kodla çıkar.

- [ ] **Step 5: `platform/lib.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Pure, side-effect-light detection helpers for AundeKiosk runtime scripts.
# Every function takes its data source as a parameter so it can be tested
# with fixture files instead of real Raspberry Pi hardware.

detect_pi_model() {
  local model_file="${1:-/proc/device-tree/model}"
  if [[ -r "$model_file" ]]; then
    tr -d '\0' < "$model_file"
  else
    echo "unknown"
  fi
}

detect_display_server() {
  local wayland_display="$1"
  local x_display="$2"
  if [[ -n "$wayland_display" ]]; then
    echo "wayland"
  elif [[ -n "$x_display" ]]; then
    echo "x11"
  else
    echo "unknown"
  fi
}

# Unknown display server defaults to xdotool: it also works under XWayland
# compatibility layers and fails loudly (clear error) if truly absent,
# which is safer than silently doing nothing.
select_switch_tool() {
  local display_server="$1"
  if [[ "$display_server" == "wayland" ]]; then
    echo "wtype"
  else
    echo "xdotool"
  fi
}

detect_ram_mb() {
  local meminfo_file="${1:-/proc/meminfo}"
  local kb
  kb=$(awk '/^MemTotal:/ { print $2 }' "$meminfo_file")
  echo $(( kb / 1024 ))
}

extract_urls_from_config() {
  local config_file="$1"
  jq -r '.urls | map(.url) | join(" ")' "$config_file"
}

extract_durations_from_config() {
  local config_file="$1"
  jq -r '.urls[].duration' "$config_file"
}

extract_cycles_from_config() {
  local config_file="$1"
  jq -r '.urls[].cycles' "$config_file"
}

has_urls() {
  local config_file="$1"
  local count
  count=$(jq -r '.urls | length' "$config_file")
  [[ "$count" -gt 0 ]]
}

should_refresh() {
  local count="$1"
  local target="$2"
  if [[ "$target" -le 0 ]]; then
    return 1
  fi
  [[ "$count" -ge "$target" ]]
}

next_tab_index() {
  local current="$1"
  local total="$2"
  echo $(( (current + 1) % total ))
}
```

- [ ] **Step 6: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/platform/lib_test.sh`
Expected: Tüm satırlar `ok -` ile başlar, son satır `0 failed` içerir, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add platform/lib.sh tests/assert.sh tests/platform/lib_test.sh
git commit -m "feat: add platform detection library with fixture-based tests"
```

---

### Task 2: Kiosk Runner (`runtime/runner.sh`)

**Files:**
- Create: `runtime/runner.sh`
- Create: `services/aundekiosk-runner.service.template`
- Test: `tests/runtime/runner_test.sh`

**Interfaces:**
- Consumes: `platform/lib.sh` → `has_urls(config_file)`, `extract_urls_from_config(config_file)`
- Produces: `runtime/runner.sh` (env vars: `AUNDEKIOSK_CONFIG_FILE` default `/opt/aundekiosk/config.json`, `AUNDEKIOSK_STARTUP_DELAY` default `5`)

- [ ] **Step 1: Başarısız olacak testi yaz**

`tests/runtime/runner_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

RUNNER="$SCRIPT_DIR/../../runtime/runner.sh"
WORKDIR=$(mktemp -d)
FAKE_BIN="$WORKDIR/bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/chromium" <<'EOF'
#!/usr/bin/env bash
echo "$@" > "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
EOF
chmod +x "$FAKE_BIN/chromium"

export PATH="$FAKE_BIN:$PATH"
export AUNDEKIOSK_STARTUP_DELAY=0
export AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE="$WORKDIR/chromium_args.txt"

# --- case 1: config with URLs launches chromium with them ---
cat > "$WORKDIR/config_with_urls.json" <<'EOF'
{ "urls": [ { "url": "https://a.test", "duration": 10, "cycles": 5 } ] }
EOF
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_with_urls.json"
rm -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
bash "$RUNNER" > "$WORKDIR/runner_output.txt" 2>&1 || true

if [[ -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE" ]] && grep -q "https://a.test" "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"; then
  assert_eq "called" "called" "runner.sh launches chromium with the configured URL"
else
  assert_eq "called" "not-called" "runner.sh launches chromium with the configured URL"
fi

# --- case 2: config with no URLs exits without launching chromium ---
cat > "$WORKDIR/config_empty.json" <<'EOF'
{ "urls": [] }
EOF
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_empty.json"
rm -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE"
bash "$RUNNER" > "$WORKDIR/runner_output_empty.txt" 2>&1 || true

if [[ -f "$AUNDEKIOSK_TEST_CHROMIUM_ARGS_FILE" ]]; then
  assert_eq "not-called" "called" "runner.sh does not launch chromium when config has no URLs"
else
  assert_eq "not-called" "not-called" "runner.sh does not launch chromium when config has no URLs"
fi

grep -q "No URLs found" "$WORKDIR/runner_output_empty.txt"
assert_status 0 $? "runner.sh logs a clear message when config has no URLs"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/runtime/runner_test.sh`
Expected: `runtime/runner.sh` henüz yok, "No such file or directory" ile başarısız olur.

- [ ] **Step 3: `runtime/runner.sh`'ı yaz**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=../platform/lib.sh
source "$SCRIPT_DIR/../platform/lib.sh"

CONFIG_FILE="${AUNDEKIOSK_CONFIG_FILE:-/opt/aundekiosk/config.json}"
STARTUP_DELAY="${AUNDEKIOSK_STARTUP_DELAY:-5}"

export DISPLAY="${DISPLAY:-:0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

sleep "$STARTUP_DELAY"

if ! has_urls "$CONFIG_FILE"; then
  echo "No URLs found in $CONFIG_FILE. Exiting runner."
  exit 0
fi

URLS=$(extract_urls_from_config "$CONFIG_FILE")

# shellcheck disable=SC2086
exec chromium \
  $URLS \
  --disable-component-update \
  --disable-composited-antialiasing \
  --disable-gpu-driver-bug-workarounds \
  --disable-infobars \
  --disable-low-res-tiling \
  --disable-pinch \
  --disable-session-crashed-bubble \
  --disable-smooth-scrolling \
  --enable-accelerated-video-decode \
  --enable-gpu-rasterization \
  --enable-oop-rasterization \
  --force-device-scale-factor=1 \
  --ignore-gpu-blocklist \
  --kiosk \
  --no-first-run \
  --noerrdialogs
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/runtime/runner_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`, exit code 0.

- [ ] **Step 5: systemd servis şablonunu oluştur**

`services/aundekiosk-runner.service.template`:

```ini
[Unit]
Description=Launch AundeKiosk runner to start Chromium
After=network.target

[Service]
Type=simple
ExecStartPre=/usr/bin/sleep 10
ExecStart=/opt/aundekiosk/runtime/runner.sh
User=PI_USER
WorkingDirectory=PI_HOME
Environment=DISPLAY=:0
Environment=XAUTHORITY=PI_HOME/.Xauthority
Environment=XDG_RUNTIME_DIR=/run/user/PI_SUID
Restart=on-failure

[Install]
WantedBy=graphical.target
```

- [ ] **Step 6: Commit**

```bash
git add runtime/runner.sh services/aundekiosk-runner.service.template tests/runtime/runner_test.sh
git commit -m "feat: add kiosk runner script and its systemd template"
```

---

### Task 3: Kiosk Switcher (`runtime/switcher.sh`)

**Files:**
- Create: `runtime/switcher.sh`
- Create: `services/aundekiosk-switcher.service.template`
- Test: `tests/runtime/switcher_test.sh`

**Interfaces:**
- Consumes: `platform/lib.sh` → `detect_display_server`, `select_switch_tool`, `has_urls`, `extract_durations_from_config`, `extract_cycles_from_config`, `should_refresh`, `next_tab_index`
- Produces: `runtime/switcher.sh` (env vars: `AUNDEKIOSK_CONFIG_FILE`, `AUNDEKIOSK_STARTUP_DELAY` default `15`)

- [ ] **Step 1: Başarısız olacak testi yaz**

`tests/runtime/switcher_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

SWITCHER="$SCRIPT_DIR/../../runtime/switcher.sh"
WORKDIR=$(mktemp -d)

# --- case 1: no URLs -> exits immediately, never loops ---
cat > "$WORKDIR/config_empty.json" <<'EOF'
{ "urls": [] }
EOF
export AUNDEKIOSK_CONFIG_FILE="$WORKDIR/config_empty.json"
export AUNDEKIOSK_STARTUP_DELAY=0
export WAYLAND_DISPLAY="wayland-0"
unset DISPLAY || true

timeout 5 bash "$SWITCHER" > "$WORKDIR/output_empty.txt" 2>&1
assert_status 0 $? "switcher.sh exits (does not hang) when config has no URLs"

grep -q "No URLs configured" "$WORKDIR/output_empty.txt"
assert_status 0 $? "switcher.sh logs a clear message when config has no URLs"

# --- case 2: unknown display server logs a clear warning but still exits cleanly ---
unset WAYLAND_DISPLAY || true
unset DISPLAY || true

timeout 5 bash "$SWITCHER" > "$WORKDIR/output_unknown.txt" 2>&1
assert_status 0 $? "switcher.sh still exits cleanly with no display server detected"

grep -q "WARNING: could not detect a display server" "$WORKDIR/output_unknown.txt"
assert_status 0 $? "switcher.sh warns clearly when display server cannot be detected"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/runtime/switcher_test.sh`
Expected: `runtime/switcher.sh` henüz yok, "No such file or directory" ile başarısız olur.

- [ ] **Step 3: `runtime/switcher.sh`'ı yaz**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
# shellcheck source=../platform/lib.sh
source "$SCRIPT_DIR/../platform/lib.sh"

CONFIG_FILE="${AUNDEKIOSK_CONFIG_FILE:-/opt/aundekiosk/config.json}"
STARTUP_DELAY="${AUNDEKIOSK_STARTUP_DELAY:-15}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

DISPLAY_SERVER=$(detect_display_server "${WAYLAND_DISPLAY:-}" "${DISPLAY:-}")
SWITCH_TOOL=$(select_switch_tool "$DISPLAY_SERVER")

if [[ "$DISPLAY_SERVER" == "unknown" ]]; then
  echo "WARNING: could not detect a display server (neither WAYLAND_DISPLAY nor DISPLAY is set). Falling back to '$SWITCH_TOOL'."
fi

echo "Detected display server: $DISPLAY_SERVER (using $SWITCH_TOOL)"

send_refresh() {
  if [[ "$SWITCH_TOOL" == "wtype" ]]; then
    wtype -M ctrl r -m ctrl
  else
    xdotool key ctrl+r
  fi
}

send_next_tab() {
  if [[ "$SWITCH_TOOL" == "wtype" ]]; then
    wtype -M ctrl -P Tab -m ctrl
  else
    xdotool key ctrl+Tab
  fi
}

if ! has_urls "$CONFIG_FILE"; then
  echo "No URLs configured. Exiting switcher."
  exit 0
fi

mapfile -t DURATIONS < <(extract_durations_from_config "$CONFIG_FILE")
mapfile -t CYCLES < <(extract_cycles_from_config "$CONFIG_FILE")
URL_COUNT=${#DURATIONS[@]}

REFRESH_COUNTS=()
for ((i = 0; i < URL_COUNT; i++)); do
  REFRESH_COUNTS+=(0)
done

CURRENT_TAB_INDEX=0

echo "Switcher waiting ${STARTUP_DELAY}s for the browser to initialize..."
sleep "$STARTUP_DELAY"

echo "AundeKiosk switcher started. Managing $URL_COUNT tabs."

while true; do
  duration=${DURATIONS[$CURRENT_TAB_INDEX]}
  cycle_target=${CYCLES[$CURRENT_TAB_INDEX]}

  REFRESH_COUNTS[$CURRENT_TAB_INDEX]=$(( REFRESH_COUNTS[CURRENT_TAB_INDEX] + 1 ))

  if should_refresh "${REFRESH_COUNTS[$CURRENT_TAB_INDEX]}" "$cycle_target"; then
    echo "Refreshing tab $((CURRENT_TAB_INDEX + 1))."
    send_refresh
    REFRESH_COUNTS[$CURRENT_TAB_INDEX]=0
  fi

  sleep "$duration"

  send_next_tab
  CURRENT_TAB_INDEX=$(next_tab_index "$CURRENT_TAB_INDEX" "$URL_COUNT")
done
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/runtime/switcher_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`, exit code 0.

- [ ] **Step 5: systemd servis şablonunu oluştur**

`services/aundekiosk-switcher.service.template`:

```ini
[Unit]
Description=Launch AundeKiosk switcher to switch tabs
After=aundekiosk-runner.service

[Service]
Type=simple
ExecStart=/opt/aundekiosk/runtime/switcher.sh
User=PI_USER
WorkingDirectory=PI_HOME
Environment=DISPLAY=:0
Environment=XAUTHORITY=PI_HOME/.Xauthority
Environment=XDG_RUNTIME_DIR=/run/user/PI_SUID
Restart=on-failure

[Install]
WantedBy=graphical.target
```

- [ ] **Step 6: Commit**

```bash
git add runtime/switcher.sh services/aundekiosk-switcher.service.template tests/runtime/switcher_test.sh
git commit -m "feat: add kiosk switcher script with runtime display-server detection"
```

---

### Task 4: Dashboard Statik Dosya Sunumu (`dashboard/static.ts`)

**Files:**
- Create: `dashboard/test_util.ts`
- Create: `dashboard/static.ts`
- Test: `dashboard/static_test.ts`

**Interfaces:**
- Produces: `dashboard/test_util.ts` → `assertEquals<T>(actual: T, expected: T, message?: string): void` (sonraki tüm Deno testleri bunu kullanır)
- Produces: `dashboard/static.ts` → `createStaticHandler(publicDir: string): (pathname: string) => Promise<Response>`

- [ ] **Step 1: Test yardımcı modülünü yaz**

`dashboard/test_util.ts`:

```typescript
export function assertEquals<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
```

- [ ] **Step 2: Başarısız olacak testi yaz**

`dashboard/static_test.ts`:

```typescript
import { createStaticHandler } from "./static.ts";
import { assertEquals } from "./test_util.ts";

async function withTempPublicDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<h1>home</h1>");
    await Deno.mkdir(`${dir}/sub`);
    await Deno.writeTextFile(`${dir}/sub/style.css`, "body{}");
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("serves index.html for the root path", async () => {
  await withTempPublicDir(async (dir) => {
    const handle = createStaticHandler(dir);
    const res = await handle("/");
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "<h1>home</h1>");
  });
});

Deno.test("serves nested files with the right content type", async () => {
  await withTempPublicDir(async (dir) => {
    const handle = createStaticHandler(dir);
    const res = await handle("/sub/style.css");
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/css; charset=utf-8");
  });
});

Deno.test("returns 404 for a file that does not exist", async () => {
  await withTempPublicDir(async (dir) => {
    const handle = createStaticHandler(dir);
    const res = await handle("/missing.html");
    assertEquals(res.status, 404);
  });
});

Deno.test("blocks path traversal attempts outside the public dir", async () => {
  await withTempPublicDir(async (dir) => {
    const secretPath = `${dir}-secret.txt`;
    await Deno.writeTextFile(secretPath, "top secret");
    try {
      const handle = createStaticHandler(dir);
      const res = await handle("/../" + secretPath.split("/").pop());
      assertEquals(res.status, 404);
    } finally {
      await Deno.remove(secretPath);
    }
  });
});
```

- [ ] **Step 3: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read dashboard/static_test.ts`
Expected: `static.ts` bulunamadığı için modül çözümleme hatasıyla başarısız olur.

- [ ] **Step 4: `dashboard/static.ts`'i yaz**

```typescript
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  return CONTENT_TYPES[path.slice(dot)] ?? "application/octet-stream";
}

// Serves files strictly from within `publicDir`. Every candidate path is
// resolved to its real, canonical filesystem path (Deno.realPath resolves
// ".." segments and symlinks) and checked against the resolved root before
// anything is read — this is what stops a request like `/../../etc/passwd`
// from escaping the served directory.
export function createStaticHandler(publicDir: string) {
  const root = Deno.realPathSync(publicDir);

  return async function handleStatic(pathname: string): Promise<Response> {
    const relative = pathname === "/" ? "/index.html" : pathname;
    const candidate = `${root}/${relative}`.replace(/\/{2,}/g, "/");

    let resolved: string;
    try {
      resolved = await Deno.realPath(candidate);
    } catch {
      return new Response("Not Found", { status: 404 });
    }

    if (resolved !== root && !resolved.startsWith(root + "/")) {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const file = await Deno.readFile(resolved);
      return new Response(file, {
        headers: { "Content-Type": contentTypeFor(resolved) },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  };
}
```

- [ ] **Step 5: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read dashboard/static_test.ts`
Expected: 4 test de PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/test_util.ts dashboard/static.ts dashboard/static_test.ts
git commit -m "feat: add static file handler with path-traversal protection"
```

---

### Task 5: Dashboard Config API & Server (`dashboard/config_api.ts`, `dashboard/server.ts`)

**Files:**
- Create: `dashboard/config_api.ts`
- Test: `dashboard/config_api_test.ts`
- Create: `dashboard/server.ts`
- Test: `dashboard/server_test.ts`
- Create: `dashboard/deno.json`
- Create: `config.json.sample`
- Create: `services/aundekiosk-dashboard.service.template`

**Interfaces:**
- Consumes: `dashboard/static.ts` → `createStaticHandler`; `dashboard/test_util.ts` → `assertEquals`
- Produces: `dashboard/config_api.ts` → `createConfigApi(opts: { configPath: string; samplePath?: string }): { handleGet(): Promise<Response>; handlePost(req: Request): Promise<Response> }`
- Produces: `dashboard/server.ts` → `createHandler(options?: { configPath?: string; samplePath?: string; publicDir?: string }): (req: Request) => Promise<Response>`

- [ ] **Step 1: Config API için başarısız olacak testi yaz**

`dashboard/config_api_test.ts`:

```typescript
import { createConfigApi } from "./config_api.ts";
import { assertEquals } from "./test_util.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("GET returns the sample config when no config.json exists yet", async () => {
  await withTempDir(async (dir) => {
    const samplePath = `${dir}/config.json.sample`;
    await Deno.writeTextFile(samplePath, JSON.stringify({ urls: [] }));
    const api = createConfigApi({ configPath: `${dir}/config.json`, samplePath });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    assertEquals(await res.text(), JSON.stringify({ urls: [] }));
  });
});

Deno.test("GET returns the saved config.json when it exists", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({ urls: [{ url: "https://a.test", duration: 5, cycles: 1 }] }),
    );
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const res = await api.handleGet();
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.urls[0].url, "https://a.test");
  });
});

Deno.test("POST with valid shape writes the file and returns 200", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const payload = JSON.stringify({ urls: [{ url: "https://b.test", duration: 10, cycles: 0 }] });
    const req = new Request("http://localhost/config", { method: "POST", body: payload });
    const res = await api.handlePost(req);
    assertEquals(res.status, 200);
    const saved = await Deno.readTextFile(configPath);
    assertEquals(JSON.parse(saved).urls[0].url, "https://b.test");
  });
});

Deno.test("POST with malformed JSON returns 400 and leaves existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const original = JSON.stringify({ urls: [{ url: "https://keep.test", duration: 5, cycles: 1 }] });
    await Deno.writeTextFile(configPath, original);
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/config", { method: "POST", body: "{not json" });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});

Deno.test("POST with valid JSON but wrong shape returns 400 and leaves existing config untouched", async () => {
  await withTempDir(async (dir) => {
    const configPath = `${dir}/config.json`;
    const original = JSON.stringify({ urls: [{ url: "https://keep.test", duration: 5, cycles: 1 }] });
    await Deno.writeTextFile(configPath, original);
    const api = createConfigApi({ configPath, samplePath: `${dir}/unused.json` });
    const req = new Request("http://localhost/config", {
      method: "POST",
      body: JSON.stringify({ urls: [{ url: "", duration: "ten", cycles: 1 }] }),
    });
    const res = await api.handlePost(req);
    assertEquals(res.status, 400);
    assertEquals(await Deno.readTextFile(configPath), original);
  });
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write dashboard/config_api_test.ts`
Expected: `config_api.ts` bulunamadığı için başarısız olur.

- [ ] **Step 3: `dashboard/config_api.ts`'i yaz**

```typescript
interface KioskUrlEntry {
  url: string;
  duration: number;
  cycles: number;
}

function isValidConfigShape(value: unknown): value is { urls: KioskUrlEntry[] } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.urls)) return false;
  return obj.urls.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.url === "string" &&
      e.url.length > 0 &&
      typeof e.duration === "number" &&
      Number.isFinite(e.duration) &&
      typeof e.cycles === "number" &&
      Number.isFinite(e.cycles)
    );
  });
}

export interface ConfigApiOptions {
  configPath: string;
  samplePath?: string;
}

export function createConfigApi(opts: ConfigApiOptions) {
  const { configPath } = opts;
  const samplePath = opts.samplePath ?? configPath.replace(/config\.json$/, "config.json.sample");

  async function handleGet(): Promise<Response> {
    try {
      const data = await Deno.readTextFile(configPath);
      return new Response(data, { headers: { "Content-Type": "application/json" } });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        const sample = await Deno.readTextFile(samplePath);
        return new Response(sample, { headers: { "Content-Type": "application/json" } });
      }
      console.error("Error reading config:", error);
      return new Response("Could not read config.", { status: 500 });
    }
  }

  async function handlePost(req: Request): Promise<Response> {
    const body = await req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON.", { status: 400 });
    }

    if (!isValidConfigShape(parsed)) {
      return new Response(
        "Invalid config shape: expected { urls: [{ url, duration, cycles }] }.",
        { status: 400 },
      );
    }

    await Deno.writeTextFile(configPath, JSON.stringify(parsed, null, 2));
    return new Response("Config saved.", { status: 200 });
  }

  return { handleGet, handlePost };
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write dashboard/config_api_test.ts`
Expected: 5 test de PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/config_api.ts dashboard/config_api_test.ts
git commit -m "feat: add config.json GET/POST API with strict shape validation"
```

- [ ] **Step 6: Server wiring için başarısız olacak testi yaz**

`dashboard/server_test.ts`:

```typescript
import { createHandler } from "./server.ts";
import { assertEquals } from "./test_util.ts";

Deno.test("GET /config returns the sample config end to end", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const samplePath = `${dir}/config.json.sample`;
    await Deno.writeTextFile(samplePath, JSON.stringify({ urls: [] }));
    const handle = createHandler({ configPath: `${dir}/config.json`, samplePath });
    const res = await handle(new Request("http://localhost/config"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), JSON.stringify({ urls: [] }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unknown static paths are routed through the static handler", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<h1>AundeKiosk</h1>");
    const handle = createHandler({
      publicDir: dir,
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
    });
    const res = await handle(new Request("http://localhost/"));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "<h1>AundeKiosk</h1>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("POST /config with the wrong method on another path is not routed to the config API", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/index.html`, "<h1>AundeKiosk</h1>");
    const handle = createHandler({
      publicDir: dir,
      configPath: `${dir}/config.json`,
      samplePath: `${dir}/config.json.sample`,
    });
    const res = await handle(new Request("http://localhost/config", { method: "DELETE" }));
    assertEquals(res.status, 405);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
```

- [ ] **Step 7: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read --allow-write --allow-env dashboard/server_test.ts`
Expected: `server.ts` bulunamadığı için başarısız olur.

- [ ] **Step 8: `dashboard/server.ts`'i yaz**

```typescript
import { createStaticHandler } from "./static.ts";
import { createConfigApi } from "./config_api.ts";

const DEFAULT_PUBLIC_DIR = new URL("./public", import.meta.url).pathname;
const DEFAULT_CONFIG_PATH = "/opt/aundekiosk/config.json";
const DEFAULT_SAMPLE_PATH = new URL("../config.json.sample", import.meta.url).pathname;

export interface HandlerOptions {
  configPath?: string;
  samplePath?: string;
  publicDir?: string;
}

export function createHandler(options: HandlerOptions = {}) {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const configPath = options.configPath ?? Deno.env.get("AUNDEKIOSK_CONFIG_FILE") ?? DEFAULT_CONFIG_PATH;
  const samplePath = options.samplePath ?? DEFAULT_SAMPLE_PATH;

  const serveStatic = createStaticHandler(publicDir);
  const configApi = createConfigApi({ configPath, samplePath });

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/config") {
      if (req.method === "GET") return configApi.handleGet();
      if (req.method === "POST") return configApi.handlePost(req);
      return new Response("Method Not Allowed", { status: 405 });
    }

    return serveStatic(url.pathname);
  };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8080");
  console.log(`AundeKiosk dashboard starting on port ${port}...`);
  Deno.serve({ port }, createHandler());
}
```

- [ ] **Step 9: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read --allow-write --allow-env dashboard/server_test.ts`
Expected: 3 test de PASS.

- [ ] **Step 10: `config.json.sample`, `dashboard/deno.json` ve dashboard systemd şablonunu oluştur**

`config.json.sample` (proje köküne):

```json
{
  "urls": [
    { "url": "https://windy.com/", "duration": 10, "cycles": 10 },
    { "url": "https://time.is/clock", "duration": 10, "cycles": 10 }
  ]
}
```

`dashboard/deno.json`:

```json
{
  "tasks": {
    "start": "deno run --allow-net --allow-read --allow-write --allow-env server.ts",
    "test": "deno test --allow-read --allow-write --allow-env ."
  },
  "compilerOptions": {
    "strict": true
  }
}
```

`services/aundekiosk-dashboard.service.template`:

```ini
[Unit]
Description=Run AundeKiosk dashboard
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/deno run --allow-net --allow-read --allow-write --allow-env /opt/aundekiosk/dashboard/server.ts
WorkingDirectory=/opt/aundekiosk
Environment=PORT=8080
User=aundekiosk
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 11: Commit**

```bash
git add dashboard/server.ts dashboard/server_test.ts dashboard/deno.json config.json.sample services/aundekiosk-dashboard.service.template
git commit -m "feat: wire static files and config API into the dashboard server"
```

---

### Task 6: Privileged Helper Deseni (`privileged/`)

**Files:**
- Create: `privileged/restart-kiosk-services.sh`
- Create: `privileged/sudoers.d/aundekiosk`
- Test: `tests/privileged/restart_kiosk_services_test.sh`
- Test: `tests/privileged/sudoers_test.sh`

**Interfaces:**
- Produces: `privileged/restart-kiosk-services.sh` (argümansız, `aundekiosk-runner.service` ve `aundekiosk-switcher.service`'i restart eder)
- Produces: `privileged/sudoers.d/aundekiosk` (sonraki planlardaki her yeni privileged helper buraya kendi satırını ekler)

- [ ] **Step 1: Helper script için başarısız olacak testi yaz**

`tests/privileged/restart_kiosk_services_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

HELPER="$SCRIPT_DIR/../../privileged/restart-kiosk-services.sh"
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
assert_status 0 $? "restart-kiosk-services.sh exits 0 on success"

args=$(cat "$AUNDEKIOSK_TEST_SYSTEMCTL_ARGS_FILE")
assert_eq "restart aundekiosk-runner.service aundekiosk-switcher.service" "$args" "restart-kiosk-services.sh restarts exactly the two kiosk services"

bash "$HELPER" "unexpected-arg" > "$WORKDIR/reject_output.txt" 2>&1
assert_status 1 $? "restart-kiosk-services.sh rejects any argument"

rm -rf "$WORKDIR"
assert_summary
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `bash tests/privileged/restart_kiosk_services_test.sh`
Expected: script henüz yok, "No such file or directory" ile başarısız olur.

- [ ] **Step 3: `privileged/restart-kiosk-services.sh`'ı yaz**

```bash
#!/usr/bin/env bash
# Privileged helper: restarts the AundeKiosk runtime services.
# Takes NO arguments by design — this script does exactly one fixed thing,
# which is what makes it safe to grant passwordless sudo on without having
# to validate any input.
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "This script takes no arguments." >&2
  exit 1
fi

exec systemctl restart aundekiosk-runner.service aundekiosk-switcher.service
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/restart_kiosk_services_test.sh`
Expected: Tüm satırlar `ok -`, `0 failed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add privileged/restart-kiosk-services.sh tests/privileged/restart_kiosk_services_test.sh
git commit -m "feat: add the first argument-free privileged helper script"
```

- [ ] **Step 6: `sudoers` whitelist dosyasını ve testini yaz**

`privileged/sudoers.d/aundekiosk`:

```
# AundeKiosk privileged helper whitelist.
# The dashboard runs as the unprivileged `aundekiosk` system user and may
# only invoke these exact, argument-free scripts without a password.
# No wildcard arguments are ever granted here — each future privileged
# action gets its own fixed line, added and reviewed individually.
aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/restart-kiosk-services.sh
```

`tests/privileged/sudoers_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
source "$SCRIPT_DIR/../assert.sh"

SUDOERS_FILE="$SCRIPT_DIR/../../privileged/sudoers.d/aundekiosk"

grep -q "^aundekiosk ALL=(root) NOPASSWD: /opt/aundekiosk/privileged/restart-kiosk-services.sh$" "$SUDOERS_FILE"
assert_status 0 $? "sudoers file grants aundekiosk exactly the restart-kiosk-services.sh line"

grep -qE '\*|\$\{|\$\(' "$SUDOERS_FILE"
if [[ $? -eq 0 ]]; then
  assert_eq "no-wildcards" "has-wildcards" "sudoers file contains no wildcard or variable-expansion patterns"
else
  assert_eq "no-wildcards" "no-wildcards" "sudoers file contains no wildcard or variable-expansion patterns"
fi

if command -v visudo >/dev/null 2>&1; then
  visudo -c -f "$SUDOERS_FILE" > /tmp/aundekiosk_visudo_check.txt 2>&1
  assert_status 0 $? "sudoers file passes visudo syntax check"
else
  echo "SKIP - visudo not available on this machine; this will be validated for real on the target Raspberry Pi during install."
fi

assert_summary
```

- [ ] **Step 7: Testi çalıştır, geçtiğini doğrula**

Run: `bash tests/privileged/sudoers_test.sh`
Expected: Windows geliştirme makinesinde `visudo` yok, o satır `SKIP` ile atlanır; diğer iki kontrol `ok -` ile geçer, `0 failed`.

- [ ] **Step 8: Commit**

```bash
git add privileged/sudoers.d/aundekiosk tests/privileged/sudoers_test.sh
git commit -m "feat: add the sudoers whitelist for the first privileged helper"
```

---

### Task 7: i18n Altyapısı (tr/en/de)

**Files:**
- Create: `dashboard/public/i18n.js`
- Test: `dashboard/i18n_test.ts`
- Create: `dashboard/public/locales/tr.json`
- Create: `dashboard/public/locales/en.json`
- Create: `dashboard/public/locales/de.json`
- Create: `dashboard/public/index.html`
- Create: `dashboard/public/style.css`

**Interfaces:**
- Consumes: `dashboard/test_util.ts` → `assertEquals`
- Produces: `dashboard/public/i18n.js` → `resolveString(catalogs, lang, key): string`, `detectInitialLanguage(storedLang, supportedLangs, defaultLang): string`, tarayıcıda `window.aundekiosk.setLanguage(lang)`

- [ ] **Step 1: Başarısız olacak testi yaz**

`dashboard/i18n_test.ts`:

```typescript
import { resolveString, detectInitialLanguage } from "./public/i18n.js";
import { assertEquals } from "./test_util.ts";

const catalogs = {
  tr: { greeting: "Merhaba", onlyTr: "sadece-tr" },
  en: { greeting: "Hello", onlyEn: "only-en" },
  de: { greeting: "Hallo" },
};

Deno.test("resolveString returns the value for the requested language", () => {
  assertEquals(resolveString(catalogs, "de", "greeting"), "Hallo");
});

Deno.test("resolveString falls back to English when the key is missing in the requested language", () => {
  assertEquals(resolveString(catalogs, "de", "onlyEn"), "only-en");
});

Deno.test("resolveString falls back to the key itself when missing everywhere", () => {
  assertEquals(resolveString(catalogs, "de", "missingEverywhere"), "missingEverywhere");
});

Deno.test("detectInitialLanguage uses the stored language when supported", () => {
  assertEquals(detectInitialLanguage("de", ["tr", "en", "de"], "tr"), "de");
});

Deno.test("detectInitialLanguage falls back to the default when stored language is unsupported or missing", () => {
  assertEquals(detectInitialLanguage("fr", ["tr", "en", "de"], "tr"), "tr");
  assertEquals(detectInitialLanguage(null, ["tr", "en", "de"], "tr"), "tr");
});
```

- [ ] **Step 2: Testi çalıştır, başarısız olduğunu doğrula**

Run: `deno test --allow-read dashboard/i18n_test.ts`
Expected: `dashboard/public/i18n.js` henüz yok, başarısız olur.

- [ ] **Step 3: `dashboard/public/i18n.js`'i yaz**

```javascript
// i18n.js — minimal locale resolution, no framework dependency.
// resolveString/detectInitialLanguage have no DOM dependency so Deno can
// import and test them directly; the bootstrap code below only runs in a
// real browser (guarded by the `document`/`window` check at the bottom).

export function resolveString(catalogs, lang, key) {
  const primary = catalogs[lang];
  if (primary && Object.prototype.hasOwnProperty.call(primary, key)) {
    return primary[key];
  }
  const fallback = catalogs.en;
  if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) {
    return fallback[key];
  }
  return key;
}

export function detectInitialLanguage(storedLang, supportedLangs, defaultLang) {
  if (storedLang && supportedLangs.includes(storedLang)) {
    return storedLang;
  }
  return defaultLang;
}

const SUPPORTED_LANGS = ["tr", "en", "de"];
const DEFAULT_LANG = "tr";

async function bootstrapI18n() {
  const catalogs = {};
  for (const lang of SUPPORTED_LANGS) {
    const res = await fetch(`locales/${lang}.json`);
    catalogs[lang] = await res.json();
  }

  let storedLang = null;
  try {
    storedLang = localStorage.getItem("aundekiosk_lang");
  } catch {
    // localStorage unavailable (private mode etc.) — just start from default.
  }
  let lang = detectInitialLanguage(storedLang, SUPPORTED_LANGS, DEFAULT_LANG);

  function applyLanguage(nextLang) {
    lang = nextLang;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = resolveString(catalogs, lang, el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", resolveString(catalogs, lang, el.getAttribute("data-i18n-placeholder")));
    });
    const switcher = document.getElementById("lang-switch");
    if (switcher) switcher.value = lang;
    try {
      localStorage.setItem("aundekiosk_lang", lang);
    } catch {
      // Language choice just won't persist across reloads — safe fallback.
    }
  }

  const switcher = document.getElementById("lang-switch");
  if (switcher) {
    switcher.addEventListener("change", (e) => applyLanguage(e.target.value));
  }

  window.aundekiosk = window.aundekiosk || {};
  window.aundekiosk.setLanguage = applyLanguage;
  applyLanguage(lang);
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrapI18n();
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `deno test --allow-read dashboard/i18n_test.ts`
Expected: 5 test de PASS. (`bootstrapI18n` Deno'da `document` olmadığı için hiç çalışmaz, import sırasında hata vermez.)

- [ ] **Step 5: Çeviri dosyalarını oluştur**

`dashboard/public/locales/tr.json`:

```json
{
  "app_title": "AundeKiosk",
  "nav_add_placeholder": "...ekranlara eklemek için web sayfası URL'leri girin",
  "nav_add_button": "EKLE",
  "nav_apply_button": "UYGULA"
}
```

`dashboard/public/locales/en.json`:

```json
{
  "app_title": "AundeKiosk",
  "nav_add_placeholder": "...add webpage URLs as screens",
  "nav_add_button": "ADD",
  "nav_apply_button": "APPLY"
}
```

`dashboard/public/locales/de.json`:

```json
{
  "app_title": "AundeKiosk",
  "nav_add_placeholder": "...fügen Sie Webseiten-URLs als Bildschirme hinzu",
  "nav_add_button": "HINZUFÜGEN",
  "nav_apply_button": "ANWENDEN"
}
```

- [ ] **Step 6: Dashboard ana sayfasını ve stilini oluştur**

`dashboard/public/index.html`:

```html
<!doctype html>
<html lang="tr" data-bs-theme="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
    <link
      href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
      rel="stylesheet"
      integrity="sha384-QWTKZyjpPEjISv5WaRU9OFeRpok6YctnYmDr5pNlyT2bRjXh0JMhjY6hW+ALEwIH"
      crossorigin="anonymous"
    />
    <link rel="stylesheet" href="style.css" />
    <title>AundeKiosk</title>
  </head>
  <body>
    <nav class="navbar bg-body-tertiary py-3">
      <div class="container-md d-flex flex-wrap align-items-center gap-3">
        <h1 class="my-0" data-i18n="app_title">AundeKiosk</h1>
        <input id="new-url" type="text" class="form-control" data-i18n-placeholder="nav_add_placeholder" />
        <button id="add-url" type="button" class="btn btn-secondary" data-i18n="nav_add_button">ADD</button>
        <button id="execute" type="button" class="btn btn-danger" data-i18n="nav_apply_button">APPLY</button>
        <select id="lang-switch" class="form-select w-auto ms-auto">
          <option value="tr">TR</option>
          <option value="en">EN</option>
          <option value="de">DE</option>
        </select>
      </div>
    </nav>

    <div id="urls" class="container-md my-5">
      <ul class="list-group list-group-flush"></ul>
    </div>

    <script
      src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"
      integrity="sha384-YvpcrYf0tY3lHB60NNkmXc5s9fDVZLESaAA55NDzOxhy9GkcIdslK1eN7N6jIeHz"
      crossorigin="anonymous"
    ></script>
    <script type="module" src="i18n.js"></script>
  </body>
</html>
```

`dashboard/public/style.css`:

```css
body {
  min-height: 100vh;
}
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/public/i18n.js dashboard/i18n_test.ts dashboard/public/locales dashboard/public/index.html dashboard/public/style.css
git commit -m "feat: add tr/en/de i18n infrastructure and the initial dashboard page"
```

---

### Task 8: Kurulum Script'i ve Tam Entegrasyon

**Files:**
- Create: `scripts/setup/common.sh`
- Create: `scripts/setup/install.sh`
- Create: `tests/run_all.sh`

**Interfaces:**
- Consumes: Task 1–7'nin ürettiği her şey (bu task sadece bunları birbirine bağlar, yeni bir arayüz üretmez)

- [ ] **Step 1: `scripts/setup/common.sh`'ı yaz**

```bash
#!/usr/bin/env bash
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    echo "This script should be sourced, not executed." >&2
    exit 1
fi

readonly AUNDEKIOSK_INSTALL_DIR="/opt/aundekiosk"
readonly AUNDEKIOSK_CONFIG_FILE="$AUNDEKIOSK_INSTALL_DIR/config.json"

RESET='\033[0m'
ERROR='\033[1;31m'
SUCCESS='\033[1;32m'
WARNING='\033[1;33m'
INFO='\033[1;34m'
CALLOUT='\033[1;35m'
DEBUG='\033[1;36m'

msg() {
    local color="$1"
    local text="$2"
    echo -e "${color}${text}${RESET}"
}
```

- [ ] **Step 2: `scripts/setup/install.sh`'ı yaz**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
source "$SCRIPT_DIR/common.sh"

msg "$INFO" "Starting AundeKiosk installation..."

PI_USER="${1:-$SUDO_USER}"
if [ -z "$PI_USER" ]; then
    msg "$ERROR" "Could not determine target user. Ensure SUDO_USER is set."
    exit 1
fi
msg "$SUCCESS" "Target user identified as '$PI_USER'."

msg "$INFO" "Installing runtime dependencies (jq, chromium, wtype, xdotool, deno)..."
apt-get update
apt-get install -y jq chromium wtype xdotool unzip
curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

msg "$INFO" "Creating dedicated 'aundekiosk' system user for the dashboard..."
if ! id -u aundekiosk >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin aundekiosk
fi

msg "$INFO" "Making runtime and privileged scripts executable..."
chmod +x "$AUNDEKIOSK_INSTALL_DIR"/runtime/*.sh "$AUNDEKIOSK_INSTALL_DIR"/privileged/*.sh

msg "$INFO" "Setting up configuration file..."
if [ ! -f "$AUNDEKIOSK_CONFIG_FILE" ]; then
    cp "$AUNDEKIOSK_INSTALL_DIR/config.json.sample" "$AUNDEKIOSK_CONFIG_FILE"
    msg "$DEBUG" "Created default config.json from sample."
fi
chown aundekiosk:aundekiosk "$AUNDEKIOSK_CONFIG_FILE"

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

msg "$INFO" "Reloading systemd and enabling services..."
systemctl daemon-reload
systemctl enable aundekiosk-runner.service aundekiosk-switcher.service aundekiosk-dashboard.service
systemctl start aundekiosk-dashboard.service

echo
msg "$CALLOUT" "AundeKiosk is now installed."
echo -e "Dashboard: ${SUCCESS}http://$(hostname -I | cut -d ' ' -f 1):8080/${RESET}"
msg "$WARNING" "The dashboard has NO authentication yet (Plan 2 adds it). Do not expose it beyond a trusted, isolated network segment until Plan 2 is installed."
msg "$WARNING" "Kiosk mode will launch on the next startup."
```

- [ ] **Step 3: Söz dizimini doğrula (çalıştırmadan)**

Run: `bash -n scripts/setup/common.sh && bash -n scripts/setup/install.sh`
Expected: Çıktı yok, exit code 0. (Bu script `apt-get`/`useradd`/`systemctl` çalıştırdığı için gerçek çalıştırma sadece Raspberry Pi üzerinde yapılır — bkz. spec §11.)

- [ ] **Step 4: Tüm bash test paketini birlikte çalıştıran aggregator'ı yaz**

`tests/run_all.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
FAIL=0

for t in \
  "$SCRIPT_DIR/platform/lib_test.sh" \
  "$SCRIPT_DIR/runtime/runner_test.sh" \
  "$SCRIPT_DIR/runtime/switcher_test.sh" \
  "$SCRIPT_DIR/privileged/restart_kiosk_services_test.sh" \
  "$SCRIPT_DIR/privileged/sudoers_test.sh"; do
  echo "=== $t ==="
  bash "$t" || FAIL=1
  echo ""
done

if [[ "$FAIL" -eq 0 ]]; then
  echo "All bash test suites passed."
else
  echo "One or more bash test suites failed."
fi

exit $FAIL
```

- [ ] **Step 5: Tüm test paketini çalıştır, hepsinin geçtiğini doğrula**

Run: `bash tests/run_all.sh`
Expected: Her bölüm için `0 failed`, son satır "All bash test suites passed.", exit code 0.

Run: `deno test --allow-read --allow-write --allow-env dashboard/`
Expected: Task 4, 5, 7'deki tüm Deno testleri PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/setup/common.sh scripts/setup/install.sh tests/run_all.sh
git commit -m "feat: add install script and bash test aggregator, completing Plan 1"
```

**Not:** `install.sh`'ın gerçek davranışı (paket kurulumu, systemd servisleri, kullanıcı oluşturma) kendi başına otomatik test edilmez — bu doğası gereği root/apt/systemd gerektiren, yıkıcı bir deployment script'idir. Spec §11'de belirtildiği gibi, bu script'in doğrulaması **gerçek Pi 4/5 donanımında manuel QA** ile yapılır; Plan 1'in otomatik test kapsamı, script'in çağırdığı her mantık parçasını (platform tespiti, URL çıkarma, statik dosya sunumu, config API, privileged helper, i18n) zaten ayrı ayrı kanıtlamıştır.
