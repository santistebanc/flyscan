# Desktop release builds

For what a release contains, the web deployment and flyscan.site, see
[RELEASES.md](RELEASES.md).

Every build includes the React UI, Tauri shell, compiled TypeScript backend, Node runtime and a frozen curl-only transport.
Users do not need Python, Node or Rust. Each OS builds on its own machine,
because PyInstaller does not cross-compile.

| OS | Download | Runs on |
| --- | --- | --- |
| Windows | `Flyscan-<v>-windows-x64-setup.exe`, `Flyscan-<v>-windows-arm64-setup.exe` | Windows 10/11 x64, or Windows 11 ARM64 |
| macOS | `Flyscan-<v>-macos-arm64.dmg`, `Flyscan-<v>-macos-x64.dmg` | macOS 11 or later, Apple Silicon or Intel |
| Linux | `Flyscan-<v>-linux-x64.AppImage`, `.deb`, `.rpm`, and the same for `linux-arm64` | x86-64 or ARM64 with glibc 2.35 or later (Ubuntu 22.04, Debian 12, Fedora 36 and newer) and WebKitGTK 4.1 |

The Windows installer installs for the current user, adds a Start menu entry,
registers an uninstaller, and checks for WebView2. The Microsoft bootstrapper is
embedded; installing WebView2 when it is missing requires an internet
connection. There is no 32-bit build.

## Build on Windows

The Windows build machine needs Node 22.13+, Python 3.12, uv, Rust stable and
Visual Studio C++ Build Tools with the Windows SDK and the C++ tools for the
target architecture. From the repository root:

```powershell
./packaging/build-windows.ps1 -Python .venv/Scripts/python.exe
```

That builds the x64 installer with an x64 Python. `-Architecture arm64` builds
the ARM64 installer, on an ARM64 machine with ARM64 Node and Python. The frozen
curl worker runs on the architecture of the Python that froze it. The script creates an
isolated build environment, synchronizes `requirements-windows.lock`, installs
the npm lockfile, runs TypeScript, transport and native regression tests and npm audit, builds the UI,
freezes and smoke-tests the service, and builds NSIS using the Cargo lockfile.
A stale or missing sidecar fails the build. `-SkipTests` is for local iteration.

## Build on macOS or Linux

The build machine needs Node 22.13+, a native Python 3.12, uv and Rust stable;
Linux also needs the WebKitGTK development packages Tauri lists
(`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils`
on Debian and Ubuntu). From the repository root:

```bash
packaging/build-unix.sh --python python3.12
```

It runs the same steps as the Windows script with `requirements-macos.lock` or
`requirements-linux.lock`, for the machine's own architecture, and makes a disk
image on macOS or an AppImage, `.deb` and `.rpm` on Linux. `--skip-tests` is
for local iteration. The locks are compiled with the Windows lock as a
constraint, so every OS freezes the same versions; recompile all three together
(the command is at the top of each).

Each build leaves its downloads in `release/` with `build-info-<platform>.json`:
version, source revision, dirty-workspace and signing status, and the SHA-256
of every file.

## Automatic updates and releases

A release is one trigger, the **Release** workflow, started from the Actions
tab, the GitHub app or:

```bash
gh workflow run release                      # the next patch, notes from the commits
gh workflow run release -f version=0.4.0 -f notes="What changed"
```

It bumps every version file (`set-version.mjs`), writes
`packaging/release-notes.md`, commits `Release vX.Y.Z` and its tag to `main`,
then builds on Windows and Linux (x64 and ARM64) and macOS (Apple Silicon and
Intel) at once, each on a native runner. Each
build runs every test, signs its updates and verifies each signature against the
public key embedded in the app. `create-update-manifest.mjs` then checks that all
six builds are there, of this version and with the bytes they recorded, and
writes one `latest.json` for every platform and `SHA256SUMS.txt`. Everything is
uploaded to a draft release in this repository, which is published once
complete. One failed build publishes nothing.
Published versions cannot be overwritten, and a version must be newer than the
last for installed apps to take it.

The release workflow needs `TAURI_SIGNING_PRIVATE_KEY` as a repository Actions
secret. It publishes with the workflow's own token.

The updater public key is committed in `tauri.conf.json`. The private key is
backed up locally outside the checkout under `~/.flight-scraper-signing/` with
restricted filesystem permissions and stored encrypted in GitHub Secrets.
Keep an additional secure backup: changing or losing that key breaks updates
for existing installations. Never commit it, include it in artifacts or print it.

For a local signed updater build, set `TAURI_SIGNING_PRIVATE_KEY` to the key's
path and run `build-windows.ps1 -UpdaterRelease` or
`build-unix.sh --updater-release`. The flag requires a signing
key; builds without the flag do not create updater signatures. Tauri update
signatures are separate from the Windows and Apple publisher signatures below.

The desktop app checks at startup and every six hours, downloads and verifies
updates in the background by default, and offers **Restart and update**. The
toolbar's **App updates** dialog shows the installed version, progress, release
notes, **Check now**, and download/startup installation preferences. Startup
installation is opt-in. It never restarts during a search or while verification
windows are open. A fresh authenticated queue check is required before install;
offline or unknown queue state blocks installation. Failed checks and invalid
signatures remain retryable. Existing data and settings stay in the same path.

Versions before 0.3.2 need one manual installation to gain the updater.

## Signing

Without a certificate, builds are explicitly unsigned. Windows may show an
unknown-publisher or SmartScreen warning. For a trusted-publisher release,
arrange a code-signing certificate.

On macOS, a build without a Developer ID is signed ad hoc, which Apple Silicon
requires to run it at all. Gatekeeper still blocks the first launch of a
downloaded copy: open it once, then choose **Open Anyway** under System
Settings > Privacy & Security. Updates installed by the app are not affected.
With an Apple Developer ID, add the optional `APPLE_*` secrets listed in
[RELEASES.md](RELEASES.md): Tauri then signs with the hardened runtime and
`desktop/src-tauri/entitlements.plist`, and notarizes, so it opens without the
warning. `APPLE_CERTIFICATE` is the base64 of the exported `.p12`,
`APPLE_SIGNING_IDENTITY` its name (`Developer ID Application: …`), and
`APPLE_PASSWORD` an app-specific password of `APPLE_ID`.

Linux packages carry no publisher signature; `SHA256SUMS.txt` and the update
signatures cover them.

### Windows publisher signing

With a code-signing certificate and private key in the Windows certificate
store, pass its thumbprint:

```powershell
./packaging/build-windows.ps1 -Python .venv/Scripts/python.exe -SigningThumbprint YOUR_CERTIFICATE_THUMBPRINT
```

The build configures SHA-256 and timestamping, then validates the installer
signature. Keep certificate files, passwords and private keys out of the repo.
Hardware and cloud signing services may need a custom Tauri sign command.

## Installed application

Data, caches, challenge cookies, exports and `sidecar.log` live under
`%LOCALAPPDATA%/com.flightscraper.desktop/` on Windows,
`~/Library/Application Support/com.flightscraper.desktop/` on macOS and
`~/.local/share/com.flightscraper.desktop/` on Linux. The installation directory contains
code only. `FLYSCAN_DATA_DIR` can override the data path for isolated tests.

The shell starts a hidden service on a random loopback port with a fresh session
credential and waits up to 45 seconds for authenticated health before showing
the main window. Startup failures display an error and log location. The frozen
service uses Node's HTTP server. Closing the main window stops it; it also watches the
shell and exits after a crash. A second launch focuses the existing window.
External security-check pages do not receive the session credential.

Verification windows ignore the initial blank page and provisional navigation.
They close after a destination on the source's origin finishes loading outside
the security check and remains stable for two seconds. A redirect back to the
check restarts that wait. Closing the window or reaching the five-minute timeout
leaves verification incomplete. Cookies are read only for the verified site.

Updates preserve data. The Windows uninstaller offers a separate choice to remove app
data; leave it unchecked to retain saved searches and settings.

The frozen-service smoke test uses an empty directory and verifies startup,
session authentication, EventSource authentication, CORS, bundled UI, SQLite and
the production server without contacting flight sources:

```powershell
node packaging/smoke_sidecar.mjs packaging/dist/x64/flyscan-sidecar.exe
```

To test the actual installer on a Windows desktop with no existing installation,
run `./packaging/test-windows-install.ps1`. It installs into an isolated build
directory, launches and closes the app, checks the Start menu shortcut, local
session protection, single-instance behavior and service cleanup after normal
closure and a simulated crash, then uninstalls.
It leaves test data and a verification report, and refuses to replace an existing
installation. The app's window may briefly appear during this test.

## Manual sidecar development

The release script above is the repeatable release path. The lower-level
procedure below remains useful for experimenting with the service separately.

Build both TypeScript bundles, then prepare the Node runtime and frozen curl worker:

```bash
npm ci --prefix backend
npm run build --prefix backend
npm ci --prefix desktop
npm run build --prefix desktop
uv pip install pyinstaller
node packaging/build-sidecar.mjs --python .venv/bin/python --platform linux-x64
node packaging/smoke_sidecar.mjs packaging/dist/linux-x64/flyscan-sidecar
```

On Windows use an absolute or checkout-relative Python executable and the matching
platform label, for example `--python .venv/Scripts/python.exe --platform x64`.
Node and Python must have the same architecture. The prepared directory contains
`flyscan-sidecar` (Node), `flyscan-transport` (only curl/Python), `backend/index.cjs`
and `frontend/`. Tauri bundles the two executables and maps the frontend and backend
into its resource directory. Its Rust launcher starts Node directly.

The curl worker is frozen from `flyscan/transport.py` using PyInstaller's CLI;
there is no Python launcher or Python packaging configuration. Standard input and
output carry JSON lines. Losing the owning pipe terminates the worker even during
an HTTP request, so closing the desktop app cannot strand a native worker.

To run the prepared backend manually:

```bash
packaging/dist/linux-x64/flyscan-sidecar packaging/dist/linux-x64/backend/index.cjs --port 5111 --offline
```

The backend discovers its adjacent transport and frontend. Playwright is omitted
from installed desktop builds; Tauri owns human verification windows.

## Rename compatibility

The application identifier `com.flightscraper.desktop` and the existing
signing-key backup location are deliberately stable so installed applications
retain their data and update trust. Releases moved from
`santistebanc/flight-scraper-releases` to this repository in 0.4.0.
The source repository and application are named `flyscan`.
