# Desktop shell

The only frontend: one React + TypeScript app (Vite), loaded by the Tauri shell, served by `flyscan serve`, and run with live reload in development.

The shell starts the bundled Node runtime with the TypeScript backend (`../backend/`) and talks to its `/v1` API on localhost. The backend owns parsing, storage, scheduling, searches and challenges; `curl_cffi` runs in a private Python worker. Releases bundle Node, Python and the curl libraries, so users install none of them. Shared wire types: `../shared/contracts.ts`.

## Why a desktop app

A source's security check grants cookies, and only those cookies unblock the scraper. If a user clears the check in their own browser, the cookies stay there, out of reach. So the check opens in a window this app owns:

```
challenge_required → open_challenge(url)   Rust: a WebviewWindow
                   → the user solves it
                   → window.cookies()      Rust: reads the jar
                   → POST /v1/challenges/{source}/cookies
```

The code never solves or works around a check. It shows it to the person at the machine and waits.

## Layout

```
src/api.ts        typed client for /v1
src/platform.ts   the calls that need the shell, with browser fallbacks
src/useFlights.ts loadStored reads the DB; runSearch is the only scrape
src/App.tsx       search bar, results, side panel (Flight and Queue tabs)
src/Details.tsx   booking options and itinerary
src/styles.css    "Ledger, refined" theme
src-tauri/        starts the sidecar on a free port; open_challenge, open_external
```

All money on `/v1` is EUR numbers, so the display currency is a re-render, never a new scrape.

## Running it

| Need | Command | Notes |
|---|---|---|
| Develop locally | `./dev.sh` (repo root) → http://localhost:1420 | Hot reload; checks open in a local Chromium; data in `./data` |
| Develop on a remote Linux box | `remote-dev/dev.sh` | Same loop as user services; checks stream over noVNC; prints the URL. `stop` / `status` |
| Use it | the installed app | Built by the Release workflow, see [`../packaging/README.md`](../packaging/README.md) |

Development defaults to `FLYSCAN_OFFLINE=1`.

`npm run tauri dev` is only for work on the shell itself. Copy the built sidecar binaries first. Tauri needs the exact target-triple suffix:

```bash
cd desktop
triple=$(rustc -vV | sed -n 's/host: //p')
cp ../packaging/dist/x64/flyscan-sidecar.exe   src-tauri/binaries/flyscan-sidecar-$triple.exe
cp ../packaging/dist/x64/flyscan-transport.exe src-tauri/binaries/flyscan-transport-$triple.exe
npm run tauri dev
```

`FLYSCAN_SIDECAR` overrides the path.

## Shell gotchas

- `open_challenge` must stay **async**. Reading webview cookies from a sync command deadlocks on Windows.
- The shell reserves a free port. The frontend asks for it with `api_base()`.
- The sidecar is watched from both ends. The shell kills it when the window closes, and the sidecar also gets `--exit-with-parent <pid>`. Without that, a crash or Ctrl+C leaves it holding its port, the database and its own exe, and the next `cargo` build fails with a bare `PermissionDenied`.
- PyInstaller does not cross-compile. Build each architecture's sidecar on that architecture.
