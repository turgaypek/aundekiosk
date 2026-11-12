# AundeKiosk - Local Distribution Package Builder
# Builds aundekiosk-latest.tar.gz for IIS-based local installation.
#
# What it does:
#   1. git archive master  → repo source files
#   2. pscp from SOURCE_PI → Deno binary (/usr/local/bin/deno)
#   3. pscp from SOURCE_PI → ttyd binary (/usr/local/bin/ttyd)
#   4. tar + pscp          → Deno cache (/opt/aundekiosk/.deno/)
#   5. Creates aundekiosk-latest.tar.gz + version.txt in dist\
#   6. Copies to IIS folder (if on the same machine, i.e. $IIS_DIR exists)
#
# Prerequisites:
#   - PuTTY (plink.exe + pscp.exe) at C:\Program Files\PuTTY\
#   - Git for Windows (includes tar.exe)
#   - Network access to SOURCE_PI (a Pi with a working AundeKiosk install)
#   - Pi SSH host key accepted in PuTTY registry (run once interactively if not)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\dist\build-package.ps1 [-Password <pi_ssh_pw>]

param(
    [string]$Password = ""
)

$ErrorActionPreference = "Stop"

# --- Configuration (adjust if needed) ---
$SOURCE_PI = "192.168.14.160"                          # Pi to pull Deno cache + binaries from
$PI_USER   = "pi"
$REPO_DIR  = "C:\Claude\Project\aundekiosk"
$IIS_DIR   = "C:\inetpub\wwwroot\aundekiosk-dist"     # local IIS path (only used if present)
$plink     = "C:\Program Files\PuTTY\plink.exe"
$pscp      = "C:\Program Files\PuTTY\pscp.exe"
# -----------------------------------------

# Validate PuTTY
foreach ($tool in @($plink, $pscp)) {
    if (-not (Test-Path $tool)) {
        Write-Error "PuTTY bulunamadi: $tool`nPuTTY'i yukleyin: https://putty.org"
    }
}

# Get Pi SSH password
if (-not $Password) {
    $secpw = Read-Host "Pi SSH sifresi" -AsSecureString
    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
              [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secpw))
} else {
    $pw = $Password
}

$date        = Get-Date -Format "yyyy-MM-dd"
$commitHash  = & git -C $REPO_DIR rev-parse HEAD
if ($LASTEXITCODE -ne 0) { Write-Error "git rev-parse basarisiz" }
$commitShort = $commitHash.Substring(0, 8)
$version     = "$date-$commitShort"

Write-Host ""
Write-Host "=== AundeKiosk Paket Olusturucu ===" -ForegroundColor Cyan
Write-Host "Surum      : $version"
Write-Host "Kaynak Pi  : $SOURCE_PI ($PI_USER)"
Write-Host "Depo       : $REPO_DIR"
Write-Host ""

# Temp workspace
$tmpDir    = Join-Path $env:TEMP "aundekiosk-build-$commitShort"
$tmpPkgDir = Join-Path $tmpDir "pkg"
$toolsDir  = Join-Path $tmpPkgDir "tools"

if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
New-Item -ItemType Directory -Path $tmpPkgDir | Out-Null
New-Item -ItemType Directory -Path $toolsDir  | Out-Null

try {
    # Step 1: Repo dosyalari (git archive)
    Write-Host "[1/5] Repo dosyalari cekiluyor (git archive master)..." -ForegroundColor Cyan
    $archiveTmp = Join-Path $tmpDir "archive.tar"
    & git -C $REPO_DIR archive master --output=$archiveTmp
    if ($LASTEXITCODE -ne 0) { throw "git archive basarisiz" }
    & tar xf $archiveTmp -C $tmpPkgDir
    if ($LASTEXITCODE -ne 0) { throw "tar extract basarisiz" }
    Remove-Item $archiveTmp

    # VERSION dosyasi (paket icerisinde; git olmayan Pi'ler bu dosyayi kullanir)
    $version | Out-File -FilePath "$tmpPkgDir\VERSION" -Encoding ascii -NoNewline
    Write-Host "       VERSION yazildi: $version" -ForegroundColor Gray

    # Step 2: Deno binary
    Write-Host "[2/5] Deno binary aliniyor ($SOURCE_PI:/usr/local/bin/deno)..." -ForegroundColor Cyan
    & $pscp -pw $pw -batch "${PI_USER}@${SOURCE_PI}:/usr/local/bin/deno" "$toolsDir\deno"
    if ($LASTEXITCODE -eq 0) {
        $sz = [math]::Round((Get-Item "$toolsDir\deno").Length / 1MB, 1)
        Write-Host "       OK — $sz MB" -ForegroundColor Gray
    } else {
        Write-Warning "Deno binary alinamadi.`n  → Pi ile hic interactive baglanti kurmamissaniz once PuTTY ile baglananin host key kaydolsun."
    }

    # Step 3: ttyd binary
    Write-Host "[3/5] ttyd binary aliniyor ($SOURCE_PI:/usr/local/bin/ttyd)..." -ForegroundColor Cyan
    & $pscp -pw $pw -batch "${PI_USER}@${SOURCE_PI}:/usr/local/bin/ttyd" "$toolsDir\ttyd"
    if ($LASTEXITCODE -eq 0) {
        $sz = [math]::Round((Get-Item "$toolsDir\ttyd").Length / 1MB, 1)
        Write-Host "       OK — $sz MB" -ForegroundColor Gray
    } else {
        Write-Warning "ttyd binary alinamadi — devam ediliyor (terminal ozelligi calislamayabilir)."
    }

    # Step 4: Deno cache (Pi'de tar olustur, pscp ile indir, Windows'ta ac)
    Write-Host "[4/5] Deno cache aliniyor (Pi'de tar olusturuluyor)..." -ForegroundColor Cyan
    $piTarPath = "/tmp/aundekiosk-deno-cache-$commitShort.tar.gz"
    $tarOut = & $plink -ssh "${PI_USER}@${SOURCE_PI}" -pw $pw -batch `
        "tar czf $piTarPath -C /opt/aundekiosk .deno 2>/dev/null && echo TAR_OK || echo TAR_FAIL" 2>&1
    if ("$tarOut" -match "TAR_OK") {
        $cacheTmp = Join-Path $tmpDir "deno-cache.tar.gz"
        & $pscp -pw $pw -batch "${PI_USER}@${SOURCE_PI}:${piTarPath}" $cacheTmp
        if ($LASTEXITCODE -eq 0 -and (Test-Path $cacheTmp)) {
            $sz = [math]::Round((Get-Item $cacheTmp).Length / 1MB, 1)
            Write-Host "       $sz MB indirildi, aciliyor..." -ForegroundColor Gray
            & tar xzf $cacheTmp -C $tmpPkgDir
            if ($LASTEXITCODE -ne 0) { Write-Warning "Deno cache tar acma basarisiz." }
            Remove-Item $cacheTmp -ErrorAction SilentlyContinue
        } else {
            Write-Warning "Deno cache indirilemedi."
        }
        # Pi'deki gecici dosyayi temizle
        & $plink -ssh "${PI_USER}@${SOURCE_PI}" -pw $pw -batch "rm -f $piTarPath" | Out-Null
    } else {
        Write-Warning "Pi'de Deno cache tar olusturulamadi (cikti: $tarOut)."
    }

    # Step 5: Paket olustur + dist\ klasorune kaydet
    Write-Host "[5/5] Paket olusturuluyor..." -ForegroundColor Cyan
    $distDir = Join-Path $REPO_DIR "dist"
    if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

    $latestPkg    = Join-Path $distDir "aundekiosk-latest.tar.gz"
    $versionedPkg = Join-Path $distDir "aundekiosk-$date.tar.gz"

    & tar czf $latestPkg -C $tmpPkgDir .
    if ($LASTEXITCODE -ne 0) { throw "Paket tar olusturma basarisiz" }
    Copy-Item $latestPkg $versionedPkg -Force

    $version | Out-File -FilePath "$distDir\version.txt" -Encoding ascii -NoNewline

    # bootstrap-local.sh ve web.config da dist\'a kopyala
    $bsSource  = Join-Path $REPO_DIR "scripts\setup\bootstrap-local.sh"
    $wcSource  = Join-Path $REPO_DIR "scripts\dist\iis-web.config"
    if (Test-Path $bsSource) { Copy-Item $bsSource "$distDir\bootstrap-local.sh" -Force }
    if (Test-Path $wcSource) { Copy-Item $wcSource "$distDir\web.config"          -Force }

    $pkgSizeMB = [math]::Round((Get-Item $latestPkg).Length / 1MB, 1)
    Write-Host ""
    Write-Host "Paket olusturuldu: $latestPkg ($pkgSizeMB MB)" -ForegroundColor Green
    Write-Host "Surum            : $version" -ForegroundColor Green

    # IIS'e kopyala (ayni makinedeyse)
    if (Test-Path $IIS_DIR) {
        Write-Host ""
        Write-Host "IIS'e kopyalaniyor ($IIS_DIR)..." -ForegroundColor Cyan
        Copy-Item $latestPkg    "$IIS_DIR\aundekiosk-latest.tar.gz" -Force
        Copy-Item $versionedPkg "$IIS_DIR\aundekiosk-$date.tar.gz"  -Force
        $version | Out-File -FilePath "$IIS_DIR\version.txt" -Encoding ascii -NoNewline
        if (Test-Path $bsSource) { Copy-Item $bsSource "$IIS_DIR\bootstrap-local.sh" -Force }
        if (Test-Path $wcSource) { Copy-Item $wcSource "$IIS_DIR\web.config"          -Force }
        Write-Host "IIS'e kopyalandi." -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "NOT: '$IIS_DIR' bu makinede bulunamadi." -ForegroundColor Yellow
        Write-Host "     Asagidaki klasoru IIS sunucusuna elle kopyalayin:" -ForegroundColor Yellow
        Write-Host "     $distDir" -ForegroundColor Yellow
        Write-Host "     Hedef: <IIS-sunucu>:\inetpub\wwwroot\aundekiosk-dist\" -ForegroundColor Yellow
    }

} finally {
    if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "=== Tamamlandi ===" -ForegroundColor Green
Write-Host ""
Write-Host "Pi kurulum komutu:"
Write-Host "  curl http://192.168.6.80/aundekiosk-dist/bootstrap-local.sh | sudo bash -s -- --install"
Write-Host ""
Write-Host "Pi guncelleme komutu (mevcut kurulumlar icin):"
Write-Host "  sudo aundekiosk-update"
