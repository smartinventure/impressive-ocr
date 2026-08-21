# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Start and stop the Impressive OCR development stack (API + web UI) from a menu.
#
# Deliberately ASCII-only and free of PowerShell 7 syntax: this has to run under the
# Windows PowerShell 5.1 that ships with Windows, which reads a UTF-8 file with no BOM as
# ANSI and has no '&&', no ternary and no null-coalescing operator.
#
# Usage:  .\dev\dev.ps1              interactive menu
#         .\dev\dev.ps1 -Action start
#         .\dev\dev.ps1 -Action stop
#         .\dev\dev.ps1 -Action doctor    check prerequisites, offer to install them

[CmdletBinding()]
param(
    [ValidateSet('menu', 'start', 'stop', 'restart', 'status', 'env', 'doctor')]
    [string] $Action = 'menu'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- layout ----

$DevDir    = $PSScriptRoot
$RepoRoot  = Split-Path -Parent $DevDir
$RunDir    = Join-Path $DevDir '.run'
$LogFile   = Join-Path $RunDir 'dev.log'
$PidFile   = Join-Path $RunDir 'dev.pid'
$EnvFile   = Join-Path $DevDir 'dev.env'

# Must match DEV_PORT in apps/web/vite.config.ts and DEFAULT_PORT in
# packages/shared/src/settings.ts respectively.
$WebPort = 5273
$ApiPort = 8084

# What this machine needs and how to get it: Get-Prerequisites, Test-Prerequisites,
# Install-Prerequisites, Resolve-Pnpm. Kept separate because the launcher is long enough.
. (Join-Path $DevDir 'preflight.ps1')

# ------------------------------------------------------------ presentation ----

function Write-Head([string] $Text) { Write-Host $Text -ForegroundColor Cyan }
function Write-Good([string] $Text) { Write-Host $Text -ForegroundColor Green }
function Write-Warn([string] $Text) { Write-Host $Text -ForegroundColor Yellow }
function Write-Bad ([string] $Text) { Write-Host $Text -ForegroundColor Red }
function Write-Dim ([string] $Text) { Write-Host $Text -ForegroundColor DarkGray }

function Write-Rule { Write-Dim ('-' * 74) }

# ------------------------------------------------------------ environment ----

function Import-DevEnv {
    <#
        Load dev/dev.env if the developer made one. Lines are KEY=VALUE; blank lines and
        those starting with '#' are ignored. Values are used verbatim, so no quoting games.
    #>
    if (-not (Test-Path $EnvFile)) { return @{} }

    $loaded = @{}
    foreach ($line in (Get-Content $EnvFile)) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $split = $trimmed.IndexOf('=')
        if ($split -lt 1) { continue }
        $key   = $trimmed.Substring(0, $split).Trim()
        $value = $trimmed.Substring($split + 1).Trim()
        Set-Item -Path "env:$key" -Value $value
        $loaded[$key] = $value
    }
    return $loaded
}

function Get-DefaultDataDir {
    <#
        Sibling of the repository, so the data dir lands on whatever drive the checkout is
        on. The application's own default is %LOCALAPPDATA%, which is on C: -- and the OCR
        model weights that go under it run to several gigabytes.
    #>
    return (Join-Path (Split-Path -Parent $RepoRoot) '.impressive-ocr-data')
}

function Resolve-DevEnvironment {
    $fromFile = Import-DevEnv

    if (-not $env:IMPRESSIVE_OCR_DATA_DIR) {
        $env:IMPRESSIVE_OCR_DATA_DIR = Get-DefaultDataDir
    }
    if (-not $env:IMPRESSIVE_OCR_PORT) {
        $env:IMPRESSIVE_OCR_PORT = "$ApiPort"
    }
    $script:ApiPort = [int] $env:IMPRESSIVE_OCR_PORT
    return $fromFile
}

# ------------------------------------------------------------- processes ----

function Get-ListenerPids([int] $Port) {
    <#
        Process IDs listening on a TCP port.

        Get-NetTCPConnection is preferred because it is language independent; the netstat
        fallback deliberately does not match on the word LISTENING, which is localised (a
        German Windows prints ABHOEREN) and would silently find nothing.
    #>
    $ids = New-Object System.Collections.Generic.List[int]

    try {
        $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
        foreach ($connection in $connections) { $ids.Add([int] $connection.OwningProcess) }
    }
    catch {
        foreach ($line in (netstat -ano)) {
            $columns = ($line.Trim() -split '\s+')
            if ($columns.Length -lt 5) { continue }
            if ($columns[0] -ne 'TCP') { continue }
            if (-not $columns[1].EndsWith(":$Port")) { continue }
            # The listening socket is the one with a wildcard remote address. Matching the
            # local address alone also catches TIME_WAIT rows on the same port, which report
            # PID 0 and would otherwise be handed to taskkill.
            if ($columns[2] -ne '0.0.0.0:0' -and $columns[2] -ne '[::]:0') { continue }
            $candidate = 0
            if ([int]::TryParse($columns[$columns.Length - 1], [ref] $candidate)) {
                if ($candidate -gt 0) { $ids.Add($candidate) }
            }
        }
    }

    return ($ids | Sort-Object -Unique)
}

function Test-PortBusy([int] $Port) {
    $found = Get-ListenerPids -Port $Port
    return (@($found).Count -gt 0)
}

function Stop-Tree([int] $ProcessId) {
    # Already gone is the normal case, not an error: killing pnpm's tree takes the vite and
    # tsx children with it, so by the time the port sweep runs the pid it found is dead.
    if ($null -eq (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        return
    }

    # Not `2>&1`. Windows PowerShell wraps a native command's stderr in an ErrorRecord and,
    # under `$ErrorActionPreference = 'Stop'`, prints a NativeCommandError even when the exit
    # code is fine -- which is what surfaced as a wall of red after a perfectly good stop.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        taskkill /PID $ProcessId /T /F > $null 2> $null
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

# ---------------------------------------------------------------- actions ----

function Start-Stack {
    if ((Test-PortBusy $ApiPort) -or (Test-PortBusy $WebPort)) {
        Write-Warn 'Already running. Use Stop first, or Restart.'
        return
    }

    Write-Head 'Checking prerequisites'
    if (-not (Test-Prerequisites)) {
        Write-Bad 'Cannot start until the items above are resolved.'
        return
    }

    $pnpm = Resolve-Pnpm
    New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
    New-Item -ItemType Directory -Force -Path $env:IMPRESSIVE_OCR_DATA_DIR | Out-Null

    Write-Head 'Starting'
    Write-Dim  "  data dir  $env:IMPRESSIVE_OCR_DATA_DIR"
    Write-Dim  "  logs      $LogFile"

    # cmd does the redirection rather than -RedirectStandardOutput/-RedirectStandardError.
    # Those parameters leave the file handles open in *this* process, so the script does not
    # return until the whole stack exits - which defeats the point of a launcher.
    $command = 'cd /d "{0}" && "{1}" dev > "{2}" 2>&1' -f $RepoRoot, $pnpm, $LogFile
    $process = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', $command `
        -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $process.Id -Encoding ascii

    if (Wait-ForApi -TimeoutSeconds 90) {
        Write-Good ''
        Write-Good "  Web UI  http://localhost:$WebPort"
        Write-Good "  API     http://127.0.0.1:$ApiPort"
        Write-Good ''
        Show-RuntimeHint
    }
    else {
        # ${} around the name: a bare "$LogFile:" parses as a drive-qualified reference.
        Write-Bad "The API did not answer within 90s. Last lines of ${LogFile}:"
        if (Test-Path $LogFile) { Get-Content $LogFile -Tail 15 | ForEach-Object { Write-Dim "  $_" } }
    }
}

function Wait-ForApi([int] $TimeoutSeconds) {
    Write-Host -NoNewline '  waiting for the API '
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/system/status" `
                -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) { Write-Good ' ready'; return $true }
        }
        catch {
            # Not up yet; the loop is the retry.
        }
        Write-Host -NoNewline '.'
        Start-Sleep -Milliseconds 700
    }
    Write-Bad ' timed out'
    return $false
}

function Show-RuntimeHint {
    try {
        $status = Invoke-WebRequest -Uri "http://127.0.0.1:$ApiPort/api/system/runtime" `
            -UseBasicParsing -TimeoutSec 5
        $state = ($status.Content | ConvertFrom-Json).state
        if ($state -eq 'not-installed') {
            Write-Warn '  The OCR runtime is not installed yet, so jobs cannot run.'
            Write-Dim  '  Install it from the web UI (System / Settings). It downloads'
            Write-Dim  "  several GB into $env:IMPRESSIVE_OCR_DATA_DIR\runtime."
            Write-Host ''
        }
        else { Write-Dim "  OCR runtime: $state" }
    }
    catch {
        # The hint is a nicety; never let it fail a successful start.
    }
}

function Stop-Stack {
    $stopped = $false

    if (Test-Path $PidFile) {
        $recorded = 0
        if ([int]::TryParse((Get-Content $PidFile -Raw).Trim(), [ref] $recorded)) {
            $process = Get-Process -Id $recorded -ErrorAction SilentlyContinue
            if ($process) {
                Write-Dim "  stopping pnpm (pid $recorded) and its children"
                Stop-Tree $recorded
                $stopped = $true
            }
        }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }

    # Belt and braces: a crashed launcher, or a stack started by hand, leaves the ports held
    # by processes no pid file knows about.
    foreach ($port in @($ApiPort, $WebPort)) {
        foreach ($owner in (Get-ListenerPids -Port $port)) {
            Write-Dim "  freeing port $port (pid $owner)"
            Stop-Tree $owner
            $stopped = $true
        }
    }

    Start-Sleep -Milliseconds 400
    if ((Test-PortBusy $ApiPort) -or (Test-PortBusy $WebPort)) {
        Write-Bad 'Some processes survived; check Task Manager for node.exe.'
    }
    elseif ($stopped) { Write-Good 'Stopped.' }
    else { Write-Dim 'Nothing was running.' }
}

function Show-Status {
    Write-Head 'Status'
    foreach ($entry in @(
            @{ Name = 'API   '; Port = $ApiPort; Url = "http://127.0.0.1:$ApiPort" },
            @{ Name = 'Web UI'; Port = $WebPort; Url = "http://localhost:$WebPort" })) {
        $owners = Get-ListenerPids -Port $entry.Port
        if (@($owners).Count -gt 0) {
            Write-Good ("  {0}  running  {1}  (pid {2})" -f $entry.Name, $entry.Url, ($owners -join ', '))
        }
        else {
            Write-Dim ("  {0}  stopped  {1}" -f $entry.Name, $entry.Url)
        }
    }

    Write-Host ''
    Write-Head 'Prerequisites'
    Test-Prerequisites | Out-Null

    if (Test-Path $LogFile) {
        Write-Host ''
        Write-Head "Last log lines ($LogFile)"
        Get-Content $LogFile -Tail 8 | ForEach-Object { Write-Dim "  $_" }
    }
}

function Show-Environment {
    $dataDir = $env:IMPRESSIVE_OCR_DATA_DIR

    Write-Head 'Environment'
    Write-Rule
    Write-Host 'Only three variables are meant for you. Everything else with an'
    Write-Host 'IMPRESSIVE_OCR_ prefix is injected by the server when it spawns the Python'
    Write-Host 'sidecar - setting those by hand will confuse it.'
    Write-Host ''

    Write-Head '  IMPRESSIVE_OCR_DATA_DIR'
    Write-Host  "    now      $dataDir"
    Write-Dim   '    default  %LOCALAPPDATA%\ImpressiveOCR   (that is on C:)'
    Write-Dim   '    This script defaults it next to the repo instead, because the OCR model'
    Write-Dim   '    weights underneath it run to several GB.'
    Write-Host ''

    Write-Head '  IMPRESSIVE_OCR_PORT'
    Write-Host  "    now      $ApiPort"
    Write-Dim   '    default  8084. Must be 1024-65535. The web dev server proxies /api to it,'
    Write-Dim   '    so changing it also means changing BACKEND_PORT in apps/web/vite.config.ts.'
    Write-Host ''

    Write-Head '  IMPRESSIVE_OCR_UV_BINARY'
    Write-Host  ("    now      " + $(if ($env:IMPRESSIVE_OCR_UV_BINARY) { $env:IMPRESSIVE_OCR_UV_BINARY } else { '(unset)' }))
    Write-Dim   '    default  <repo>\vendor\uv\uv.exe'
    Write-Dim   '    uv builds the Python runtime. vendor/ is gitignored and fetched at build'
    Write-Dim   '    time, so a fresh clone must supply it before the runtime can install.'
    Write-Host ''

    Write-Rule
    Write-Head 'What gets stored where'
    Write-Host ''
    Write-Host  "  $dataDir\"
    Write-Dim   '    runtime\venv        Python interpreter and packages   ~2 GB'
    Write-Dim   '    runtime\models      PaddleOCR weights                 ~1-4 GB, grows'
    Write-Dim   '    runtime\uv-cache    uv download cache                 ~1 GB'
    Write-Dim   '    impressive-ocr.db   job history and settings          small'
    Write-Dim   '    logs\               server logs                       small'
    Write-Host ''
    Write-Dim   '  %TEMP%\impressive-ocr-work    in-flight job scratch, safe to delete'
    Write-Dim   "  $RunDir    launcher pid and logs, safe to delete"
    Write-Host ''
    Write-Warn  '  Keep the data dir off C: if C: is tight. Nothing here is precious except'
    Write-Warn  '  impressive-ocr.db; deleting the runtime just means installing it again.'
    Write-Host ''

    Write-Rule
    Write-Head 'Making it permanent'
    Write-Host ''
    Write-Host  "  Copy dev\dev.env.example to dev\dev.env and edit it. This script loads that"
    Write-Host  '  file on every run, and dev.env is gitignored.'
    Write-Host ''
    Write-Dim   '  For your whole account instead:'
    Write-Dim   '    [Environment]::SetEnvironmentVariable("IMPRESSIVE_OCR_DATA_DIR", "D:\ocr-data", "User")'
    Write-Host ''
}

# ------------------------------------------------------------------- menu ----

function Show-Header {
    $apiUp = Test-PortBusy $ApiPort
    $webUp = Test-PortBusy $WebPort

    Write-Host ''
    Write-Head '=============================================================='
    Write-Head ' Impressive OCR - development stack'
    Write-Head '=============================================================='
    Write-Dim  "  repo      $RepoRoot"
    Write-Dim  "  data dir  $env:IMPRESSIVE_OCR_DATA_DIR"

    if ($apiUp) { Write-Good "  API       http://127.0.0.1:$ApiPort   running" }
    else { Write-Dim "  API       http://127.0.0.1:$ApiPort   stopped" }

    if ($webUp) { Write-Good "  Web UI    http://localhost:$WebPort   running" }
    else { Write-Dim "  Web UI    http://localhost:$WebPort   stopped" }

    Write-Rule
}

function Show-Menu {
    while ($true) {
        Show-Header
        Write-Host '  1) Start'
        Write-Host '  2) Stop'
        Write-Host '  3) Restart'
        Write-Host '  4) Status'
        Write-Host '  5) Environment / where things are stored'
        Write-Host '  6) Check / install prerequisites'
        Write-Host '  Q) Quit'
        Write-Host ''
        $choice = Read-Host '  Select'
        Write-Host ''

        # Enter on its own redraws rather than scolding: it is what someone types to see the
        # current state again, and "Not an option" for a blank line reads as a fault.
        if ($choice.Trim() -eq '') {
            continue
        }

        switch ($choice.Trim().ToLower()) {
            '1' { Start-Stack }
            '2' { Stop-Stack }
            '3' { Stop-Stack; Start-Sleep -Seconds 1; Start-Stack }
            '4' { Show-Status }
            '5' { Show-Environment }
            '6' { Install-Prerequisites }
            'q' { return }
            'quit' { return }
            'exit' { return }
            default { Write-Warn '  Not an option.' }
        }

        Write-Host ''
        Write-Dim '  Press Enter to continue...'
        [void] (Read-Host)
    }
}

# ------------------------------------------------------------------- main ----

Resolve-DevEnvironment | Out-Null

switch ($Action) {
    'start' { Start-Stack }
    'stop' { Stop-Stack }
    'restart' { Stop-Stack; Start-Sleep -Seconds 1; Start-Stack }
    'status' { Show-Status }
    'env' { Show-Environment }
    'doctor' { Install-Prerequisites }
    default { Show-Menu }
}
