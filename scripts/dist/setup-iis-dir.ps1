# AundeKiosk - IIS Dagiitim Dizini Tek Seferlik Kurulum
#
# Bu scripti IIS sunucusunda (192.168.6.80) ADMINISTRATOR olarak calistirin.
# Sadece bir kez yapmak yeterlidir.
#
# Yaptiginiz:
#   - C:\inetpub\wwwroot\aundekiosk-dist\ klasoru olusturur
#   - .gz ve .sh dosyalarinin dogru MIME type ile sunulmasi icin web.config ekler
#   - http://192.168.6.80/aundekiosk-dist/ adresinde yayina girer
#
# Kullanim:
#   powershell -ExecutionPolicy Bypass -File setup-iis-dir.ps1

$distDir  = "C:\inetpub\wwwroot\aundekiosk-dist"
$testUrl  = "http://192.168.6.80/aundekiosk-dist/"

Write-Host ""
Write-Host "=== AundeKiosk IIS Dagiitim Dizini Kurulumu ===" -ForegroundColor Cyan
Write-Host "Dizin: $distDir"
Write-Host ""

# IIS kontrolu
if (-not (Get-Service W3SVC -ErrorAction SilentlyContinue)) {
    Write-Error "IIS (W3SVC) bu makinede bulunamadi. Bu scripti 192.168.6.80 sunucusunda calistirin."
}

# Klasor olustur
if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir -Force | Out-Null
    Write-Host "Klasor olusturuldu: $distDir" -ForegroundColor Green
} else {
    Write-Host "Klasor zaten var: $distDir" -ForegroundColor Gray
}

# web.config: .gz ve .sh icin dogru MIME types
$webConfig = @"
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <staticContent>
      <remove fileExtension=".gz" />
      <mimeMap fileExtension=".gz" mimeType="application/gzip" />
      <remove fileExtension=".sh" />
      <mimeMap fileExtension=".sh" mimeType="text/plain" />
    </staticContent>
    <directoryBrowse enabled="false" />
  </system.webServer>
</configuration>
"@
$webConfig | Out-File -FilePath "$distDir\web.config" -Encoding utf8
Write-Host "web.config yazildi (MIME types: .gz, .sh)" -ForegroundColor Green

# IIS reset (MIME type degisikliklerinin aktif olmasi icin)
Write-Host "IIS yeniden baslatiliyor..." -ForegroundColor Cyan
iisreset /noforce | Out-Null
Write-Host "IIS yeniden basladi." -ForegroundColor Green

Write-Host ""
Write-Host "=== Kurulum Tamamlandi ===" -ForegroundColor Green
Write-Host ""
Write-Host "Siradaki adim - dev makinenizde paketi olusturun:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\dist\build-package.ps1 -Password <pi_sifresi>"
Write-Host ""
Write-Host "Paket olusunca bu adres aktif olacak:"
Write-Host "  $testUrl"
