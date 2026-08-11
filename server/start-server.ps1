# -----------------------------------------------------------------------------
# server\start-server.ps1 — Launches the Me-Tracker server. What the boot
# task actually runs (see register-scheduled-task.ps1).
#
# Also runnable by hand for a manual restart: right-click > Run with
# PowerShell, or `powershell -File server\start-server.ps1` from a terminal.
# Blocks for as long as the server runs — that's deliberate, see the bottom.
# -----------------------------------------------------------------------------

$ErrorActionPreference = "Stop"
$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Log to files — this runs with no console attached once Task Scheduler
# starts it at boot, so stdout/stderr would otherwise vanish.
$logDir = Join-Path $serverDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "server.log"
$errLog = Join-Path $logDir "server.err.log"

# -----------------------------------------------------------------------------
# boot.log — a plain-English trail of every attempt to start the server,
# success or failure. This exists because of a real incident: the boot task
# silently never fired after a reboot, and there was no record anywhere that
# anything had even been attempted. server.log / server.err.log only get
# written once python actually starts, so they were empty and told nobody
# anything. This file is written to FIRST, before anything that could throw,
# so even the earliest possible failure leaves a line here.
# -----------------------------------------------------------------------------
$bootLog = Join-Path $logDir "boot.log"
function Write-BootLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $bootLog -Value $line
}

Write-BootLog "start-server.ps1 invoked (user: $env:USERNAME, PID: $PID)"

try {
    # -----------------------------------------------------------------------
    # WHY THIS ENV VAR IS SET EXPLICITLY, NOT LEFT TO THE DEFAULT:
    #
    # The boot task runs this as NT AUTHORITY\SYSTEM (see register-scheduled-
    # task.ps1 — SYSTEM needs no stored password, which is what makes "no
    # login required" possible at all on Windows). SYSTEM's own home
    # directory is C:\WINDOWS\system32\config\systemprofile, NOT
    # C:\Users\Ryan. Left alone, app.py's Path.home()/'.metracker' would
    # resolve there instead — a folder that doesn't exist — and
    # secrets_readable() would silently report false even though the real
    # secrets are sitting exactly where they should be.
    #
    # METRACKER_SECRETS_DIR exists in app.py precisely for cases like this
    # (ARCHITECTURE.md §3). Setting it here, in the launcher, is the
    # sanctioned place for an environment-specific override — the
    # alternative would be hardcoding the username inside app.py itself,
    # which §3 explicitly says not to do.
    # -------------------------------------------------------------------
    $env:METRACKER_SECRETS_DIR = "C:\Users\Ryan\.metracker"

    $pythonExe = Join-Path $serverDir ".venv\Scripts\python.exe"
    $appPy = Join-Path $serverDir "app.py"

    # -------------------------------------------------------------------
    # Retry, don't just throw once. At boot, this script can start racing
    # the rest of the system (disk, profile, antivirus scanning the venv)
    # before everything it needs is actually in place. A single immediate
    # Test-Path check that throws on the first miss turns a few seconds of
    # timing bad luck into a fully failed startup with no second chance.
    # Up to 12 tries, 5 seconds apart — one minute of patience — matching
    # the scheduled task's own RestartCount/RestartInterval philosophy.
    # -------------------------------------------------------------------
    $maxAttempts = 12
    $attempt = 0
    while (-not (Test-Path $pythonExe) -and $attempt -lt $maxAttempts) {
        $attempt++
        Write-BootLog "venv python not found yet at $pythonExe (attempt $attempt/$maxAttempts), waiting 5s"
        Start-Sleep -Seconds 5
    }

    if (-not (Test-Path $pythonExe)) {
        Write-BootLog "FAILED: venv python still not found at $pythonExe after $maxAttempts attempts."
        throw "Virtual environment not found at $pythonExe. Run: python -m venv server\.venv ; server\.venv\Scripts\python.exe -m pip install -r server\requirements.txt"
    }
} catch {
    Write-BootLog "FAILED during startup checks: $($_.Exception.Message)"
    throw
}

# -----------------------------------------------------------------------------
# Start-Process, not `& $pythonExe ...` with a PowerShell stream redirect.
#
# uvicorn logs its normal "Started server process" / "Application startup
# complete" lines to STDERR, which is ordinary for Python's logging module —
# not a failure. With $ErrorActionPreference = "Stop" (needed above, for
# Test-Path/throw to actually stop the script on a real problem),
# PowerShell's native-command stream redirect (`*>>`, `2>&1`, etc.) converts
# ANY stderr line from an external program into a terminating error. The
# server would start, immediately log its first INFO line, and PowerShell
# would kill the whole script right there — which is exactly what happened
# during testing before this was fixed. Start-Process redirects at the OS
# level and is not subject to that behaviour.
#
# -Wait keeps this script (and therefore the scheduled task) "running" for
# as long as the server is — the correct shape for an AtStartup task that IS
# the service, rather than a launcher that fires and forgets.
# -----------------------------------------------------------------------------
Write-BootLog "Launching $pythonExe $appPy"
try {
    Start-Process -FilePath $pythonExe -ArgumentList $appPy -WorkingDirectory $serverDir `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
        -NoNewWindow -Wait
    # Start-Process -Wait only returns once the server process has exited.
    # For this always-on server that means it crashed, was killed, or the
    # machine is shutting down — never a normal, expected outcome.
    Write-BootLog "Server process exited (this is only expected during shutdown)."
} catch {
    Write-BootLog "FAILED to launch server process: $($_.Exception.Message)"
    throw
}
