# Serves Relay to the internet from this PC through a Cloudflare quick tunnel (HTTPS, no open ports).
# The public address (https://<random>.trycloudflare.com) changes every time this script starts;
# webhook URLs follow it, so update senders after a restart, or use a named tunnel (docs/DEPLOYMENT.md).
# Production data lives in data\prod, separate from development data.
param([int]$Port = 8100)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$prod = Join-Path $root "data\prod"
New-Item -ItemType Directory -Force $prod | Out-Null

$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cf)) { throw "cloudflared not found. Install it: winget install Cloudflare.cloudflared" }

if (-not (Test-Path "$root\frontend\dist\index.html")) { Push-Location "$root\frontend"; npx vite build; Pop-Location }

# Stop a previous run of this script.
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "cloudflared.exe" -and $_.CommandLine -like "*127.0.0.1:$Port*") -or
    ($_.Name -eq "python.exe" -and $_.CommandLine -like "*uvicorn app.main:app*--port $Port*")
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$log = Join-Path $prod "tunnel.log"
Remove-Item $log -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $cf -WindowStyle Hidden -PassThru -ArgumentList @(
    "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port", "--logfile", $log)

$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $log) {
        $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value }
    }
}
if (-not $url) { Stop-Process -Id $tunnel.Id -Force; throw "Tunnel didn't report a URL; see $log" }
Set-Content -Path (Join-Path $prod "public-url.txt") -Value $url -Encoding utf8

$env:RELAY_ENVIRONMENT = "production"
$env:RELAY_PUBLIC_BASE_URL = $url
$env:RELAY_DATABASE_URL = "sqlite:///" + ((Join-Path $prod "relay.db") -replace "\\", "/")
$env:RELAY_STORAGE_DIR = Join-Path $prod "uploads"

Write-Host "Relay public URL: $url"
try {
    # cloudflared connects from 127.0.0.1 and sends X-Forwarded-For/-Proto; trusting only that address
    # makes Relay see each visitor's real IP (rate limits, setup restrictions) and the https scheme.
    # Start-Process (not &): Windows PowerShell 5.1 turns a native program's stderr logging into errors.
    $server = Start-Process -FilePath "$root\.venv\Scripts\python.exe" -WorkingDirectory "$root\backend" `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $prod "server.out.log") -RedirectStandardError (Join-Path $prod "server.log") `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$Port",
                        "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1", "--workers", "1")
    Wait-Process -Id $server.Id
} finally {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
}
