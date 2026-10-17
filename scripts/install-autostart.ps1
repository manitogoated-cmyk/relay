# Registers the Windows task "Relay" that runs scripts\serve-public.ps1 at boot, before anyone signs in,
# as the current user (S4U: no stored password, no network-share access, which Relay doesn't need).
# A 5-minute re-check starts it again if the watchdog itself ever ends; a running copy is left alone.
# Needs an elevated (administrator) PowerShell. Also starts it now. Stop with scripts\stop-public.ps1.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$name = "Relay"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this from an administrator PowerShell (a boot-time task needs it)." }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $root -Argument (
    "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\scripts\serve-public.ps1`"")
$atBoot = New-ScheduledTaskTrigger -AtStartup
$recheck = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

# Hand over from a copy started by hand, so only the task's copy runs.
& "$PSScriptRoot\stop-public.ps1" -KeepTask | Out-Null

Register-ScheduledTask -TaskName $name -Action $action -Trigger @($atBoot, $recheck) -Principal $principal `
    -Settings $settings -Description "Relay webhook platform: production server + Cloudflare quick tunnel ($root)" -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "Task '$name' registered and started. Public URL (after ~15 s): $root\data\prod\public-url.txt"
