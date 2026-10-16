# Runs Relay locally: backend on http://127.0.0.1:8100 (serves the built UI too).
# For UI hot reload, also run `npm run dev` in frontend/ and open http://127.0.0.1:5174.
$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path "$root\frontend\dist\index.html")) { Push-Location "$root\frontend"; npx vite build; Pop-Location }
Push-Location "$root\backend"
& "$root\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8100 --reload --reload-dir app
Pop-Location
