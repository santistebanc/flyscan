# Windows release build

The installer includes the React UI, Tauri shell and a frozen Python service.
Users do not need Python, Node or Rust. It installs for the current Windows user,
adds a Start menu entry, registers an uninstaller, and checks for WebView2. The
Microsoft bootstrapper is embedded; installing WebView2 when it is missing
requires an internet connection.

The installer targets Windows x64: Windows 10/11 x64, or Windows 11 ARM64 with
x64 emulation. This build does not produce a native ARM64 or 32-bit installer.

## Build the installer

The Windows build machine needs Node 22+, x64 Python 3.12, uv, Rust stable and
Visual Studio C++ Build Tools with the Windows SDK and x64 C++ tools. From the
repository root:

```powershell
./packaging/build-windows.ps1 -Python .venv/Scripts/python.exe
```

Pass another x64 Python interpreter path if necessary. The script creates an
isolated build environment, synchronizes `requirements-windows.lock`, installs
the npm lockfile, runs Python, frontend and native regression tests and npm audit, builds the UI,
freezes and smoke-tests the service, and builds NSIS using the Cargo lockfile.
A stale or missing sidecar fails the build. `-SkipTests` is for local iteration.

The output is in `release/`: the setup executable, `SHA256SUMS.txt`, and
`build-info.json` with version, source revision, dirty-workspace and signing
status.

## Automatic updates and releases

A release is one trigger, the **Release** workflow, started from the Actions
tab, the GitHub app or:

```bash
gh workflow run release                      # the next patch, notes from the commits
gh workflow run release -f version=0.4.0 -f notes="What changed"
```

It bumps every version file (`set-version.py`), writes
`packaging/release-notes.md`, commits `Release vX.Y.Z` and its tag to `main`,
then runs every test, builds the installer and its Tauri signature, verifies the
signature against the public key embedded in the app, and creates `latest.json`.
It uploads the installer, signature, manifest and checksum to a draft in
`santistebanc/flight-scraper-releases`, then publishes the complete release.
The source repository stays private. Published versions cannot be overwritten,
and a version must be newer than the last for installed apps to take it.

The release workflow needs `TAURI_SIGNING_PRIVATE_KEY` and `RELEASES_TOKEN` as
repository Actions secrets, and `RELEASES_REPOSITORY` as a repository variable.
`RELEASES_TOKEN` needs Contents read/write on only the downloads repository;
renew it before its expiry. The normal GitHub workflow token cannot write to a
different repository; the workflow's own token only commits and tags the
release on `main`.

The updater public key is committed in `tauri.conf.json`. The private key is
backed up locally outside the checkout under `~/.flight-scraper-signing/` with
restricted filesystem permissions and stored encrypted in GitHub Secrets.
Keep an additional secure backup: changing or losing that key breaks updates
for existing installations. Never commit it, include it in artifacts or print it.

For a local signed updater build, set `TAURI_SIGNING_PRIVATE_KEY` to the key's
path and run `build-windows.ps1 -UpdaterRelease`. The flag requires a signing
key; builds without the flag do not create updater signatures. Tauri update
signatures are separate from Windows Authenticode publisher signatures below.

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
`%LOCALAPPDATA%/com.flightscraper.desktop/`. The installation directory contains
code only. `FLIGHT_SCRAPER_DATA_DIR` can override the data path for isolated tests.

The shell starts a hidden service on a random loopback port with a fresh session
credential and waits up to 45 seconds for authenticated health before showing
the main window. Startup failures display an error and log location. The frozen
service uses Waitress. Closing the main window stops it; it also watches the
shell and exits after a crash. A second launch focuses the existing window.
External security-check pages do not receive the session credential.

Verification windows ignore the initial blank page and provisional navigation.
They close after a destination on the source's origin finishes loading outside
the security check and remains stable for two seconds. A redirect back to the
check restarts that wait. Closing the window or reaching the five-minute timeout
leaves verification incomplete. Cookies are read only for the verified site.

Updates preserve data. The uninstaller offers a separate choice to remove app
data; leave it unchecked to retain saved searches and settings.

The frozen-service smoke test uses an empty directory and verifies startup,
session authentication, EventSource authentication, CORS, bundled UI, SQLite and
the production server without contacting flight sources:

```powershell
./packaging/.venv-x64/Scripts/python.exe packaging/smoke_sidecar.py packaging/dist/x64/flight-scraper-sidecar.exe
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

The desktop shell (TypeScript UI) does not reimplement the scrapers — it spawns
this binary and talks to its `/v1` API on localhost. The scraping stays in
Python because `curl_cffi`'s TLS impersonation is what makes the sources answer
a plain HTTP request at all; a browser gets a captcha where it gets a 200.

```bash
uv pip install pyinstaller
python -m PyInstaller --noconfirm --clean --onefile \
  --name flight-scraper-sidecar \
  --distpath packaging/dist --workpath packaging/build --specpath packaging \
  --collect-all curl_cffi --collect-submodules flight_scraper \
  --add-data "../desktop/dist;frontend" \
  --exclude-module playwright --exclude-module patchright \
  --exclude-module scrapling --exclude-module tkinter --exclude-module matplotlib \
  packaging/sidecar.py
```

`--collect-all curl_cffi` is the one that matters: it carries the native libcurl
build. Without it the binary imports fine and then fails on the first request.

The frontend must be built first — `npm install --prefix desktop && npm run
build --prefix desktop` — because `--add-data` carries `desktop/dist` into the
binary as `frontend/`, which is where the server looks when it is packaged.

`--add-data` is resolved relative to **`--specpath`**, not the working
directory, which is why it reads `../desktop/dist` while every other path here
is repo-relative. Get it wrong and PyInstaller prints `Unable to find
...\packaging\templates` and stops — but still exits **0**, so a script around it
carries on and ships a stale binary.

Playwright is excluded on purpose. It exists only to hold a captcha, and the
desktop shell does that in its own webview — which is worth about 150 MB and a
separate `playwright install` step.

## Running it

```
flight-scraper-sidecar --port 5111      # serve the API (the default)
flight-scraper-sidecar scrape BER LON 2026-10-06 --top 5   # any CLI command
```

Anything that is not a known subcommand is treated as arguments to `serve`,
so the shell can just pass a port it has already reserved.

## Historical sidecar measurements

| | |
|---|---|
| binary | 19 MB, single file |
| cold start to first `/v1/health` answer | ~2.2 s |
| scraping | verified from a clean directory with no Python installed |

The ~2.2 s is onefile unpacking to a temp directory on every launch. If that
matters, `--onedir` trades a single file for a faster start.
