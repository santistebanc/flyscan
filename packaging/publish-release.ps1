[CmdletBinding()]
param([string]$Repository = "santistebanc/flyscan")
# Publish what create-update-manifest.py checked: every asset it listed in SHA256SUMS.txt,
# with latest.json and the web release, to a draft that goes public only when complete.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Push-Location $projectRoot
try {
    if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "Invalid release repository." }
    $manifest = Get-Content release/latest.json -Raw | ConvertFrom-Json
    $version = $manifest.version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid release version." }
    $tag = "v$version"
    if ($env:RELEASE_TAG -and $env:RELEASE_TAG -ne $tag) { throw "The release tag does not match the built app version." }
    $assets = @()
    foreach ($line in Get-Content release/SHA256SUMS.txt) {
        $hash, $name = $line -split '  ', 2
        if ($name -notmatch '^Flyscan-[A-Za-z0-9_.-]+$') { throw "Unexpected asset $name." }
        if ((Get-FileHash "release/$name" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw "Checksum mismatch for $name." }
        $assets += "release/$name"
    }
    foreach ($platform in $manifest.platforms.PSObject.Properties) {
        $name = [IO.Path]::GetFileName(([Uri]$platform.Value.url).AbsolutePath)
        if ($platform.Value.url -ne "https://github.com/$Repository/releases/download/$tag/$name" -or "release/$name" -notin $assets) {
            throw "Update manifest entry $($platform.Name) does not match these release assets."
        }
    }
    $webArchive = "release/flyscan-web.tar.gz"
    if (-not (Test-Path -LiteralPath $webArchive)) { throw "The matching web release is missing." }
    $releases = & gh release list --repo $Repository --json tagName,isDraft --limit 100
    if ($LASTEXITCODE -ne 0) { throw "Could not read the releases of $Repository." }
    $existing = @($releases | ConvertFrom-Json | Where-Object { $_.tagName -eq $tag })
    if ($existing.Count) {
        if (-not $existing[0].isDraft) { throw "This version is already published. Publish a new version instead of overwriting it." }
    } else {
        & gh release create $tag --repo $Repository --draft --title "Flyscan $version" --notes-file packaging/release-notes.md
        if ($LASTEXITCODE -ne 0) { throw "Could not create the draft release in $Repository." }
    }
    & gh release upload $tag --repo $Repository --clobber @assets release/latest.json release/SHA256SUMS.txt $webArchive
    if ($LASTEXITCODE -ne 0) { throw "Asset upload failed; the release remains a draft." }
    & gh release edit $tag --repo $Repository --draft=false --latest --notes-file packaging/release-notes.md
    if ($LASTEXITCODE -ne 0) { throw "Release publication failed." }
    Write-Host "Published https://github.com/$Repository/releases/tag/$tag"
} finally { Pop-Location }
