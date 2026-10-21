# AundeKiosk — Claude Context

## Proje
AundeKiosk, Raspberry Pi cihazlarını web kiosk olarak yönetmek için sıfırdan yazılmış (fork değil) bir sistemdir. "Aunde Teknik IT Ekibi" projesi. GitHub: `https://github.com/turgaypek/aundekiosk.git`, varsayılan dal `master`.

**Tek satır kurulum/güncelleme:**
```bash
curl -sSL https://raw.githubusercontent.com/turgaypek/aundekiosk/master/scripts/setup/bootstrap.sh | sudo bash -s -- --install
curl -sSL https://raw.githubusercontent.com/turgaypek/aundekiosk/master/scripts/setup/bootstrap.sh | sudo bash -s -- --update
```

## Mimari
- **Dashboard:** Deno + TypeScript, HTTPS :8080, `dashboard/server.ts` entry point
- **Kullanıcı:** `aundekiosk` (unprivileged system user, no home dir)
- **Kurulum dizini:** `/opt/aundekiosk/` (aundekiosk kullanıcısına ait)
- **Deno cache:** `/opt/aundekiosk/.deno/` — install.sh tarafından önceden cache'lenir; servise `DENO_DIR` env olarak verilir
- **Auth:** Argon2id (npm:hash-wasm@4.11.0), session cookie (256-bit), step-up re-auth for destructive ops
- **Kiosk runtime:** Wayland + Chromium kiosk modu, URL rotasyonu CDP üzerinden (`runtime/cdp-navigate.py`)

## Güvenlik Modeli (EN KRİTİK)
Privileged-helper modeli: her ayrıcalıklı işlem (reboot, SSH toggle, şifre değiştirme, ağ config) `/opt/aundekiosk/privileged/` altındaki root-owned, tek amaçlı bash scriptlerine sudoers whitelist ile delege edilir. Dashboard-writable hiçbir path sudo whitelist'e girmez. Sırlar (şifre, WiFi PSK, SNMP) her zaman stdin üzerinden JSON olarak iletilir, argv üzerinden asla (argv /proc'tan okunabilir).

Yeni ayrıcalıklı eylem eklenirken bu modelden sapılmaz. Bkz: `dashboard/privileged_runner.ts`, `scripts/setup/install.sh` sudoers bölümü.

## Tamamlanmış Planlar (2026-10-13 itibarıyla)
1. Platform & kiosk runtime
2. Auth & session security
3. Resource monitor (CPU/RAM eşik bazlı, hysteresis, log→restart→reboot zinciri)
4. SSH/Network/SNMP modülü (step-up re-auth ile korunan)
- A: SSH/VNC/Hostname/Network/SNMP/OS-password admin panel kontrolleri
- B: Dashboard üzerinden apt update/upgrade (systemd-run ile detached)
- C: Çok kullanıcılı dashboard hesapları + audit log viewer
- D: Loopback-only `aundekiosk-recover` şifre kurtarma aracı

## Son Eklenen Özellikler (2026-10-20)
- Dashboard header'ında inline düzenlenebilir konum/lokasyon etiketi (`config.json`'a kaydedilir)
- Cihaz bilgi paneli: Pi modeli, RAM, kernel, disk, CPU sıcaklığı, hostname, IP/gateway/DNS, DHCP/static
- Yeniden Başlat (Restart) butonu — onay dialog'u ile, `btn-outline-danger`
- "Masaüstü aç" / "Terminal aç" butonları `btn-outline-primary` olarak güncellendi
- `update.sh` düzeltmeleri: `$HOME` export, `git stash -u` eklendi
- `.gitignore`'a runtime dosyaları eklendi (`.deno/`, `tls/`, `config.json`, `monitor-config.json`, `*.db`, `audit.log`, `videos/`, `state/`) — `git stash -u`'nun bunları almaması için kritik

## Geliştirme Ortamı
- Dev: Windows + Git Bash (veya PowerShell), gerçek Pi testleri SSH ile
- Hedef: Raspberry Pi OS Bookworm (Linux)
- Pi'lere erişim: SSH (`pi` kullanıcısı), Pi'nin ağ adresi Pi'ye göre değişir
- Şifreler CLAUDE.md'ye yazılmaz — kullanıcıdan sor veya memory dosyalarına bak

## Çalışma Tercihleri
- Türkçe konuşma, İngilizce kod/commit/docs
- Güvenlik her zaman önce gelir
- Doğrudan master'a commit, feature branch yok
- Büyük değişiklikler için: brainstorm → spec → plan → Native TDD → opus final review → fix pass
- Küçük değişiklikler için: direkt implement et, gereksiz plan yazma

## Önemli Dosyalar
| Dosya | Amaç |
|-------|------|
| `dashboard/server.ts` | Ana HTTP sunucu, tüm endpoint routing |
| `dashboard/auth/password.ts` | Argon2id hash (hash-wasm) |
| `dashboard/privileged_runner.ts` | sudo whitelist üzerinden komut çalıştırma |
| `privileged/*.sh` | Root-owned ayrıcalıklı scriptler |
| `scripts/setup/install.sh` | Kurulum: user, sudoers, Deno cache, systemd |
| `scripts/setup/update.sh` | Güncelleme: git stash -u, pull, install.sh |
| `runtime/runner.sh` | Chromium kiosk başlatma |
| `runtime/switcher.sh` | URL rotasyonu (CDP ile) |
| `dashboard/public/index.html` | Dashboard UI |
| `dashboard/public/script.js` | Dashboard frontend logic |

## Pi Ağ Topolojisi
Pi cihazlarının IP adresleri ve durumları `.claude/memory/aundekiosk_project.md` dosyasında tutulur — CLAUDE.md'ye ağ/IP bilgisi yazılmaz.
