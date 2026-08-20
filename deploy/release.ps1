# SPDX-License-Identifier: AGPL-3.0-or-later
# NOTE: this file is saved as UTF-8 WITH BOM on purpose. Windows PowerShell 5.1
# decodes .ps1 as ANSI without one, which corrupts non-ASCII characters and breaks parsing.
<#
.SYNOPSIS
    Cut a release of Impressive OCR.

.DESCRIPTION
    Bumps the version everywhere, commits, tags and pushes. Pushing the tag is what triggers
    the GitHub Actions release workflow — the tag is the release ledger, so nothing here
    publishes anything directly.

    Refuses to run on a dirty tree, off the main branch, or behind the remote. A release built
    from a working copy nobody else can reproduce is worse than no release.

.PARAMETER Level
    patch (default), minor, or major. Ignored when -Version is given.

.PARAMETER Version
    An explicit version such as 1.4.0, instead of computing the next one.

.PARAMETER SkipChecks
    Skip lint/typecheck/tests. For re-cutting a release whose checks already passed.

.PARAMETER DryRun
    Show what would happen and change nothing.

.EXAMPLE
    ./deploy/release.ps1                     # 1.0.0 -> 1.0.1
.EXAMPLE
    ./deploy/release.ps1 -Level minor        # 1.0.1 -> 1.1.0
.EXAMPLE
    ./deploy/release.ps1 -Version 2.0.0
#>
[CmdletBinding()]
param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Level = 'patch',

    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [switch]$SkipChecks,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Warn($message) { Write-Host "!!  $message" -ForegroundColor Yellow }

# --- Preconditions ----------------------------------------------------------

Write-Step 'Checking the working tree'

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') {
    throw "Releases are cut from main; you are on '$branch'."
}

if ((git status --porcelain)) {
    throw 'The working tree has uncommitted changes. Commit or stash them first.'
}

git fetch origin --tags --quiet
$behind = (git rev-list --count 'HEAD..origin/main').Trim()
if ($behind -ne '0') {
    throw "Your branch is $behind commit(s) behind origin/main. Pull first."
}

# --- Version ----------------------------------------------------------------

$current = (node deploy/set-version.mjs --current).Trim()
Write-Host "    current version: $current"

if ($Version) {
    $next = $Version
} else {
    # Computed from the newest *tag* rather than package.json, so an aborted release that left
    # the tree bumped cannot silently skip a number. --print writes nothing.
    $next = (node deploy/set-version.mjs --next $Level --print).Trim()
}

if ([string]::IsNullOrWhiteSpace($next)) { throw 'Could not determine the next version.' }

$tag = "v$next"
Write-Host "    next version:    $next  (tag $tag)"

if ((git tag --list $tag)) {
    throw "Tag $tag already exists. Delete it or choose another version."
}

if ($DryRun) {
    Write-Warn "Dry run — would release $tag and push to origin."
    exit 0
}

# --- Checks -----------------------------------------------------------------

if (-not $SkipChecks) {
    Write-Step 'Running checks (use -SkipChecks to skip)'
    pnpm install --frozen-lockfile
    pnpm lint
    pnpm -r typecheck
    pnpm -r test
    if ($LASTEXITCODE -ne 0) { throw 'Checks failed; nothing was tagged.' }

    $sidecarPython = Join-Path $repoRoot 'sidecar\.venv\Scripts\python.exe'
    if (Test-Path $sidecarPython) {
        & $sidecarPython -m pytest sidecar -q
        if ($LASTEXITCODE -ne 0) { throw 'Sidecar tests failed; nothing was tagged.' }
    } else {
        Write-Warn 'Sidecar venv not found — skipping Python tests. CI will still run them.'
    }
}

# --- Bump, commit, tag, push ------------------------------------------------

Write-Step "Setting version $next"
node deploy/set-version.mjs $next | Out-Null

Write-Step 'Committing and tagging'
git add -A
git commit -m "release: $tag"
# Annotated, not lightweight: it records who cut the release and when, and `git describe`
# only considers annotated tags by default.
git tag -a $tag -m "Impressive OCR $next"

Write-Step 'Pushing'
git push origin main
git push origin $tag

Write-Host ''
Write-Host "Released $tag." -ForegroundColor Green
$remote = (git remote get-url origin).Trim() -replace '\.git$', '' -replace '^git@github\.com:', 'https://github.com/'
Write-Host "Watch the build:  $remote/actions"
Write-Host "Release will be:  $remote/releases/tag/$tag"
