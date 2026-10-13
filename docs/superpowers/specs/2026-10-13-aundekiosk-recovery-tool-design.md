# AundeKiosk — Kurtarma Aracı (Sub-project D) Tasarım Dokümanı

**Tarih:** 2026-10-13
**Hazırlayan:** Aunde Teknik IT Ekibi
**Durum:** Onaylandı (brainstorming aşaması tamamlandı), implementasyon planı bekleniyor
**Bağlam:** Admin paneli genişletme serisinin son parçası (A: SSH/VNC/Hostname/Ağ/SNMP/OS-şifre → C: çoklu kullanıcı + audit log → B: apt update/upgrade → **D: bağımsız şifre kurtarma aracı**).

## 1. Problem ve Amaç

Dashboard'un kendi girişi (web oturumu) tamamen ayrı bir kimlik bilgisi seti kullanıyor (bkz. ana tasarım dokümanı §5). Bu, güvenlik açısından doğru bir ayrım, ama bir **kilitlenme senaryosu** yaratıyor: dashboard şifresi unutulursa, ya da (sub-project C ile gelen çoklu kullanıcı özelliği sayesinde) son kullanıcı yanlışlıkla silinirse/kilitlenirse, dashboard'a web üzerinden girmenin **hiçbir yolu kalmaz** — OS/SSH şifresi bilinse bile.

Bu doküman, bu durumdan kurtulmak için **dashboard'dan tamamen bağımsız, ayrı bir küçük program**'ın tasarımını kapsar: SSH + sudo erişimi olan biri, dashboard'daki kullanıcılardan birinin şifresini sıfırlayabilir (veya `auth.db` tamamen boş/bozuksa yeni bir admin oluşturabilir).

## 2. Hedefler

1. Dashboard'a hiçbir şekilde giriş yapılamadığı durumda, SSH + sudo erişimi olan bir admin'in dashboard kullanıcı şifresini sıfırlayabilmesi (veya ilk admin'i yeniden oluşturabilmesi).
2. Bu aracın **kendi başına yeni bir güvenlik açığı yaratmaması**: ağa açık olmaması, kendi login ekranı olmaması (yetki zaten "bu cihazda root'sunuz" olgusuyla geliyor).
3. Aynı kod tabanının (özellikle `credential_store.ts`) yeniden kullanılması — şifre hashleme/doğrulama mantığının iki yerde ayrı ayrı yaşamaması.
4. İşlemin audit log'a yazılması (spec'in genel "her türlü değişikliği görelim" ilkesiyle tutarlı).
5. Aracın **asla sürekli çalışan bir servis olmaması** — sadece ihtiyaç anında elle başlatılması.

## 3. Kapsam Dışı (Non-Goals)

- OS/SSH/VNC şifresinin kurtarılması bu aracın kapsamında DEĞİL — bu zaten standart Raspberry Pi OS kurtarma yöntemleriyle (fiziksel konsol, `passwd`, `raspi-config`) çözülebilir bir problem; bu araç özel olarak sadece **dashboard'un kendi** kimlik deposunu (`auth.db`) hedefler.
- Kullanıcı oluşturma/silme (tam CRUD) bu aracın kapsamında değil — sadece **mevcut bir kullanıcının şifresini sıfırlama** ve **hiç kullanıcı yoksa ilk admin'i oluşturma**. Dashboard'un kendi "Kullanıcılar" paneli zaten tam CRUD sağlıyor; kurtarma aracı bilinçli olarak minimal tutulur (YAGNI — kurtarma senaryosunda daha fazla özellik, daha fazla risk).
- Ağ üzerinden (LAN'ın başka bir noktasından) erişim yok — sadece `127.0.0.1`.
- Dashboard'un kendi `privileged/` + sudoers whitelist mimarisi bu araç için **kullanılmaz** (bkz. §5.3 — bilinçli bir istisna, gerekçesiyle birlikte).

## 4. Erişim ve Çalıştırma Modeli

- Aracın adı: `recovery/server.ts` (dashboard'dan ayrı bir Deno script'i, `dashboard/` dizininin dışında, kendi dizininde).
- `install.sh`, `/usr/local/bin/aundekiosk-recover` adında ince bir bash wrapper kurar; bu wrapper sadece `exec deno run ... /opt/aundekiosk/recovery/server.ts "$@"` çağırır.
- Admin, Pi'ye SSH ile bağlanıp şunu çalıştırır:
  ```
  sudo aundekiosk-recover
  ```
- Sunucu **sadece `127.0.0.1:8099`**'a bağlanır (dashboard'un 8080 portundan farklı, aynı anda ikisi de çalışabilir). Admin, Pi'nin kendi tarayıcısından ya da `ssh -L 8099:localhost:8099 pi@<ip>` port-forward'ı ile kendi makinesinden erişir.
- **Kendi login ekranı YOK.** Yetkilendirme zaten "bu süreci root olarak başlatabilmiş olmak" ile sağlanıyor — fiziksel konsol erişimiyle aynı güven seviyesi.
- **Hiçbir zaman systemd servisi olarak kurulmaz, enable edilmez, boot'ta başlamaz.** Sadece elle başlatılır, elle (Ctrl+C) durdurulur.
- Güvenlik ağı: 10 dakika boyunca hiç HTTP isteği gelmezse süreç kendiliğinden sonlanır (unutulup açık kalma riskine karşı).

## 5. Mimari

### 5.1 Bileşenler

- `recovery/server.ts` — tek dosyalık bir Deno HTTP sunucusu. `dashboard/auth/credential_store.ts`'i doğrudan import eder (kod tekrarı yok). `dashboard/auth/audit_log.ts`'i de import eder.
- `recovery/public/index.html` (tek dosya, **dashboard/public/'a hiç bağımlı değil** — dashboard'un kendi statik dosyaları bozulmuş/eksik olsa bile bu araç çalışabilsin diye kasıtlı olarak izole). Inline CSS, inline minimal JS; harici dosya/CDN bağımlılığı yok.
- `scripts/setup/install-recovery-wrapper.sh` değil — mevcut `scripts/setup/install.sh`'a küçük bir blok eklenir (yeni bir ayrı script dosyası YAGNI, mevcut install akışına bir adım eklemek yeterli).

### 5.2 Sayfa Davranışı

Sayfa her yüklendiğinde `auth.db`'nin GÜNCEL halini okur (önbellek yok, oturum yok):

- **Kullanıcı(lar) varsa:** kullanıcı adlarının listelendiği bir seçim + yeni şifre alanı + "Şifreyi Sıfırla" butonu.
- **Hiç kullanıcı yoksa** (silinmiş/bozuk `auth.db`): kullanıcı adı + şifre alanlarıyla yeni bir ilk admin oluşturma formu (dashboard'un ilk-kurulum ekranıyla aynı mantık).

İşlem sonrası düz bir başarı/hata mesajı gösterilir.

### 5.3 `privileged/` Mimarisinden Bilinçli Sapma

Projenin genel güvenlik modeli şudur: dashboard **ayrıcalıksız** çalışır, her hassas işlem **root-owned, sudoers-whitelisted, tek-amaçlı** bir `privileged/*.sh` script'i üzerinden yapılır — çünkü dashboard'daki bir web açığı, saldırganın keyfi kod çalıştırmasına değil, sadece önceden tanımlı sabit komutları tetiklemesine izin vermeli.

Kurtarma aracı bu modele **uymaz**, çünkü zaten en baştan root olarak (sudo ile) başlatılıyor — ayrıcalıksız bir süreçten gelen, whitelist'le sınırlanması gereken bir istek yok. Burada korunması gereken saldırı yüzeyi **yok**: araç ağa kapalı, kendi başına bir giriş noktası değil, sadece zaten root yetkisi olan birinin elle çalıştırdığı bir yardımcı. Bu yüzden `credential_store.ts`'e doğrudan dosya yazma izni verilir (privileged-helper dolaylamasına gerek yok).

### 5.4 Veri Akışı

1. Admin formu doldurur, "Şifreyi Sıfırla"ya basar.
2. Tarayıcı `POST /reset-password` ile `{username, newPassword}` gönderir.
3. `recovery/server.ts`, `credential_store.ts`'e eklenecek yeni `resetPassword(username, newPassword)` metodunu çağırır (mevcut `createUser`/`deleteUser` ile aynı desen — serialize edilmiş, atomik yazma). Bu metod yeni şifre hash'ini yazarken **`failedAttempts`'i 0'a, `lockedUntil`'i null'a da sıfırlar** — aksi halde "hesap kilitlendiği için giremiyorum" senaryosunda şifre sıfırlansa bile kilit devam eder, kurtarma aracının asıl amacı boşa çıkar.
4. Şifre politikası dashboard'la **aynı** (min. 12 karakter) — bu sabit şu an hem `auth_api.ts` hem `users_api.ts` içinde ayrı ayrı yerel sabit olarak tanımlı (`MIN_PASSWORD_LENGTH = 12`); bu üç kullanım noktasının (iki mevcut + kurtarma aracı) aynı değeri paylaşması için sabit `credential_store.ts`'e (ya da `password.ts`'e) taşınır, tek kaynağa indirgenir.
5. Başarı/başarısızlık `audit.log`'a `password_reset_via_recovery_tool` olayı olarak yazılır: `{timestamp, event, username, ok}` (ip alanı yok — zaten her zaman loopback).
6. `credential_store.ts` her okumada diskten taze okuduğu için, dashboard servisini yeniden başlatmaya gerek YOK — admin hemen yeni şifreyle giriş yapabilir.
7. Hiç kullanıcı yoksa aynı akış, `createInitialAdmin(username, password)`'ı çağırır (zaten mevcut metod).

### 5.5 Dayanıklılık Notu

`auth.db` dosyası eksikse (ilk kurulumdan önce) ya da tamamen boşsa, kurtarma aracı bunu "hiç kullanıcı yok" durumu olarak ele alır (mevcut `credential_store.ts` davranışı zaten böyle — `read()` `NotFound` hatasını `{users: []}` olarak ele alıyor).

## 6. Kurulum ve Test

- `scripts/setup/install.sh`: `recovery/` dizinini (git ile zaten gelir) `chmod +x` yapmaya gerek yok (script doğrudan `deno run` ile çağrılıyor); `/usr/local/bin/aundekiosk-recover` wrapper'ını `install -m 0755` ile kurar (idempotent — mevcut install.sh deseniyle aynı).
- Yeni Deno testleri:
  - `dashboard/auth/credential_store_test.ts`'e `resetPassword` için testler (var olan kullanıcı, var olmayan kullanıcı → hata, şifre politikası).
  - `recovery/server_test.ts` (yeni) — dashboard'un kendi API testleriyle aynı stil: geçici dizin, fetch tabanlı istekler, audit log doğrulaması.
- Yeni bash testi: `tests/setup/install_test.sh`'a, wrapper'ın kurulduğunu doğrulayan grep tabanlı assertion'lar (mevcut desenle aynı).
- `tests/run_all.sh`'a yeni test dosyaları eklenir (bu oturumda daha önce unutulup sonradan yakalanan bir hata — bu sefer baştan eklenecek).

## 7. Açık Noktalar / Riskler

- Port 8099 keyfi seçildi; kurulumda bir çakışma olursa (başka bir servis bu portu kullanıyorsa) sunucu başlangıçta anlaşılır bir hata ile durmalı (zaten Deno'nun `Deno.serve` davranışı bunu sağlıyor — `AddrInUse` hatası net bir mesajla çıkar).
- Araç çalışırken dashboard da çalışıyor olabilir (iki ayrı süreç, iki ayrı port) — bu kasıtlı, çakışma yok.
