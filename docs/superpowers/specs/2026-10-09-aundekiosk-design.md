# AundeKiosk — Tasarım Dokümanı

**Tarih:** 2026-10-09
**Hazırlayan:** Aunde Teknik IT Ekibi
**Durum:** Onaylandı (brainstorming aşaması tamamlandı), implementasyon planı bekleniyor

## 1. Genel Bakış

AundeKiosk, açık kaynak [xiosk](https://github.com/debloper/xiosk) projesinden ilham alan, **sıfırdan yazılan bağımsız** bir Raspberry Pi kiosk sistemidir: Pi'yi açılışta otomatik olarak tam ekran webpage-shuffler kiosk moduna geçiren ve bunu yönetmek için bir web paneli sunan bir çözüm.

**Hedef ortam:** Kurumsal, SOC/SIEM tarafından izlenen, güvenliği önemsenen bir yerel ağ (LAN). İnternet üzerinden veya VPN ile erişim **desteklenmiyor** — yönetim paneli sadece LAN'dan erişilebilir.

**Temel tasarım ilkesi:** Cihazlar kurumsal ağda zaten izlendiği için, AundeKiosk'un görevi kendi güvenlik izleme sistemini icat etmek değil, **ağda "temiz" davranan, mevcut kurumsal izleme araçlarıyla uyumlu, minimum saldırı yüzeyine sahip** bir sistem olmaktır (şifresiz trafik yok, varsayılan kimlik bilgisi yok, gereksiz açık port/servis yok, standart protokoller — SNMPv3 gibi).

## 2. Hedef Donanım ve Platform

- **Tam destekli & test edilecek:** Raspberry Pi 4, Raspberry Pi 5 — Raspberry Pi OS Bookworm, Wayland/labwc (varsayılan).
- **Best-effort (topluluk desteği, resmi test kapsamı dışı):** Pi 3, Pi 2, Zero 2 W ve diğer eski modeller. Düşük RAM'li cihazlarda (512MB–1GB) Resource Monitor eşiklerinin daha düşük tutulması kurulumda önerilir.
- **Ekran sunucusu tespiti runtime'da yapılır** (build-time değil): `$WAYLAND_DISPLAY` set edilmişse Wayland (`wtype` kullanılır), değilse X11 varsayılır (`xdotool` kullanılır). Bu sayede Pi 4/5'te biri X11 masaüstü seçse bile sistem çalışır.
- Model tespiti: `/proc/device-tree/model` okunur, `PI_MODEL` olarak paylaşılan bir ortam değişkenine yazılır (`common.sh` benzeri merkezi bir script üzerinden `runner.sh`/`switcher.sh` tarafından kullanılır).

## 3. Hedefler

1. Pi 4/5'te (ve best-effort diğer modellerde) kararlı kiosk modu; cihaz açıldığında doğrudan kiosk moduna geçer (manuel müdahale gerekmez).
2. Root olmayan web dashboard + whitelist'li "privileged helper" script mimarisi: **bir web açığı bulunsa bile saldırgan sadece önceden tanımlı, sabit/doğrulanmış parametreli işlemleri tetikleyebilir — keyfi kod çalıştıramaz.**
3. Yapılandırılabilir, matematiksel olarak doğru CPU/RAM eşik tabanlı otomatik müdahale; eşik seviyesi yükseldikçe müdahale kademeli olarak sertleşir (hafif temizlikten tam reboot'a).
4. Dashboard üzerinden: SSH aç/kapat, ağ (IP/WiFi) ayarları, OS hesabı şifre değişimi, SNMPv3 yapılandırması.
5. Dashboard'un kendi girişi (web oturumu) ile Raspberry Pi OS hesabının kimlik bilgileri **birbirinden tamamen ayrı** yönetilir.
6. Türkçe (varsayılan) / İngilizce / Almanca arayüz desteği.

## 4. Kapsam Dışı (Non-Goals / YAGNI)

- **Özel SIEM/antivirüs izleme paneli kurulmayacak.** Ağdaki mevcut SOC/SIEM araçlarıyla çakışmamak ve gereksiz alarm tetiklememek önceliklidir; izleme entegrasyonu standart SNMPv3 üzerinden sağlanır, AundeKiosk kendi özel telemetri protokolünü icat etmez.
- VPN veya internet üzerinden uzaktan erişim desteklenmeyecek — sadece LAN.
- Çoklu cihaz "fleet management" merkezi paneli bu sürümde yok; her Pi kendi dashboard'unu yönetir, merkezi izleme kurumun kendi NMS'i (SNMP üzerinden) tarafından yapılır.
- Zorunlu 2FA yok. Opsiyonel TOTP desteği sunulur, varsayılan kapalı.
- Belirli bir NMS platformuna özel entegrasyon yok; genel/standart MIB seti (`HOST-RESOURCES-MIB`) hedeflenir.

## 5. Mimari

### 5.1 Bileşenler

1. **Kiosk Runtime** (ayrıcalıksız `pi` kullanıcısı, systemd `graphical.target`'a bağlı):
   - *Runner*: Açılışta Chromium'u kiosk modunda, `config.json`'daki URL'lerle başlatır.
   - *Switcher*: Sekmeler arası geçiş/yenileme; Wayland'da `wtype`, X11'de `xdotool` (runtime tespiti ile).

2. **Dashboard** (ayrıcalıksız sistem kullanıcısı, **root DEĞİL**, yüksek port — örn. 8080, sadece LAN):
   - Deno + TypeScript tabanlı web UI + API.
   - Kendi login/oturum sistemi.
   - Sistemi değiştiren her işlem için privileged helper'ları **sadece önceden tanımlı whitelist komutlarıyla** çağırır.

3. **Privileged Helper Scripts** (root, `sudoers` ile dar kapsamlı NOPASSWD izni, her biri tek amaçlı):
   - `toggle-ssh.sh`, `configure-network.sh`, `change-os-password.sh`, `reboot-device.sh`, `restart-kiosk-services.sh`, `configure-snmp.sh`.
   - Her script kendi girdisini **sabit regex/enum ile doğrular**; parametreler shell array olarak geçirilir (`eval` veya string concatenation **yok**) — komut enjeksiyonuna karşı yapısal koruma.

4. **Resource Monitor** (arka plan servisi; `/proc` okuma için root gerekebilir ama aksiyon için her zaman privileged helper'ı çağırır, doğrudan `systemctl`/`reboot` çağırmaz).

5. **SNMPv3 Agent** (`net-snmp`/`snmpd`), kimlik bilgileri `configure-snmp.sh` üzerinden ayarlanır.

6. **i18n Katmanı**: `locales/tr.json` (varsayılan), `locales/en.json`, `locales/de.json`.

7. **Kimlik Doğrulama (ikili, ayrı yönetilen):** Dashboard login (web oturumu) ↔ OS hesap şifresi (SSH/sistem girişi).

### 5.2 Neden bu mimari (alternatiflere karşı)

Değerlendirilen 3 seçenek arasından, "web açığı bulunsa bile saldırgan keyfi kod çalıştıramasın" şartı gereği, dashboard'un **root olmadan** çalışıp sistemi değiştiren işlemleri **dar kapsamlı, whitelist'li `sudoers` izinleri** üzerinden privileged helper'lara devrettiği model seçildi. Bu, tam ayrıştırılmış IPC mimarisinin (ayrı bir "privileged core" süreci + IPC kanalı) güvenlik faydasının büyük kısmını, çok daha az ek karmaşıklıkla sağlar.

## 6. Auth & Oturum Yönetimi

- **İlk kurulum zorunlu "first-run wizard":** Varsayılan kimlik bilgisi (admin/admin vb.) **yok**; kullanıcı ilk kullanıcı adı/şifreyi kendisi belirlemeden dashboard aktif olmaz.
- Şifreler **argon2id** ile hash'lenir, ayrı bir dosyada (`600` izin, sadece servis kullanıcısı okuyabilir) saklanır — **`config.json` içine asla girmez.**
- Oturumlar: sunucu taraflı, rastgele 256-bit session token, **HttpOnly + SameSite=Strict** cookie, 30 dakika hareketsizlikte otomatik sonlanma.
- **Taşıma güvenliği:** Varsayılan olarak **self-signed TLS** ile HTTPS; kurulumda tarayıcı sertifika uyarısının nasıl yönetileceği belgelenir (veya kurumun kendi dahili CA sertifikası kullanılabilir).
- **Brute-force koruması:** IP bazlı hız sınırlama + 5 başarısız denemede artan süreli hesap kilitleme.
- **Audit log:** Tüm auth olayları (giriş/çıkış/kilitleme/şifre değişimi) ve **tüm privileged aksiyonlar** (SSH, ağ, reboot, SNMP) zaman damgası + kaynak IP ile **append-only** log dosyasına yazılır. **Audit log her zaman İngilizce** tutulur (UI dili ne olursa olsun), log tutarlılığı ve olası SIEM/log analiz araçlarıyla uyumluluk için.
- **OS hesabı şifre değişimi — step-up auth:** Bu işlem öncesi kullanıcı geçerli dashboard şifresini tekrar girmek zorundadır (oturum açık bırakılmış bir cihazda yetkisiz şifre değişimini engeller). Aynı step-up auth kuralı SSH ayarları için de geçerlidir.
- **Opsiyonel TOTP 2FA:** Ayarlardan isteğe bağlı açılabilir, varsayılan kapalı (YAGNI).

## 7. Resource Monitor — Eşik & Histerezis Mantığı

### 7.1 Ölçüm formülleri

- **CPU%**: `/proc/stat`'tan iki örnekleme arasındaki delta ile hesaplanır (anlık değer veya `/proc/loadavg` **kullanılmaz** — loadavg yüzde değil, farklı bir üstel ortalama metriğidir):
  ```
  busy = user + nice + system + irq + softirq + steal
  idle_total = idle + iowait
  total = busy + idle_total
  CPU% = Δbusy / Δtotal × 100   (iki örnekleme arasında)
  ```
- **RAM%**: `/proc/meminfo`'dan `MemAvailable` kullanılır (`MemFree` **kullanılmaz** — cache/buffer geri kazanılabilir bellek olduğu için `MemFree` yanlış-pozitif üretir):
  ```
  RAM% = (MemTotal - MemAvailable) / MemTotal × 100
  ```

### 7.2 Kademeli eşik yapısı (dashboard'dan düzenlenebilir)

```
tier = { threshold: %, sustained_samples: N, action: "log" | "restart_services" | "reboot", cooldown: saniye }
```
Varsayılan öneri (kullanıcı değiştirebilir): 70% / 10 örnek → `log`; 80% / 10 örnek → `restart_services`; 90% / 5 örnek → `reboot`. Örnekleme periyodu varsayılan 10 saniye.

### 7.3 Durum makinesi (histerezis + cooldown)

1. Her periyotta CPU% ve RAM% ölçülür.
2. Her kademe için: değer ≥ `threshold` ise `consecutive_count++`; değer < `threshold - 2 puan margin` ise `consecutive_count = 0` (sınırda salınımı önlemek için histerezis bandı).
3. `consecutive_count ≥ sustained_samples` ve kademe cooldown'da değilse → aksiyon tetiklenir, o kademenin cooldown süresi başlar.
4. Aynı anda birden fazla kademe tetiklenirse **en sert aksiyon (reboot) önceliklidir**, diğerleri o periyotta atlanır.
5. Her tetikleme audit log'a yazılır (metrik, değer, kademe, aksiyon, zaman).

### 7.4 İzleme penceresi

Config'de opsiyonel saat aralığı (varsayılan: her zaman aktif, `00:00-23:59`). Pencere dışında monitor hiçbir ölçüm/aksiyon yapmaz. **Not:** Zaman aralığı sadece *ne zaman kontrol/aksiyon yapılacağını* belirler; eşik aşıldığında uygulanacak aksiyon (log/restart/reboot) zaman aralığından bağımsız olarak kademeye göre sabittir.

### 7.5 Aksiyon uygulaması

`restart_services` ve `reboot` aksiyonları, Resource Monitor tarafından doğrudan değil, Bölüm 5.1'deki privileged helper'lar (`restart-kiosk-services.sh`, `reboot-device.sh`) üzerinden tetiklenir.

## 8. SSH / Ağ / SNMP Modülü

### 8.1 SSH Yönetimi

- `sshd` servisi enable/disable + start/stop; durum göstergesi.
- Varsayılan: **kapalı**.
- Opsiyonel sertleştirme: "Şifre ile girişi kapat, sadece SSH key ile giriş" toggle'ı.
- Step-up auth gerektirir (Bölüm 6).

### 8.2 Ağ (IP) Yönetimi

- Arayüzler: Ethernet (`eth0`), WiFi (`wlan0`).
- Mod: DHCP (varsayılan) veya Statik (IP/CIDR, Gateway, DNS).
- WiFi: SSID + WPA2/WPA3 parola.
- Uygulama: **NetworkManager (`nmcli`)** — Bookworm'un varsayılan ağ yöneticisi; eski `dhcpcd.conf` düzenleme yöntemi kullanılmaz.
- **"Onayla ya da geri al" mekanizması:** Yeni ağ ayarı uygulandıktan sonra **60 saniye içinde** kullanıcı dashboard üzerinden erişimini onaylamazsa, sistem **otomatik olarak önceki çalışan ayara geri döner**. Bu, hatalı statik IP/gateway girişinin cihazı erişilemez hale getirmesini (özellikle fiziksel erişimin her zaman mümkün olmadığı senaryolarda) önler.

### 8.3 SNMP (SNMPv3 only)

- Sadece **SNMPv3** desteklenir; v1/v2c (düz metin community string) hiç sunulmaz.
- Alanlar: kullanıcı adı, auth protokolü (SHA/SHA-256) + auth parolası, priv protokolü (AES) + priv parolası, engine ID (otomatik üretilir).
- **Kaynak IP kısıtlaması:** `snmpd.conf`'ta sadece belirlenen NMS sunucusu/subnet'inden sorgu kabul edilir.
- Standart MIB seti: `HOST-RESOURCES-MIB` (CPU/bellek) — genel amaçlı, belirli bir NMS platformuna özel entegrasyon gerektirmez.

### 8.4 Ortak güvenlik prensibi

Dashboard'dan gelen hiçbir veri doğrudan shell string'e eklenmez; privileged helper'lar girdiyi sabit regex/enum ile doğrular, parametreleri shell array olarak geçirir.

## 9. i18n (Çoklu Dil)

- Dosya yapısı: `locales/tr.json` (varsayılan), `locales/en.json`, `locales/de.json` — düz key-value çeviri dosyaları.
- Dashboard'da dil seçici; seçim `localStorage`'da saklanır.
- Eksik çeviri anahtarı → İngilizce'ye, o da yoksa anahtar adına düşer.
- **Audit log ve sistem logları her zaman İngilizce** (Bölüm 6'da belirtildiği gibi) — UI dilinden bağımsız.

## 10. Teknoloji Seçimleri

- **Backend:** Deno + TypeScript (tek binary'ye compile edilebilir, `--allow-*` izinleri dar tutulur).
- **Frontend:** Vanilla JS + Bootstrap 5 (az bağımlılık).
- **Privileged helpers:** Bash, `set -euo pipefail` zorunlu, `shellcheck` ile denetlenir.
- **SNMP:** `net-snmp` (`snmpd`), SNMPv3 only.
- **Ağ:** NetworkManager (`nmcli`).
- **Config depolama:** `config.json` (kiosk URL listesi, hassas veri içermez) + ayrı `auth.db`/credential store (asla `config.json` içinde değil, kısıtlı dosya izinleriyle).

## 11. Test Stratejisi (üst seviye)

- Privileged helper'lar: girdi doğrulama unit testleri (regex/enum sınır durumları, enjeksiyon denemeleri).
- Resource Monitor durum makinesi: histerezis/cooldown senaryoları, sentetik `/proc/stat` ve `/proc/meminfo` girdileriyle.
- Ağ "onayla/geri al" mekanizması: timeout senaryosu testi.
- Gerçek donanımda (Pi 4 ve Pi 5 fiziksel cihaz) manuel QA; en az bir best-effort model (örn. Pi 3) üzerinde duman testi.

## 12. Açık Riskler / İmplementasyon Planında Netleştirilecekler

- SSH port değiştirme / key-only toggle'ın detaylı UX akışı.
- Self-signed TLS sertifikası üretim/yenileme akışı ve kurumsal dahili CA desteği seçeneği.
- Best-effort donanımlar için varsayılan eşik önerilerinin tam değerleri.
