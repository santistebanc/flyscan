[CmdletBinding()]
param([string]$Repository = "santistebanc/flight-scraper-releases")
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
Push-Location $projectRoot
try {
    if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw "Invalid release repository." }
    $manifest = Get-Content release/latest.json -Raw | ConvertFrom-Json
    $info = Get-Content release/build-info.json -Raw | ConvertFrom-Json
    $version = $manifest.version
    if ($version -notmatch '^\d+\.\d+\.\d+$' -or $version -ne $info.version) { throw "Release version mismatch." }
    $tag = "v$version"
    if ($env:RELEASE_TAG -and $env:RELEASE_TAG -ne $tag) { throw "The release tag does not match the built app version." }
    $name = "Flight-Scraper-$version-windows-x64-setup.exe"
    $expectedUrl = "https://github.com/$Repository/releases/download/$tag/$name"
    $platform = $manifest.platforms.'windows-x86_64'
    if ($platform.url -ne $expectedUrl -or $platform.signature -ne (Get-Content "release/$name.sig" -Raw).Trim()) { throw "Update manifest does not match these release assets." }
    if ((Get-FileHash "release/$name" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $info.sha256) { throw "Installer checksum mismatch." }
    $releases = & gh release list --repo $Repository --json tagName,isDraft --limit 100
    if ($LASTEXITCODE -ne 0) { throw "Could not read the downloads repository. Check RELEASES_TOKEN." }
    $existing = @($releases | ConvertFrom-Json | Where-Object { $_.tagName -eq $tag })
    if ($existing.Count) {
        if (-not $existing[0].isDraft) { throw "This version is already published. Publish a new version instead of overwriting it." }
    } else {
        & gh release create $tag --repo $Repository --draft --title "Flight Scraper $version" --notes-file packaging/release-notes.md
        if ($LASTEXITCODE -ne 0) { throw "Could not create the draft release. Check RELEASES_TOKEN has Contents write access to $Repository." }
    }
    & gh release upload $tag --repo $Repository --clobber "release/$name" "release/$name.sig" release/latest.json release/SHA256SUMS.txt
    if ($LASTEXITCODE -ne 0) { throw "Asset upload failed; the release remains a draft." }
    & gh release edit $tag --repo $Repository --draft=false --latest --notes-file packaging/release-notes.md
    if ($LASTEXITCODE -ne 0) { throw "Release publication failed." }
    Write-Host "Published https://github.com/$Repository/releases/tag/$tag"
} finally { Pop-Location }
