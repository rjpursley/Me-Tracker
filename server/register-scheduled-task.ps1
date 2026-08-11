# -----------------------------------------------------------------------------
# server\register-scheduled-task.ps1 — Make the server start at boot, with
# nobody logged in. Run this ONCE.
#
# MUST BE RUN AS ADMINISTRATOR. Right-click PowerShell in the Start menu >
# "Run as administrator", then run this script. It will fail with
# "Access is denied" otherwise — that's Windows refusing to let a non-admin
# session create a task that runs before any login, which is exactly what
# this needs to do.
#
# Safe to re-run: it replaces the existing task definition rather than
# erroring if one is already there.
# -----------------------------------------------------------------------------

$ErrorActionPreference = "Stop"
$taskName = "Me-Tracker Server"
$scriptPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "start-server.ps1"

if (-not (Test-Path $scriptPath)) {
    throw "Could not find start-server.ps1 next to this script at $scriptPath"
}

# -----------------------------------------------------------------------------
# WHY SYSTEM, NOT RYAN'S OWN ACCOUNT:
#
# "Start at boot, no login required" on Windows means the task has to run
# before any interactive session exists. That needs either the built-in
# SYSTEM account (no password, always available) or Ryan's own account with
# "run whether logged on or not" — which requires Windows to store his
# account password so it can log him in non-interactively. This script never
# asks for or stores a password; SYSTEM is the only credential-free way to
# satisfy "no login required", which is why it's used here.
# -----------------------------------------------------------------------------
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

# -----------------------------------------------------------------------------
# 30-second delay on the boot trigger.
#
# A bare AtStartup trigger fires the instant Task Scheduler's own engine
# comes up, which is very early — before this machine has necessarily
# finished settling (disk, profile, antivirus scanning the venv the first
# time it's touched after boot). This machine also has Fast Startup
# (hiberboot) enabled, which is a documented source of unreliable
# AtStartup-trigger firing on Windows: a plain "Shut down" is a hybrid
# shutdown that resumes the kernel session rather than performing a full
# boot, and boot triggers can be inconsistent across that resume. A real
# incident already happened: the task's LastRunTime showed it had never
# fired at all after a reboot. This delay does not fix Fast Startup itself
# (that's a separate, optional hardening step — see ARCHITECTURE.md) but it
# gives the Task Scheduler engine and the rest of the system breathing room
# before evaluating the trigger, which is the standard mitigation. Combined
# with StartWhenAvailable below and the retry loop now in start-server.ps1,
# a missed or early trigger has two more chances to still succeed.
# -----------------------------------------------------------------------------
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT30S"

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Restart automatically if the server process dies (crash, killed, etc.),
# up to 3 times, a minute apart. No time limit — this is meant to run
# indefinitely, not for a bounded job.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# -ErrorAction Stop is explicit here, not just relied on from the preference
# variable above: Register-ScheduledTask is CIM-backed, and a permission
# failure from the underlying CIM call surfaced as a non-terminating error
# during testing — $ErrorActionPreference alone did NOT stop the script, so
# it fell through and printed a false "success" message after an access-
# denied error above it. Forcing it here is what makes a real failure
# actually stop the script instead of just being noisy about it.
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force `
        -Description "Runs Me-Tracker's server (server/app.py) at boot, bound to 127.0.0.1:8123. See ARCHITECTURE.md." `
        -ErrorAction Stop `
        | Out-Null
} catch {
    Write-Host ""
    Write-Host "FAILED to register the task: $($_.Exception.Message)"
    Write-Host "This almost always means this PowerShell window is not running as Administrator."
    Write-Host "Right-click PowerShell in the Start menu > Run as administrator, then run this script again."
    throw
}

Write-Host "Registered scheduled task '$taskName'."
Write-Host ""
Write-Host "To test it right now without rebooting:"
Write-Host "  Start-ScheduledTask -TaskName `"$taskName`""
Write-Host ""
Write-Host "To check on it:"
Write-Host "  Get-ScheduledTask -TaskName `"$taskName`" | Get-ScheduledTaskInfo"
Write-Host ""
Write-Host "To remove it entirely:"
Write-Host "  Unregister-ScheduledTask -TaskName `"$taskName`" -Confirm:`$false"
Write-Host ""
Write-Host "Every startup attempt (success or failure) is now logged to:"
Write-Host "  server\logs\boot.log"
