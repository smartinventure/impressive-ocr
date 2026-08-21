# SPDX-License-Identifier: AGPL-3.0-or-later
#
# What the development stack needs, whether this machine has it, and the exact command
# that fixes it. Dot-sourced by dev.ps1.
#
# The required versions are read from package.json rather than repeated here: 'engines.node'
# and 'packageManager' are what CI and pnpm itself enforce, so a second copy would eventually
# disagree with them.
#
# ASCII only, and no PowerShell 7 syntax - see the header of dev.ps1 for why.

# ------------------------------------------------------------- discovery ----

function Resolve-Pnpm {
    foreach ($candidate in @('pnpm.cmd', 'pnpm')) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    # npm's global bin is not always on PATH in the shell that npm just installed into.
    $fallback = Join-Path $env:APPDATA 'npm\pnpm.cmd'
    if (Test-Path $fallback) { return $fallback }
    return $null
}

function Get-PackageManifest {
    $path = Join-Path $RepoRoot 'package.json'
    if (-not (Test-Path $path)) { return $null }
    try { return (Get-Content $path -Raw | ConvertFrom-Json) }
    catch { return $null }
}

function Get-RequiredVersions {
    <#
        @{ Node = '22.12.0'; Pnpm = '9.15.4' }, with fallbacks if package.json cannot be read
        (a preflight check that dies because a file is malformed helps nobody).
    #>
    $required = @{ Node = '22.12.0'; Pnpm = '9.15.4' }
    $manifest = Get-PackageManifest
    if ($null -eq $manifest) { return $required }

    if ($manifest.engines -and $manifest.engines.node) {
        $match = [regex]::Match([string] $manifest.engines.node, '(\d+\.\d+\.\d+)')
        if ($match.Success) { $required.Node = $match.Groups[1].Value }
    }
    if ($manifest.packageManager) {
        $match = [regex]::Match([string] $manifest.packageManager, 'pnpm@(\d+\.\d+\.\d+)')
        if ($match.Success) { $required.Pnpm = $match.Groups[1].Value }
    }
    return $required
}

function Test-VersionAtLeast([string] $Found, [string] $Required) {
    $clean = ([string] $Found).Trim().TrimStart('v')
    $match = [regex]::Match($clean, '^\d+\.\d+\.\d+')
    if (-not $match.Success) { return $false }
    return ([version] $match.Value -ge [version] $Required)
}

function Get-NodeInstallHint {
    # winget ships with Windows 11 and its LTS package is currently Node 24, which satisfies
    # the >= 22 requirement. nvm-windows is the alternative when other projects here need an
    # older Node.
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        return 'winget install OpenJS.NodeJS.LTS'
    }
    return 'download the LTS installer from https://nodejs.org/'
}

# ------------------------------------------------------------ the checks ----

function Get-Prerequisites {
    <#
        One hashtable per check: Name, State ('ok' | 'missing' | 'outdated' | 'warn'),
        Detail (what was found), Fix (the command that repairs it, or $null) and AutoFix
        (whether option 6 may run that command without asking).

        Returned as data rather than printed so that both the status screen and the installer
        work from the same list.
    #>
    $required = Get-RequiredVersions
    $checks = New-Object System.Collections.Generic.List[hashtable]

    # --- node
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        $checks.Add(@{
                Name = 'node'; State = 'missing'; Detail = "not on PATH (need $($required.Node) or newer)"
                Fix  = (Get-NodeInstallHint); AutoFix = $false
            })
    }
    else {
        $version = (& node --version)
        if (Test-VersionAtLeast $version $required.Node) {
            $checks.Add(@{ Name = 'node'; State = 'ok'; Detail = $version; Fix = $null; AutoFix = $false })
        }
        else {
            $checks.Add(@{
                    Name = 'node'; State = 'outdated'; Detail = "$version, but this repo needs $($required.Node) or newer"
                    Fix  = (Get-NodeInstallHint); AutoFix = $false
                })
        }
    }

    # --- pnpm
    $pnpm = Resolve-Pnpm
    if (-not $pnpm) {
        $checks.Add(@{
                Name = 'pnpm'; State = 'missing'; Detail = 'not on PATH'
                Fix  = "npm install -g pnpm@$($required.Pnpm)"; AutoFix = $true
            })
    }
    else {
        $version = (& $pnpm --version)
        if (Test-VersionAtLeast $version $required.Pnpm) {
            $checks.Add(@{ Name = 'pnpm'; State = 'ok'; Detail = "$version"; Fix = $null; AutoFix = $false })
        }
        else {
            # pnpm below the pinned version can resolve a different dependency tree than CI.
            $checks.Add(@{
                    Name = 'pnpm'; State = 'outdated'; Detail = "$version, pinned at $($required.Pnpm)"
                    Fix  = "npm install -g pnpm@$($required.Pnpm)"; AutoFix = $true
                })
        }
    }

    # --- workspace dependencies
    if (Test-Path (Join-Path $RepoRoot 'node_modules')) {
        $checks.Add(@{ Name = 'deps'; State = 'ok'; Detail = 'installed'; Fix = $null; AutoFix = $false })
    }
    else {
        $checks.Add(@{
                Name = 'deps'; State = 'missing'; Detail = 'node_modules is absent'
                Fix  = 'pnpm install'; AutoFix = $true
            })
    }

    # --- uv. Only needed to install the OCR runtime, not to boot the stack, so its absence
    #     is a warning: the UI comes up and says the runtime is not installed.
    $uv = $env:IMPRESSIVE_OCR_UV_BINARY
    if (-not $uv) { $uv = Join-Path $RepoRoot 'vendor\uv\uv.exe' }
    if (Test-Path $uv) {
        $checks.Add(@{ Name = 'uv'; State = 'ok'; Detail = $uv; Fix = $null; AutoFix = $false })
    }
    else {
        $checks.Add(@{
                Name = 'uv'; State = 'warn'; Detail = "absent at $uv - the OCR runtime cannot be installed"
                Fix  = 'node deploy/fetch-uv.mjs'; AutoFix = $true
            })
    }

    # --- Windows on ARM. PaddlePaddle publishes no wheel for it, so everything runs under
    #     Prism emulation, where inference dies without a traceback. Nothing here can fix
    #     that, but an early warning beats debugging a silent crash as an application bug.
    #     process.arch and PROCESSOR_ARCHITECTURE both report x64 under emulation; the CPU
    #     model string is the only signal that survives it.
    try {
        $cpu = (Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1).Name
        if ($cpu -and ($cpu -match 'Snapdragon|ARM|Ampere|Cobalt')) {
            $checks.Add(@{
                    Name = 'cpu'; State = 'warn'; Detail = "$cpu - Windows on ARM has no PaddlePaddle wheel"
                    Fix  = $null; AutoFix = $false
                })
        }
    }
    catch {
        # CIM is unavailable often enough (locked-down machines, containers) that failing the
        # preflight over an advisory check would be wrong.
    }

    return $checks
}

function Write-PrerequisiteReport {
    <#
        Prints the checks and returns $true when nothing blocking is wrong. 'warn' items are
        reported but do not block: the stack starts without uv, and on ARM it starts too, it
        just cannot OCR.
    #>
    $blocked = $false

    foreach ($check in (Get-Prerequisites)) {
        $label = $check.Name.PadRight(6)
        switch ($check.State) {
            'ok' { Write-Dim "  $label$($check.Detail)" }
            'warn' { Write-Warn "  $label$($check.Detail)" }
            default {
                Write-Bad "  $label$($check.Detail)"
                $blocked = $true
            }
        }
        if ($check.Fix) { Write-Dim "          fix: $($check.Fix)" }
    }

    if ($blocked) {
        Write-Host ''
        Write-Warn '  Menu option 6 installs what it safely can and prints the rest.'
    }
    return (-not $blocked)
}

# Kept under its original name: dev.ps1 called this before the checks moved into this file.
function Test-Prerequisites { return (Write-PrerequisiteReport) }

# --------------------------------------------------------------- repairs ----

function Invoke-Fix([hashtable] $Check) {
    Write-Head "  $($Check.Name): $($Check.Fix)"

    # Native stderr is left alone rather than redirected: Windows PowerShell turns it into a
    # NativeCommandError under 'Stop', which looks like a failure after a successful install.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        switch ($Check.Name) {
            'pnpm' { & npm install -g "pnpm@$((Get-RequiredVersions).Pnpm)" }
            'deps' { Push-Location $RepoRoot; try { & (Resolve-Pnpm) install } finally { Pop-Location } }
            'uv' { Push-Location $RepoRoot; try { & node 'deploy/fetch-uv.mjs' } finally { Pop-Location } }
            default { Write-Warn '  Nothing automatic for this one.' }
        }
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

function Install-Prerequisites {
    <#
        Runs the fixes that are safe to run unattended, in dependency order (pnpm before the
        install that needs it), and prints the ones that are not: a Node upgrade replaces a
        system-wide interpreter and asks for elevation, which is not something a dev launcher
        should do behind your back.
    #>
    Write-Head 'Prerequisites'
    $checks = Get-Prerequisites
    $broken = @($checks | Where-Object { $_.State -ne 'ok' -and $_.Fix })

    if (@($broken).Count -eq 0) {
        Write-Good '  Everything needed is present.'
        return
    }

    $manual = @($broken | Where-Object { -not $_.AutoFix })
    if (@($manual).Count -gt 0) {
        Write-Host ''
        Write-Warn '  Run these yourself - they change the machine, not the checkout:'
        foreach ($check in $manual) {
            Write-Host  "    $($check.Fix)"
            Write-Dim   "      ($($check.Name): $($check.Detail))"
        }
        Write-Dim '    Then close this window and start a new shell, so PATH is picked up.'
    }

    $automatic = @($broken | Where-Object { $_.AutoFix })
    if (@($automatic).Count -eq 0) { return }

    Write-Host ''
    Write-Head '  These can be done now:'
    foreach ($check in $automatic) {
        Write-Host "    $($check.Fix)"
        Write-Dim  "      ($($check.Name): $($check.Detail))"
    }
    Write-Host ''

    # A non-interactive host (CI, a scripted run, an editor terminal without stdin) makes
    # Read-Host throw rather than return, so treat an unanswerable question as 'no'.
    $answer = ''
    try { $answer = Read-Host '  Run them? [y/N]' }
    catch {
        Write-Dim '  Not an interactive shell, so nothing was run. The commands above are the whole fix.'
        return
    }
    if ($answer.Trim().ToLower() -ne 'y') {
        Write-Dim '  Left alone.'
        return
    }

    Write-Host ''
    foreach ($check in $automatic) { Invoke-Fix $check }

    Write-Host ''
    Write-Head 'Prerequisites now'
    Write-PrerequisiteReport | Out-Null
}
