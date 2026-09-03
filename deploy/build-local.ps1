# SPDX-License-Identifier: AGPL-3.0-or-later
# NOTE: this file is saved as UTF-8 WITH BOM on purpose. Windows PowerShell 5.1
# decodes .ps1 as ANSI without one, which corrupts non-ASCII characters and breaks parsing.
<#
.SYNOPSIS
    Build Impressive OCR locally, publishing nothing.

.DESCRIPTION
    The counterpart to release.ps1, which only bumps and tags and leaves every artifact to
    CI. This builds the artifacts here, on this machine, from the working tree as it stands
    - no git checks, no commit, no tag, no push, no registry. Nothing leaves the machine.

    Secrets come from deploy\.env.local, which is gitignored. Copy .env.local.example to it
    and fill in what you have. Without it the build still runs and produces unsigned
    artifacts that cannot reach the licence server, which is what you want for testing.

    One deliberate limit: a desktop app can only be built for the operating system you are
    on. electron-builder needs the platform's own toolchain, and macOS signing and
    notarisation need macOS. To ship all three you need all three machines - which is the
    reason the tagged CI release exists and why this script is for testing, not for cutting
    a release.

.PARAMETER Target
    desktop, server, docker, or all (default). May be repeated.

.PARAMETER Checks
    Run lint, typecheck and tests before building.

.PARAMETER List
    Show what this host can build, and build nothing.

.PARAMETER Tag
    Image tag for the container build. Defaults to impressive-ocr:<version>-local.

.EXAMPLE
    ./deploy/build-local.ps1
.EXAMPLE
    ./deploy/build-local.ps1 desktop
.EXAMPLE
    ./deploy/build-local.ps1 desktop, docker -Checks
#>
[CmdletBinding()]
param(
    [ValidateSet('desktop', 'server', 'docker', 'all')]
    [string[]]$Target = @('all'),
    [switch]$Checks,
    [switch]$List,
    [string]$Tag
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn { param([string]$Message) Write-Host "!!  $Message" -ForegroundColor Yellow }
function Write-Good { param([string]$Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Info { param([string]$Message) Write-Host "    $Message" }

<#
    Run a native command and fail only on a non-zero exit code.

    Windows PowerShell 5.1 wraps every line a native process writes to stderr in an
    ErrorRecord as soon as that stream is redirected - piping this script to a log file is
    enough to trigger it - and under $ErrorActionPreference = 'Stop' the first such line
    terminates the build even though the command went on to succeed. pnpm and
    electron-builder both write ordinary progress to stderr, so this is not a rare case.

    The exit code is the only honest signal a native process gives, so the preference is
    relaxed around the call and the code checked explicitly afterwards. Cmdlet errors
    elsewhere in the script still stop it.
#>
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Description,
        [Parameter(Mandatory)][string]$Command,
        [string[]]$Arguments = @()
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command @Arguments }
    finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
}

# As above, but returns what the command printed instead of echoing it.
function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory)][string]$Description,
        [Parameter(Mandatory)][string]$Command,
        [string[]]$Arguments = @()
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & $Command @Arguments }
    finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
    return ($output | Select-Object -First 1).ToString().Trim()
}

# --- Secrets ----------------------------------------------------------------
#
# Parsed rather than dot-sourced: the file is shared with the bash script, so it is written
# in KEY=value form rather than as PowerShell. Values are never echoed - a build log is the
# classic place a key leaks.

$EnvFile = Join-Path $PSScriptRoot '.env.local'
if (Test-Path $EnvFile) {
    Write-Step 'Loading deploy\.env.local'
    foreach ($line in Get-Content -LiteralPath $EnvFile) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $split = $trimmed.IndexOf('=')
        if ($split -lt 1) { continue }
        $key = $trimmed.Substring(0, $split).Trim()
        $value = $trimmed.Substring($split + 1).Trim()
        # Strip one layer of quotes, which people add out of habit and which would otherwise
        # become part of the secret.
        if ($value.Length -ge 2) {
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        Set-Item -Path "env:$key" -Value $value
    }
    Write-Good 'Loaded.'
}
else {
    Write-Warn 'No deploy\.env.local - building unsigned, with no licence keys.'
    Write-Info 'Copy deploy\.env.local.example to deploy\.env.local to change that.'
}

# Products have working defaults; only the keys are secret. Setting them here means a build
# without an env file still identifies itself correctly to the licence server.
if (-not $env:IMPRESSIVE_OCR_PRODUCT_COMMUNITY) {
    $env:IMPRESSIVE_OCR_PRODUCT_COMMUNITY = 'impressiveocrcommunity'
}
if (-not $env:IMPRESSIVE_OCR_PRODUCT_COMMERCIAL) {
    $env:IMPRESSIVE_OCR_PRODUCT_COMMERCIAL = 'impressiveocrcommercial'
}

# --- What this host can do --------------------------------------------------

$HostArch = Invoke-NativeCapture 'Reading the host architecture' 'node' @('-p', 'process.arch')
$Version = Invoke-NativeCapture 'Reading the current version' 'node' @('deploy/set-version.mjs', '--current')

$HasDocker = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { docker info *> $null } finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -eq 0) { $HasDocker = $true }
}

$explicit = -not ($Target -contains 'all')
$wantDesktop = if ($explicit) { $Target -contains 'desktop' } else { $true }
$wantServer = if ($explicit) { $Target -contains 'server' } else { $true }
$wantDocker = if ($explicit) { $Target -contains 'docker' } else { $HasDocker }

Write-Step "Impressive OCR $Version - host: win/$HostArch"
Write-Info ("desktop  " + $(if ($wantDesktop) { 'yes  (Windows only - see the note in -? help)' } else { 'no' }))
Write-Info ("server   " + $(if ($wantServer) { 'yes' } else { 'no' }))
if ($wantDocker -and -not $HasDocker) {
    Write-Info 'docker   requested, but Docker is not running'
}
else {
    Write-Info ("docker   " + $(if ($wantDocker) { 'yes' } else { 'no - Docker not available' }))
}

if ($List) { exit 0 }

if ($wantDocker -and -not $HasDocker) {
    throw 'Docker was asked for but `docker info` failed. Start Docker Desktop, or drop the argument.'
}
if (-not $wantDesktop -and -not $wantServer -and -not $wantDocker) {
    Write-Warn 'Nothing to build.'
    exit 0
}

# --- Checks -----------------------------------------------------------------

if ($Checks) {
    Write-Step 'Checks'
    Invoke-Native 'pnpm lint' 'pnpm' @('lint')
    Invoke-Native 'pnpm typecheck' 'pnpm' @('-r', 'typecheck')
    Invoke-Native 'pnpm test' 'pnpm' @('-r', 'test')
}

# --- Shared prerequisites ---------------------------------------------------

Write-Step 'Building the web UI'
Invoke-Native 'Building the web UI' 'pnpm' @('--filter', '@impressive-ocr/web', 'build')

if ($wantDesktop) {
    Write-Step "Fetching the bundled uv for win/$HostArch"
    Invoke-Native 'Fetching uv' 'node' @('deploy/fetch-uv.mjs', '--target', 'win', '--arch', $HostArch)
}
if ($wantServer) {
    Write-Step "Fetching the bundled uv for server/$HostArch"
    Invoke-Native 'Fetching uv' 'node' @('deploy/fetch-uv.mjs', '--target', 'server', '--arch', $HostArch)
}

# --- Desktop ----------------------------------------------------------------

if ($wantDesktop) {
    Write-Step 'Packaging the desktop app for Windows'

    # `--publish never` is already in the package script. It is the one flag that must never
    # be relaxed here: electron-builder will happily create a GitHub release from a laptop.
    $packageArgs = @('--filter', '@impressive-ocr/desktop', 'package', '--win')
    if ($env:AZURE_CLIENT_ID -and $env:AZURE_SIGNING_ENDPOINT) {
        Write-Good 'Azure Trusted Signing configured - signing.'
        $packageArgs += @(
            "-c.win.azureSignOptions.endpoint=$($env:AZURE_SIGNING_ENDPOINT)",
            "-c.win.azureSignOptions.codeSigningAccountName=$($env:AZURE_CODE_SIGNING_ACCOUNT)",
            "-c.win.azureSignOptions.certificateProfileName=$($env:AZURE_CERT_PROFILE)",
            "-c.win.azureSignOptions.publisherName=$($env:AZURE_PUBLISHER_NAME)"
        )
    }
    else {
        Write-Warn 'No Azure signing configuration - the installer will be UNSIGNED (SmartScreen will warn).'
    }
    Invoke-Native 'Packaging the desktop app' 'pnpm' $packageArgs
}

# --- Headless server --------------------------------------------------------

if ($wantServer) {
    Write-Step 'Packaging the headless server'
    Write-Warn 'Packaging on Windows cannot record the POSIX executable bit.'
    Write-Info 'The launcher inside the tarball will not be runnable. Build this one on Linux to ship it.'
    Invoke-Native 'Packaging the headless server' 'node' @('deploy/package-server.mjs', '--arch', $HostArch)
}

# --- Container image --------------------------------------------------------

if ($wantDocker) {
    $imageTag = if ($Tag) { $Tag } else { "impressive-ocr:$Version-local" }
    Write-Step "Building the container image ($imageTag)"

    # Built for local use only: loaded into the daemon, never pushed, and tagged `-local` so
    # it cannot be mistaken for the published ghcr.io image. Build args rather than runtime
    # environment, matching the released image, so registration works on first run.
    Invoke-Native 'Building the container image' 'docker' @(
        'build',
        '-f', 'deploy/docker/Dockerfile',
        '--platform', 'linux/amd64',
        '--build-arg', "PRODUCT_COMMUNITY=$($env:IMPRESSIVE_OCR_PRODUCT_COMMUNITY)",
        '--build-arg', "PRODUCT_COMMERCIAL=$($env:IMPRESSIVE_OCR_PRODUCT_COMMERCIAL)",
        '--build-arg', "INSTALLER_KEY_COMMUNITY=$($env:IMPRESSIVE_OCR_INSTALLER_KEY_COMMUNITY)",
        '--build-arg', "INSTALLER_KEY_COMMERCIAL=$($env:IMPRESSIVE_OCR_INSTALLER_KEY_COMMERCIAL)",
        '-t', $imageTag,
        '.'
    )
    Write-Good "Image built: $imageTag"
    Write-Info "Run it:  docker run -d -p 127.0.0.1:8084:8084 -v impressive-ocr-data:/data $imageTag"
}

# --- Done -------------------------------------------------------------------

Write-Host ''
Write-Host "Built $Version locally. Nothing was pushed." -ForegroundColor Green

$releaseDir = Join-Path $RepoRoot 'dist/release'
if (Test-Path $releaseDir) {
    # Only the shippable files. electron-builder also leaves win-unpacked\ there, which is
    # gigabytes of intermediate output.
    $artifacts = Get-ChildItem -LiteralPath $releaseDir -File |
        Where-Object { $_.Extension -in @('.exe', '.dmg', '.zip', '.AppImage', '.deb', '.gz') }
    if ($artifacts) {
        Write-Host 'Artifacts in dist/release:'
        foreach ($item in $artifacts) {
            Write-Info ('{0,8:N1} MB  {1}' -f ($item.Length / 1MB), $item.Name)
        }
    }
}
