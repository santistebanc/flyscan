[CmdletBinding()]
param(
    [ValidateSet("public", "private")][string]$Edition = "public",
    [string]$UpdateOrigin = "",
    [string]$Python = ".venv/Scripts/python.exe",
    [switch]$SkipTests,
    [switch]$UpdaterRelease,
    [string]$ReleaseRepository = "santistebanc/flight-scraper-releases",
    [string]$SigningThumbprint = ""
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if ([Environment]::OSVersion.Platform -ne "Win32NT") { throw "Build this installer on Windows." }

function Invoke-Native([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

Push-Location $projectRoot
try {
    foreach ($tool in @("uv", "npm.cmd", "cargo", "rustup")) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing build tool: $tool" }
    }
    $pythonPath = if (Test-Path -LiteralPath $Python) { (Resolve-Path -LiteralPath $Python).Path } else { $Python }
    $platform = & $pythonPath -c "import sys, sysconfig; print(f'{sysconfig.get_platform()} {sys.version_info.major}.{sys.version_info.minor}')"
    if ($LASTEXITCODE -ne 0 -or $platform.Trim() -ne "win-amd64 3.12") { throw "Use an x64 Python 3.12 interpreter for the Windows x64 installer." }
    $version = (Get-Content desktop/package.json -Raw | ConvertFrom-Json).version
    $tauriVersion = (Get-Content desktop/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
    if ($version -ne $tauriVersion) { throw "Frontend and Tauri versions disagree." }
    if ($UpdaterRelease -and -not $env:TAURI_SIGNING_PRIVATE_KEY) { throw "An updater release requires TAURI_SIGNING_PRIVATE_KEY." }
    $target = "x86_64-pc-windows-msvc"
    $buildPython = Join-Path $projectRoot "packaging/.venv-x64/Scripts/python.exe"
    Invoke-Native "uv" @("venv", "--allow-existing", "--python", $pythonPath, "packaging/.venv-x64")
    Invoke-Native "uv" @("pip", "sync", "--python", $buildPython, "packaging/requirements-windows.lock")
    Invoke-Native "npm.cmd" @("ci", "--prefix", "desktop")
    if (-not $SkipTests) {
        Invoke-Native $buildPython @("-m", "unittest", "discover", "-s", "tests", "-q")
        Invoke-Native "npm.cmd" @("test", "--prefix", "desktop")
    }
    Invoke-Native "npm.cmd" @("audit", "--prefix", "desktop", "--audit-level=high")
    Invoke-Native "npm.cmd" @("run", "build", "--prefix", "desktop")
    $env:FLYSCAN_EDITION = $Edition
    $prepareArguments = @("packaging/prepare-edition.py", "--edition", $Edition)
    if ($UpdateOrigin) { $prepareArguments += @("--update-origin", $UpdateOrigin) }
    Invoke-Native $pythonPath $prepareArguments
    $editionConfig = Join-Path $projectRoot "packaging/build/edition.json"
    $product = if ($Edition -eq "private") { "Flyscan Private" } else { "Flyscan" }
    $releasePrefix = if ($Edition -eq "private") { "Flyscan-Private" } else { "Flyscan" }
    $sidecar = Join-Path $projectRoot "packaging/dist/x64/flyscan-sidecar.exe"
    $started = [DateTime]::UtcNow
    Invoke-Native $buildPython @("-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", "packaging/dist/x64", "--workpath", "packaging/build/x64", "packaging/flyscan-sidecar.spec")
    if (-not (Test-Path -LiteralPath $sidecar) -or (Get-Item -LiteralPath $sidecar).LastWriteTimeUtc -lt $started) { throw "The sidecar was not rebuilt; refusing to package a stale binary." }
    Invoke-Native $buildPython @("packaging/smoke_sidecar.py", $sidecar, "--edition", $Edition)
    $binaryDirectory = Join-Path $projectRoot "desktop/src-tauri/binaries"
    New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
    Copy-Item -LiteralPath $sidecar -Destination (Join-Path $binaryDirectory "flyscan-sidecar-$target.exe") -Force
    Invoke-Native "rustup" @("target", "add", $target)
    if (-not $SkipTests) {
        Invoke-Native "cargo" @("test", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--release", "--target", $target, "--locked", "--bin", "flyscan-desktop")
    }
    $tauriArguments = @("run", "tauri", "--prefix", "desktop", "--", "build", "--target", $target, "--bundles", "nsis", "--ci")
    $overridesFile = Join-Path $projectRoot "packaging/build/bundle-overrides.json"
    $bundleOverrides = @{ createUpdaterArtifacts = [bool]$UpdaterRelease }
    if ($SigningThumbprint) { $bundleOverrides.windows = @{ certificateThumbprint = $SigningThumbprint; digestAlgorithm = "sha256"; timestampUrl = "http://timestamp.digicert.com" } }
    [IO.File]::WriteAllText($overridesFile, (@{ bundle = $bundleOverrides } | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $tauriArguments += @("--config", $editionConfig, "--config", $overridesFile)
    $tauriArguments += @("--", "--locked")
    Invoke-Native "npm.cmd" $tauriArguments
    $installer = Join-Path $projectRoot "desktop/src-tauri/target/$target/release/bundle/nsis/${product}_${version}_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $installer)) { throw "NSIS installer was not produced." }
    $releaseDirectory = Join-Path $projectRoot "release"
    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    $releaseName = "$releasePrefix-$version-windows-x64-setup.exe"
    $releasePath = Join-Path $releaseDirectory $releaseName
    Copy-Item -LiteralPath $installer -Destination $releasePath -Force
    $hash = (Get-FileHash -LiteralPath $releasePath -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $releaseName" | Set-Content -LiteralPath (Join-Path $releaseDirectory "SHA256SUMS.txt") -Encoding ASCII
    $signature = (Get-AuthenticodeSignature -LiteralPath $releasePath).Status.ToString()
    if ($SigningThumbprint -and $signature -ne "Valid") { throw "Installer signing failed validation." }
    $commit = & git rev-parse HEAD
    $dirty = [bool](& git status --porcelain)
    $buildInfo = @{ edition = $Edition; version = $version; architecture = "x64"; installer = $releaseName; sha256 = $hash; signature = $signature; commit = $commit; uncommittedChanges = $dirty; builtAtUtc = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $releaseDirectory "build-info.json"), $buildInfo, [Text.UTF8Encoding]::new($false))
    if ($UpdaterRelease) {
        $updateSignature = "$installer.sig"
        if (-not (Test-Path -LiteralPath $updateSignature)) { throw "The updater signature was not produced." }
        Copy-Item -LiteralPath $updateSignature -Destination "$releasePath.sig" -Force
        Invoke-Native "cargo" @("run", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--example", "verify-artifact", "--release", "--target", $target, "--locked", "--", $editionConfig, $releasePath, "$releasePath.sig")
        Invoke-Native $buildPython @("packaging/create-update-manifest.py", "--directory", $releaseDirectory, "--version", $version, "--repository", $ReleaseRepository, "--notes", "packaging/release-notes.md", "--edition", $Edition)
    }
    Write-Host "Installer ready: $releasePath (signature: $signature)"
} finally {
    Pop-Location
}
