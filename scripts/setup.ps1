# One-time setup: Python venv + backend deps, frontend deps + build.
$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path "$root\.venv")) { python -m venv "$root\.venv" }
& "$root\.venv\Scripts\python.exe" -m pip install -q -r "$root\backend\requirements-dev.txt"
Push-Location "$root\frontend"; npm install --no-audit --no-fund; npx vite build; Pop-Location
Write-Host "Done. Start with: powershell -File scripts\dev.ps1, then open http://127.0.0.1:8100"
