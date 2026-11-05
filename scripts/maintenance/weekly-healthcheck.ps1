# AundeKiosk - Weekly Pi Health Check
# Calistir: powershell -ExecutionPolicy Bypass -File weekly-healthcheck.ps1 [-Password <pw>]

param(
    [string]$Password = ""
)

$plink = "C:\Program Files\PuTTY\plink.exe"
if (-not $Password) {
    $secpw = Read-Host "Pi SSH sifresi" -AsSecureString
    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
              [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secpw))
} else {
    $pw = $Password
}
$date  = Get-Date -Format "yyyy-MM-dd HH:mm"

$pis = @(
    @{name="AUNDE-BIM-BURO";  ip="192.168.14.160"; hk=$null},
    @{name="ISRI-KAYNAKHANE"; ip="192.168.14.161"; hk=$null},
    @{name="ISRI-URETIM";     ip="192.168.6.188";  hk="SHA256:LQf5z0HwRw3JZ39i6HHZOtKH2o3lFbmI8GiIAAFPUhc"},
    @{name="AUNDE-KUMAS";     ip="192.168.14.158"; hk=$null},
    @{name="ISRI-USTYAPI";    ip="192.168.14.128"; hk=$null},
    @{name="ISRI-YEMEKHANE";  ip="192.168.14.61";  hk=$null}
)

$sep = "=" * 60
$report = @($sep, "AundeKiosk Haftalik Saglik Raporu - $date", $sep)
$allOk  = $true

foreach ($pi in $pis) {
    $args = @("-ssh", "pi@$($pi.ip)", "-pw", $pw, "-batch")
    if ($pi.hk) { $args += @("-hostkey", $pi.hk) }
    $args += "uptime && df -h / | tail -1 && free -h | grep Mem && vcgencmd measure_temp 2>/dev/null; systemctl is-active aundekiosk-dashboard aundekiosk-runner aundekiosk-monitor snmpd wayvnc 2>/dev/null | paste - - - - -; git -C /opt/aundekiosk -c safe.directory=/opt/aundekiosk log --oneline -1 2>/dev/null"

    $out = & $plink @args 2>&1
    $lines = $out | Where-Object { $_ -and $_ -notmatch "^$" }

    $report += ""
    $report += "[$($pi.name)] $($pi.ip)"

    if (-not $lines -or ($lines -join "") -match "FATAL|Connection refused|Network error") {
        $report += "  DURUM : ERISILEMEDID!"
        $allOk = $false
        continue
    }

    $svcsLine = $lines | Where-Object { $_ -match "^(active|inactive|failed|activating)" }
    $inactive = 0
    if ($svcsLine) {
        $inactive = ($svcsLine -split '\s+' | Where-Object { $_ -eq "inactive" -or $_ -eq "failed" }).Count
    }

    $status = if ($inactive -gt 0) { "UYARI - $inactive servis inactive/failed" } else { "OK" }
    if ($inactive -gt 0) { $allOk = $false }

    foreach ($l in $lines) { $report += "  $l" }
    $report += "  DURUM : $status"
}

$report += ""
$report += $sep
$report += if ($allOk) { "GENEL DURUM: TUM CIHAZLAR NORMAL" } else { "GENEL DURUM: DIKKAT GEREKTIREN CIHAZ VAR!" }
$report += $sep

$report | ForEach-Object { Write-Host $_ }

$logDir = Join-Path $PSScriptRoot "..\..\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir "healthcheck-$(Get-Date -Format 'yyyy-MM-dd').txt"
$report | Out-File -FilePath $logFile -Encoding utf8
Write-Host ""
Write-Host "Log: $logFile"
