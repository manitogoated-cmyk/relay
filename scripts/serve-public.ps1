# Serves Relay to the internet from this PC through a Cloudflare quick tunnel (HTTPS, no open ports).
# The public address (https://<random>.trycloudflare.com) changes every time a new tunnel starts;
# webhook URLs follow it, so update senders after a restart, or use a named tunnel (docs/DEPLOYMENT.md).
# Production data lives in data\prod, separate from development data.
#
# Runs as a watchdog until stopped: it restarts the server if it exits or stops answering /api/health,
# and opens a new tunnel if cloudflared exits (or the network isn't up yet at boot).
# scripts\install-autostart.ps1 registers it to start at boot; scripts\stop-public.ps1 stops it.
param([int]$Port = 8100)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$prod = Join-Path $root "data\prod"
New-Item -ItemType Directory -Force $prod | Out-Null
$launcherLog = Join-Path $prod "launcher.log"

function Say([string]$text) {
    $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $text
    Write-Host $line
    Add-Content -Path $launcherLog -Value $line -Encoding utf8
}

$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) { $cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe" }
if (-not (Test-Path $cf)) { throw "cloudflared not found. Install it: winget install Cloudflare.cloudflared" }

if (-not (Test-Path "$root\frontend\dist\index.html")) { Push-Location "$root\frontend"; npx vite build; Pop-Location }

if ((Test-Path $launcherLog) -and (Get-Item $launcherLog).Length -gt 5MB) { Move-Item $launcherLog "$launcherLog.prev" -Force }

# Stop a previous run of this script.
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "cloudflared.exe" -and $_.CommandLine -like "*127.0.0.1:$Port*") -or
    ($_.Name -eq "python.exe" -and $_.CommandLine -like "*uvicorn app.main:app*--port $Port*")
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$env:RELAY_ENVIRONMENT = "production"
$env:RELAY_DATABASE_URL = "sqlite:///" + ((Join-Path $prod "relay.db") -replace "\\", "/")
$env:RELAY_STORAGE_DIR = Join-Path $prod "uploads"

function Start-Tunnel {
    $log = Join-Path $prod "tunnel.log"
    Remove-Item $log -ErrorAction SilentlyContinue
    $proc = Start-Process -FilePath $cf -WindowStyle Hidden -PassThru -ArgumentList @(
        "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:$Port", "--logfile", $log)
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        if ($proc.HasExited) { break }
        if (Test-Path $log) {
            $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
            if ($m) { return @{ Process = $proc; Url = $m.Matches[0].Value } }
        }
    }
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    return $null
}

function Start-Server {
    $err = Join-Path $prod "server.log"
    if (Test-Path $err) { Move-Item $err (Join-Path $prod "server.prev.log") -Force }
    # cloudflared connects from 127.0.0.1 and sends X-Forwarded-For/-Proto; trusting only that address
    # makes Relay see each visitor's real IP (rate limits, setup restrictions) and the https scheme.
    # Start-Process (not &): Windows PowerShell 5.1 turns a native program's stderr logging into errors.
    $p = Start-Process -FilePath "$root\.venv\Scripts\python.exe" -WorkingDirectory "$root\backend" `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $prod "server.out.log") -RedirectStandardError $err `
        -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$Port",
                        "--proxy-headers", "--forwarded-allow-ips", "127.0.0.1", "--workers", "1")
    $null = $p.Handle  # holding the handle keeps ExitCode readable after it exits
    $p
}

# The venv's python.exe is a launcher that runs the real interpreter as a child: end the whole tree.
function Stop-Tree([int]$Id) { Start-Process taskkill.exe -ArgumentList "/T", "/F", "/PID", $Id -WindowStyle Hidden -Wait }

function Test-Health {
    try { (Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 5).ok -eq $true } catch { $false }
}

$tunnel = $null
$server = $null
$tunnelFailures = 0
$serverFailures = 0
Say "watchdog started (pid $PID)"
try {
    while ($true) {
        if (-not $tunnel -or $tunnel.Process.HasExited) {
            if ($server -and -not $server.HasExited) { Stop-Tree $server.Id }
            $server = $null
            $tunnel = Start-Tunnel
            if (-not $tunnel) {
                $wait = [Math]::Min(300, 10 * [Math]::Pow(2, $tunnelFailures++))
                Say "tunnel didn't report a URL (network not ready?); retrying in $wait s"
                Start-Sleep -Seconds $wait
                continue
            }
            $tunnelFailures = 0
            Set-Content -Path (Join-Path $prod "public-url.txt") -Value $tunnel.Url -Encoding utf8
            $env:RELAY_PUBLIC_BASE_URL = $tunnel.Url
            Say "Relay public URL: $($tunnel.Url)"
        }

        if (-not $server -or $server.HasExited) {
            if ($server) {
                $wait = [Math]::Min(300, 5 * [Math]::Pow(2, $serverFailures++))
                Say "server exited (code $($server.ExitCode)); restarting in $wait s (see server.prev.log)"
                Start-Sleep -Seconds $wait
            }
            $server = Start-Server
            $started = Get-Date
            $lastOk = Get-Date
        }

        Start-Sleep -Seconds 5
        if (Test-Health) {
            $lastOk = Get-Date
            if (((Get-Date) - $started).TotalMinutes -gt 10) { $serverFailures = 0 }
        } elseif (-not $server.HasExited -and ((Get-Date) - $lastOk).TotalSeconds -gt 120) {
            Say "server hasn't answered /api/health for 2 minutes; restarting it"
            Stop-Tree $server.Id
            $server.WaitForExit()
        }
    }
} finally {
    if ($server) { Stop-Tree $server.Id }
    if ($tunnel) { Stop-Process -Id $tunnel.Process.Id -Force -ErrorAction SilentlyContinue }
    Say "watchdog stopped"
}
