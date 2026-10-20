# Video Playback Implementation Plan (v2)

**Goal:** Dashboard'dan MP4 yükle; (1) otomatik modda URL döngüsüne video ekle, (2) manuel modda tek video sürekli dönsün.

**Mimari:**
```
Otomatik mod:  config.json urls[] → video item → switcher.sh poll → video-done signal → devam
Manuel mod:    /play-video → play-video.sh → switcher.sh dur → video loop → /stop-video → switcher.sh başla
```

**Config şeması (genişletilmiş, geriye dönük uyumlu):**
```json
{ "urls": [
    { "url": "https://example.com", "duration": 30, "cycles": 0 },
    { "type": "video", "filename": "ISRI TR Rev_09 10 2026.mp4" }
]}
```

**Sinyal dosyaları:** `/opt/aundekiosk/state/video-done` · `/opt/aundekiosk/state/video-stop` · `/opt/aundekiosk/state/video-request`

**Chromium cert notu:** `runner.sh`'e `--ignore-certificate-errors` eklenir — kiosk zaten self-signed cert kullanıyor, LAN-only fabrika ortamında standart tercih.

---

## Dosya Haritası

| İşlem | Dosya | Neden |
|-------|-------|-------|
| Değişiklik | `dashboard/config_api.ts` | VideoItem tipi + validasyon |
| Değişiklik | `platform/lib.sh` | `item_snapshot`, `first_url_in_config` |
| Değişiklik | `runtime/switcher.sh` | Video item handling + poll |
| Değişiklik | `runtime/runner.sh` | `first_url_in_config` + cert flag |
| Yeni | `dashboard/video_api.ts` | Upload/serve/list/delete/play/stop/done |
| Değişiklik | `dashboard/server.ts` | Route bağlantısı |
| Yeni | `dashboard/public/video-player.html` | Fullscreen player (auto/manual) |
| Değişiklik | `dashboard/static.ts` | .mp4 content type |
| Değişiklik | `dashboard/public/index.html` | Video sekmesi + config'de video item UI |
| Yeni | `privileged/play-video.sh` | Manuel mod orchestration |
| Değişiklik | `privileged/sudoers.d/aundekiosk` | play-video.sh satırı |
| Değişiklik | `scripts/setup/install.sh` | videos/ ve state/ dizinleri |

---

## Task 1 — Config şeması + validasyon

**Task 2 — lib.sh + switcher + runner (otomatik mod)**

**Task 3 — Video API + depolama**

**Task 4 — Video player HTML**

**Task 5 — Manuel mod privileged script + Dashboard UI**

**Task 6 — Deploy + uçtan uca test**
