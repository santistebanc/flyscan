[CmdletBinding()]
param([string]$Installer = "")
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$smokeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "packaging/build/installer-smoke"))
if (-not $smokeRoot.StartsWith(($projectRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { throw "Test directory is outside the project." }
foreach ($registryPath in @("HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/Flight Scraper", "HKLM:/Software/Microsoft/Windows/CurrentVersion/Uninstall/Flight Scraper", "HKLM:/Software/WOW6432Node/Microsoft/Windows/CurrentVersion/Uninstall/Flight Scraper")) {
    if (Test-Path -LiteralPath $registryPath) { throw "Flight Scraper is already installed. This isolated test will not replace your installation." }
}
if (-not $Installer) {
    $version = (Get-Content -LiteralPath (Join-Path $projectRoot "desktop/package.json") -Raw | ConvertFrom-Json).version
    $Installer = "release/Flight-Scraper-$version-windows-x64-setup.exe"
}
$installerPath = (Resolve-Path -LiteralPath (Join-Path $projectRoot $Installer)).Path
$installDirectory = Join-Path $smokeRoot "install"
$dataDirectory = Join-Path $smokeRoot "data"
New-Item -ItemType Directory -Path $installDirectory, $dataDirectory -Force | Out-Null
$oldDataDirectory = [Environment]::GetEnvironmentVariable("FLIGHT_SCRAPER_DATA_DIR", "Process")
$oldWebviewDirectory = [Environment]::GetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", "Process")
$app = $null
$installed = $false
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FlightScraperInstallSmoke {
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);
}
'@

function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$Failure) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 200
    }
    throw $Failure
}

try {
    $setup = Start-Process -FilePath $installerPath -ArgumentList "/S /D=$installDirectory" -WindowStyle Hidden -PassThru
    if (-not $setup.WaitForExit(60000)) { throw "Installer timed out." }
    if ($setup.ExitCode -ne 0) { throw "Installer failed with exit code $($setup.ExitCode)." }
    $installed = $true
    $appPath = Join-Path $installDirectory "flight-scraper-desktop.exe"
    foreach ($file in @($appPath, (Join-Path $installDirectory "flight-scraper-sidecar.exe"), (Join-Path $installDirectory "uninstall.exe"))) {
        if (-not (Test-Path -LiteralPath $file)) { throw "Installer did not create $file" }
    }
    $shortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Flight Scraper/Flight Scraper.lnk"
    if (-not (Test-Path -LiteralPath $shortcut)) { throw "Start menu shortcut was not created." }
    [Environment]::SetEnvironmentVariable("FLIGHT_SCRAPER_DATA_DIR", $dataDirectory, "Process")
    [Environment]::SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", (Join-Path $dataDirectory "webview2"), "Process")
    $app = Start-Process -FilePath $appPath -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
    Wait-Until {
        $app.Refresh()
        if ($app.HasExited) { throw "Installed app exited during startup. Check $dataDirectory/sidecar.log" }
        $app.MainWindowHandle -ne 0 -and [FlightScraperInstallSmoke]::IsWindowVisible($app.MainWindowHandle)
    } 55 "Installed app never showed its main window. Check sidecar.log."
    Wait-Until {
        $app.Refresh()
        if ($app.HasExited) { throw "Installed app exited before starting its service. Check $dataDirectory/sidecar.log" }
        @(Get-CimInstance Win32_Process -Filter "Name='flight-scraper-sidecar.exe'" | Where-Object { $_.CommandLine -match "--exit-with-parent\s+$($app.Id)(\s|$)" }).Count -gt 0
    } 50 "Installed app did not start its bundled service. Window: $($app.MainWindowTitle). Check sidecar.log."
    $serviceProcesses = @(Get-CimInstance Win32_Process -Filter "Name='flight-scraper-sidecar.exe'" | Where-Object { $_.CommandLine -match "--exit-with-parent\s+$($app.Id)(\s|$)" })
    if (-not $serviceProcesses.Count) { throw "Installed app did not start its bundled service." }
    $match = [regex]::Match($serviceProcesses[0].CommandLine, '--port\s+(\d+)')
    if (-not $match.Success) { throw "Cannot identify the bundled service's loopback port." }
    $port = $match.Groups[1].Value
    Wait-Until {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$port/v1/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
        } catch {
            if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { return $true }
            return $false
        }
        throw "The installed API accepted an unauthenticated request."
    } 45 "The installed API never became ready with session protection."
    $second = Start-Process -FilePath $appPath -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
    if (-not $second.WaitForExit(10000)) { $second.Kill(); throw "Second launch did not reuse the existing app." }
    $marker = Join-Path $dataDirectory "retained-data.txt"
    [IO.File]::WriteAllText($marker, "Installer persistence check")
    if (-not $app.CloseMainWindow()) { throw "Could not close the installed app normally." }
    if (-not $app.WaitForExit(15000)) { throw "The app did not close normally." }
    Wait-Until { -not @(Get-CimInstance Win32_Process -Filter "Name='flight-scraper-sidecar.exe'" | Where-Object { $_.CommandLine -match "--exit-with-parent\s+$($app.Id)(\s|$)" }).Count } 10 "Bundled service survived after the app closed."
    # Simulate a shell crash as well: no window-destroyed callback can run.
    $app = Start-Process -FilePath $appPath -WorkingDirectory $smokeRoot -WindowStyle Hidden -PassThru
    Wait-Until {
        $app.Refresh()
        if ($app.HasExited) { throw "Installed app could not restart." }
        $app.MainWindowHandle -ne 0 -and [FlightScraperInstallSmoke]::IsWindowVisible($app.MainWindowHandle) -and
            @(Get-CimInstance Win32_Process -Filter "Name='flight-scraper-sidecar.exe'" | Where-Object { $_.CommandLine -match "--exit-with-parent\s+$($app.Id)(\s|$)" }).Count -gt 0
    } 55 "Installed app never became ready after restart."
    # The Python parent watcher is initialized before it begins serving HTTP.
    $restartedService = @(Get-CimInstance Win32_Process -Filter "Name='flight-scraper-sidecar.exe'" | Where-Object { $_.CommandLine -match "--exit-with-parent\s+$($app.Id)(\s|$)" })
    $restartPort = [regex]::Match($restartedService[0].CommandLine, '--port\s+(\d+)').Groups[1].Value
    Wait-Until {
        try { Invoke-WebRequest -Uri "http://127.0.0.1:$restartPort/v1/health" -UseBasicParsing -TimeoutSec 2 | Out-Null } catch {
            return ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401)
        }
        return $false
    } 45 "Restarted service never became ready."
    $app.Kill()
    $app.WaitForExit(10000) | Out-Null
    Wait-Until { -not @(Get-CimInstance Win32_Process -Filter "Name='flight-scraper-sidecar.exe'" | Where-Object { $_.CommandLine -match "--exit-with-parent\s+$($app.Id)(\s|$)" }).Count } 10 "Bundled service survived a shell crash."
    $uninstaller = Start-Process -FilePath (Join-Path $installDirectory "uninstall.exe") -ArgumentList "/S" -WindowStyle Hidden -PassThru
    if (-not $uninstaller.WaitForExit(30000)) { throw "Uninstaller timed out." }
    Wait-Until { -not (Test-Path -LiteralPath $appPath) } 20 "Uninstaller left the application executable behind."
    $installed = $false
    if (-not (Test-Path -LiteralPath $marker)) { throw "Uninstall removed retained application data." }
    $report = @{ installerSha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant(); install = "passed"; startMenuShortcut = "passed"; launch = "passed"; authenticatedStartup = "passed"; unauthenticatedApiBlocked = "passed"; singleInstance = "passed"; normalClose = "passed"; serviceCleanup = "passed"; crashCleanup = "passed"; uninstall = "passed"; retainedTestData = "passed"; checkedAtUtc = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $projectRoot "release/install-smoke-result.json"), $report, [Text.UTF8Encoding]::new($false))
    Write-Host "Installer passed: install, launch, session protection, single instance, close, service/crash cleanup and uninstall."
} finally {
    if ($app -and -not $app.HasExited) { $app.Kill(); $app.WaitForExit(10000) | Out-Null }
    [Environment]::SetEnvironmentVariable("FLIGHT_SCRAPER_DATA_DIR", $oldDataDirectory, "Process")
    [Environment]::SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", $oldWebviewDirectory, "Process")
    if ($installed) { Write-Warning "The smoke installation remains at $installDirectory. Its uninstaller is in that directory." }
}
