# Stops the public Relay (watchdog, server and tunnel) and disables the "Relay" task so its 5-minute
# re-check doesn't start it again. Start again with: Enable-ScheduledTask Relay; Start-ScheduledTask Relay
# (or rerun scripts\install-autostart.ps1).
param([int]$Port = 8100, [switch]$KeepTask)

$task = Get-ScheduledTask -TaskName "Relay" -ErrorAction SilentlyContinue
if ($task -and -not $KeepTask) {
    Disable-ScheduledTask -TaskName "Relay" | Out-Null
    Stop-ScheduledTask -TaskName "Relay" -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "powershell.exe" -and $_.CommandLine -like "*serve-public.ps1*" -and $_.ProcessId -ne $PID) -or
    ($_.Name -eq "cloudflared.exe" -and $_.CommandLine -like "*127.0.0.1:$Port*") -or
    ($_.Name -eq "python.exe" -and $_.CommandLine -like "*uvicorn app.main:app*--port $Port*")
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "Relay stopped$(if ($task -and -not $KeepTask) { '; task disabled' })."
