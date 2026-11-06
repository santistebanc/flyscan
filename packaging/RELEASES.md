# Releases

Every release is published in this repository and contains two things built
from the same tag:

- **The desktop app**, which searches every source: a Windows installer, a
  macOS disk image and a Linux AppImage, `.deb` and `.rpm`, each for both
  architectures (x64 and ARM64; Intel and Apple Silicon on macOS). Each comes with its update signature; one `latest.json`
  serves every platform and `SHA256SUMS.txt` covers every file.
- **The web release**: `flyscan-web.tar.gz`, the Dockerfile, pinned Python
  dependency lock and source that run on [flyscan.site](https://flyscan.site).
  The web release leaves out `ff-kayak` and `momondo`; those are searched only
  from the desktop app on the user's own machine.

Every running app shows its version and whether it is the desktop app or the
web. `FLYSCAN_MODE=web`, set in the image, selects the web policy.
`FLYSCAN_ENABLED_SOURCES=ff-sky,ff-kiwi` can narrow the sources further; it
cannot re-enable a source the web leaves out. The source registry, request
parser and scheduler enforce this, including retries and restored queue work.

## One release trigger

Trigger **Release** on `main` (see [README.md](README.md#automatic-updates-and-releases)).
It checks that its settings exist before creating the version and tag. Every
desktop build is signed and smoke-tested on its own OS, and the Docker image is built and
probed before anything is published. The workflow then publishes the release
here with the job's own token and deploys that exact tag to Railway. An
ordinary push or merge does not deploy.

Repository settings:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Existing updater signing key; keep it unchanged |
| Secret | `RAILWAY_TOKEN` | Railway project/environment deployment token |
| Variable | `RAILWAY_SERVICE_ID` | The `flyscan-public` service in the `heartfelt-flow` project |
| Secrets, optional | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Developer ID signing and notarization for macOS (see [README.md](README.md#signing)) |

Use a Railway **project/environment token**, not an account token.

## Railway and flyscan.site

The `flyscan-public` service runs the Dockerfile and `railway.json` with a
persistent volume at `/data`, one replica and sleeping enabled. Keep one
replica: SQLite, the queue, rate budgets and search subscriptions are
process-local. Production runs the bundled TypeScript backend on Node.js; Python only provides the private curl transport.

Service settings:

- `FLYSCAN_PUBLIC_ORIGIN=https://flyscan.site` (a comma-separated list can also
  allow the Railway origin, `https://flyscan-public-production.up.railway.app`).
- Optional `FLYSCAN_ENABLED_SOURCES` to narrow the sources further.
- Do not set `FLYSCAN_API_KEY`: the browser cannot keep a shared API key.

`flyscan.site` is a custom domain on that service. Its DNS needs the CNAME and
TXT records Railway shows for the domain; the apex record needs a DNS provider
with CNAME flattening, such as Cloudflare, with the proxy off.

## Desktop updates

The installed app keeps the identifier `com.flightscraper.desktop`, so data
and settings stay where they were. It checks
`https://github.com/santistebanc/flyscan/releases/latest/download/latest.json`
at startup and every six hours and verifies the Tauri signature before
installing. Each Linux package updates as itself: the AppImage replaces its
file, and the `.deb` and `.rpm` ask for an administrator password to install. Apps from before 0.4 checked `santistebanc/flight-scraper-releases`;
that repository's last release carries a `latest.json` pointing at the first
release here, which moves them over.

## Hosted behavior

Web visitors cannot open server verification windows, submit cookies, modify the
server database, purge history, read server diagnostics, or cancel/retry other
visitors' queue work. The shared queue remains readable. Manual offer editing is
available in the desktop app. Cross-origin writes are refused; writes, queue
capacity, payload size and date ranges are bounded. Source concurrency limits and
cache freshness remain enforced.

A challenged source is recorded for an administrator and finishes as temporarily
unavailable. Later work for it returns that state without sending another live
request. Other sources continue. No code bypasses verification. Server-side
clearance must be performed by a person with access to that server; a user's
desktop clearance does not transfer to the Railway IP.

## Offline validation

Use `npm run test:transport`, `npm run test:packaging`, `npm test --prefix backend`, `npm run build --prefix backend`, `npm test --prefix desktop`,
`npm run build --prefix desktop`, and `uv run pre-commit run --all-files`.
`backend/tests/api.test.ts` exercises the source policy and hosted restrictions
without contacting providers. The release workflow builds the container and
probes its version and source policy without scraping. It also smoke-tests the
packaged sidecar's source list. Running the hosted server, desktop dev app or
actual searches still requires an explicit owner decision to contact flight sites.
