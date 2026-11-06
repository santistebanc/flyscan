[CmdletBinding()]
param(
    [string]$Python = ".venv/Scripts/python.exe",
    [ValidateSet("x64", "arm64")]
    [string]$Architecture = "x64",
    [switch]$SkipTests,
    [switch]$UpdaterRelease,
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
    # PyInstaller freezes the interpreter it runs in, so the Python must match the installer.
    $architectures = @{
        x64 = @{ python = "win-amd64"; target = "x86_64-pc-windows-msvc"; update = "windows-x86_64" }
        arm64 = @{ python = "win-arm64"; target = "aarch64-pc-windows-msvc"; update = "windows-aarch64" }
    }
    $arch = $architectures[$Architecture]
    $platform = & $pythonPath -c "import sys, sysconfig; print(f'{sysconfig.get_platform()} {sys.version_info.major}.{sys.version_info.minor}')"
    if ($LASTEXITCODE -ne 0 -or $platform.Trim() -ne "$($arch.python) 3.12") { throw "Use an $Architecture Python 3.12 interpreter for the Windows $Architecture installer." }
    $version = (Get-Content desktop/package.json -Raw | ConvertFrom-Json).version
    $tauriVersion = (Get-Content desktop/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
    if ($version -ne $tauriVersion) { throw "Frontend and Tauri versions disagree." }
    if ($UpdaterRelease -and -not $env:TAURI_SIGNING_PRIVATE_KEY) { throw "An updater release requires TAURI_SIGNING_PRIVATE_KEY." }
    $target = $arch.target
    $buildPython = Join-Path $projectRoot "packaging/.venv-$Architecture/Scripts/python.exe"
    Invoke-Native "uv" @("venv", "--allow-existing", "--python", $pythonPath, "packaging/.venv-$Architecture")
    Invoke-Native "uv" @("pip", "sync", "--python", $buildPython, "packaging/requirements-windows.lock")
    Invoke-Native "npm.cmd" @("ci", "--prefix", "desktop")
    Invoke-Native "npm.cmd" @("ci", "--prefix", "backend")
    $env:FLYSCAN_PYTHON = $buildPython
    if (-not $SkipTests) {
        Invoke-Native "npm.cmd" @("run", "test:packaging")
        Invoke-Native "npm.cmd" @("run", "test:transport")
        Invoke-Native "npm.cmd" @("test", "--prefix", "desktop")
        Invoke-Native "npm.cmd" @("test", "--prefix", "backend")
    }
    Invoke-Native "npm.cmd" @("audit", "--prefix", "desktop", "--audit-level=high")
    Invoke-Native "npm.cmd" @("audit", "--prefix", "backend", "--audit-level=high")
    Invoke-Native "npm.cmd" @("run", "build", "--prefix", "desktop")
    Invoke-Native "npm.cmd" @("run", "build", "--prefix", "backend")
    $tauriConfig = Join-Path $projectRoot "desktop/src-tauri/tauri.conf.json"
    $sidecar = Join-Path $projectRoot "packaging/dist/$Architecture/flyscan-sidecar.exe"
    $started = [DateTime]::UtcNow
    Invoke-Native "node" @("packaging/build-sidecar.mjs", "--python", $buildPython, "--platform", $Architecture)
    if (-not (Test-Path -LiteralPath $sidecar) -or (Get-Item -LiteralPath $sidecar).LastWriteTimeUtc -lt $started) { throw "The sidecar was not rebuilt; refusing to package a stale binary." }
    Invoke-Native "node" @("packaging/smoke_sidecar.mjs", $sidecar)
    $binaryDirectory = Join-Path $projectRoot "desktop/src-tauri/binaries"
    New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
    Copy-Item -LiteralPath $sidecar -Destination (Join-Path $binaryDirectory "flyscan-sidecar-$target.exe") -Force
    Copy-Item -LiteralPath (Join-Path $projectRoot "packaging/dist/$Architecture/flyscan-transport.exe") -Destination (Join-Path $binaryDirectory "flyscan-transport-$target.exe") -Force
    Invoke-Native "rustup" @("target", "add", $target)
    if (-not $SkipTests) {
        Invoke-Native "cargo" @("test", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--release", "--target", $target, "--locked", "--bin", "flyscan-desktop")
    }
    $tauriArguments = @("run", "tauri", "--prefix", "desktop", "--", "build", "--target", $target, "--bundles", "nsis", "--ci")
    $overridesFile = Join-Path $projectRoot "packaging/build/bundle-overrides-$Architecture.json"
    New-Item -ItemType Directory -Path (Split-Path $overridesFile) -Force | Out-Null
    $bundleOverrides = @{ createUpdaterArtifacts = [bool]$UpdaterRelease }
    if ($SigningThumbprint) { $bundleOverrides.windows = @{ certificateThumbprint = $SigningThumbprint; digestAlgorithm = "sha256"; timestampUrl = "http://timestamp.digicert.com" } }
    [IO.File]::WriteAllText($overridesFile, (@{ bundle = $bundleOverrides } | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    $tauriArguments += @("--config", $overridesFile)
    $tauriArguments += @("--", "--locked")
    Invoke-Native "npm.cmd" $tauriArguments
    $installer = Join-Path $projectRoot "desktop/src-tauri/target/$target/release/bundle/nsis/Flyscan_${version}_${Architecture}-setup.exe"
    if (-not (Test-Path -LiteralPath $installer)) { throw "NSIS installer was not produced." }
    $releaseDirectory = Join-Path $projectRoot "release"
    New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
    $releaseName = "Flyscan-$version-windows-${Architecture}-setup.exe"
    $releasePath = Join-Path $releaseDirectory $releaseName
    Copy-Item -LiteralPath $installer -Destination $releasePath -Force
    $signature = (Get-AuthenticodeSignature -LiteralPath $releasePath).Status.ToString()
    if ($SigningThumbprint -and $signature -ne "Valid") { throw "Installer signing failed validation." }
    $files = @($releaseName)
    $updates = @{}
    if ($UpdaterRelease) {
        $updateSignature = "$installer.sig"
        if (-not (Test-Path -LiteralPath $updateSignature)) { throw "The updater signature was not produced." }
        Copy-Item -LiteralPath $updateSignature -Destination "$releasePath.sig" -Force
        Invoke-Native "cargo" @("run", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--example", "verify-artifact", "--release", "--target", $target, "--locked", "--", $tauriConfig, $releasePath, "$releasePath.sig")
        $files += "$releaseName.sig"
        $updates[$arch.update] = $releaseName
    }
    $hashes = [ordered]@{}
    foreach ($file in $files) { $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $releaseDirectory $file) -Algorithm SHA256).Hash.ToLowerInvariant() }
    $commit = & git rev-parse HEAD
    $dirty = [bool](& git status --porcelain)
    $buildInfo = [ordered]@{ version = $version; platform = "windows-$Architecture"; files = $hashes; updates = $updates; signature = $signature; commit = $commit; uncommittedChanges = $dirty; builtAtUtc = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Join-Path $releaseDirectory "build-info-windows-$Architecture.json"), $buildInfo, [Text.UTF8Encoding]::new($false))
    Write-Host "Installer ready: $releasePath (signature: $signature)"
} finally {
    Pop-Location
}
