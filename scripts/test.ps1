# Every check: ruff, pytest (unit + API + live SSE), tsc, eslint, vitest, production build.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$py = "$root\.venv\Scripts\python.exe"
Push-Location "$root\backend"
& $py -m ruff check . ; if ($LASTEXITCODE) { exit 1 }
& $py -m pytest ; if ($LASTEXITCODE) { exit 1 }
Pop-Location
Push-Location "$root\frontend"
npx tsc -b --noEmit ; if ($LASTEXITCODE) { exit 1 }
npx eslint src ; if ($LASTEXITCODE) { exit 1 }
npx vitest run ; if ($LASTEXITCODE) { exit 1 }
npx vite build ; if ($LASTEXITCODE) { exit 1 }
Pop-Location
Write-Host "All checks passed."
