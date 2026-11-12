# Desktop release builds

What a release contains, the web deployment and flyscan.site: [RELEASES.md](RELEASES.md).

Each build bundles the React UI, Tauri shell, compiled backend, Node runtime and a frozen curl-only transport, so users need no Python, Node or Rust. Each OS builds natively, because PyInstaller does not cross-compile; the curl worker runs on the architecture of the Python that froze it.

| OS | Download | Runs on |
| --- | --- | --- |
| Windows | `Flyscan-<v>-windows-{x64,arm64}-setup.exe` | Windows 10/11 x64, Windows 11 ARM64 |
| macOS | `Flyscan-<v>-macos-{arm64,x64}.dmg` | macOS 11+ |
| Linux | `Flyscan-<v>-linux-{x64,arm64}.AppImage`, `.deb`, `.rpm` | glibc 2.35+ (Ubuntu 22.04, Debian 12, Fedora 36) and WebKitGTK 4.1 |

The Windows installer is per-user, adds a Start menu entry and an uninstaller, and embeds the WebView2 bootstrapper (installing WebView2 needs internet). No 32-bit build.

## Build

| | Windows | macOS / Linux |
|---|---|---|
| Needs | Node 22.13+, Python 3.12, uv, Rust stable, VS C++ Build Tools + Windows SDK for the target arch | Node 22.13+, native Python 3.12, uv, Rust stable; Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils` |
| Command | `./packaging/build-windows.ps1 -Python .venv/Scripts/python.exe` (`-Architecture arm64` on an ARM64 machine with ARM64 Node and Python) | `packaging/build-unix.sh --python python3.12` |
| Skip tests | `-SkipTests` | `--skip-tests` |

Both scripts make an isolated environment, sync the OS lock (`requirements-{windows,macos,linux}.lock`), install npm locks, run TypeScript, transport and native tests plus `npm audit`, build the UI, freeze and smoke-test the service, and package. A stale or missing sidecar fails the build. The macOS and Linux locks are compiled with the Windows lock as a constraint; recompile all three together (command at the top of each). Output goes to `release/` with `build-info-<platform>.json` (version, revision, dirty flag, signing status, SHA-256 of every file).

## Releases and updates

```bash
gh workflow run release                                   # next patch, notes from commits
gh workflow run release -f version=0.4.0 -f notes="What changed"
```

The **Release** workflow bumps every version file (`set-version.mjs`), writes `packaging/release-notes.md`, commits `Release vX.Y.Z` and its tag to `main`, then builds all six targets on native runners. Each build runs every test, signs its update and verifies the signature against the key in the app. `create-update-manifest.mjs` checks all six builds (version and recorded bytes) and writes `latest.json` and `SHA256SUMS.txt`. Everything goes to a draft release that is published only when complete; one failed build publishes nothing. Published versions can't be overwritten, and installed apps only take newer versions.

- **Update key:** the public key is in `tauri.conf.json`; the private key is the `TAURI_SIGNING_PRIVATE_KEY` Actions secret, with an offline backup outside the checkout. Losing or changing it breaks updates for every install. Never commit, bundle or print it.
- **Local signed updater build:** set `TAURI_SIGNING_PRIVATE_KEY` to the key path and pass `-UpdaterRelease` / `--updater-release`. Without the flag no update signatures are made. These are separate from OS publisher signatures.
- **In the app:** checks at start and every 6 hours, downloads and verifies in the background, offers **Restart and update**. Startup install is opt-in. It never restarts during a search or with check windows open, and needs a fresh authenticated queue check first. Data stays in place. Versions before 0.3.2 need one manual install.

## Signing

- **Windows:** unsigned without a certificate (SmartScreen may warn). With a certificate in the store, add `-SigningThumbprint THUMBPRINT`; the build uses SHA-256 with timestamping and validates the result. Hardware or cloud signing may need a custom Tauri sign command.
- **macOS:** without a Developer ID the build is signed ad hoc (Apple Silicon needs that to run); first launch needs **Open Anyway** in Privacy & Security; in-app updates are not affected. With the `APPLE_*` secrets from [RELEASES.md](RELEASES.md), Tauri signs with the hardened runtime and `desktop/src-tauri/entitlements.plist` and notarizes. `APPLE_CERTIFICATE` is the base64 `.p12`, `APPLE_SIGNING_IDENTITY` its name, `APPLE_PASSWORD` an app-specific password of `APPLE_ID`.
- **Linux:** no publisher signature; `SHA256SUMS.txt` and update signatures cover it.

Keep certificates, passwords and keys out of the repo.

## Installed app

- Data, caches, check cookies, exports and `sidecar.log` live in `com.flightscraper.desktop/` under `%LOCALAPPDATA%` (Windows), `~/Library/Application Support` (macOS) or `~/.local/share` (Linux). The install folder holds code only. `FLYSCAN_DATA_DIR` overrides it for tests. The Windows uninstaller asks separately before removing data.
- The shell starts a hidden service on a random loopback port with a fresh session credential and waits up to 45 s for authenticated health. Closing the window stops it; it also exits if the shell crashes. A second launch focuses the existing window. Check pages never get the credential.
- Check windows ignore the first blank page and provisional navigation, and close once a page on the source's origin, outside the check, stays loaded for 2 s. A redirect back to the check restarts the wait. Closing the window or the 5-minute timeout leaves the check incomplete. Cookies are read only for the checked site.

Tests: `node packaging/smoke_sidecar.mjs packaging/dist/x64/flyscan-sidecar.exe` (empty folder; startup, session and EventSource auth, CORS, UI, SQLite; no flight sites). `./packaging/test-windows-install.ps1` installs into an isolated folder on a machine without flyscan, checks the shortcut, session protection, single instance and cleanup after close and crash, then uninstalls. It refuses to replace an existing install.

## Sidecar by hand

```bash
npm ci --prefix backend && npm run build --prefix backend
npm ci --prefix desktop && npm run build --prefix desktop
uv pip install pyinstaller
node packaging/build-sidecar.mjs --python .venv/bin/python --platform linux-x64   # Windows: --python .venv/Scripts/python.exe --platform x64
node packaging/smoke_sidecar.mjs packaging/dist/linux-x64/flyscan-sidecar
packaging/dist/linux-x64/flyscan-sidecar packaging/dist/linux-x64/backend/index.cjs --port 5111 --offline
```

Node and Python must match architectures. The output holds `flyscan-sidecar` (Node), `flyscan-transport` (curl), `backend/index.cjs` and `frontend/`; the backend finds its neighbours. The worker is frozen from `flyscan/transport.py` with the PyInstaller CLI and talks JSON lines on stdin/stdout. Losing its pipe kills it even mid-request, so closing the app cannot strand it.

## Names

The app id `com.flightscraper.desktop` and the signing-key setup stay as they are, so installs keep their data and update trust. Releases moved here from `santistebanc/flight-scraper-releases` in 0.4.0.
