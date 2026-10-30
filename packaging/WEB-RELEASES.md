# Public and private releases

The **Release** workflow produces four version-matched artifacts: public Windows,
private Windows, public web and private web. Every running app shows its version,
edition and whether it is running on the desktop or the web. This uses the Python
service's version, not a separately maintained frontend version.

Public editions exclude `ff-kayak` and `momondo`. Private editions include all
sources. `FLYSCAN_ENABLED_SOURCES=ff-sky,ff-kiwi` can narrow either edition further;
it cannot re-enable a source excluded by a public build. The source registry,
request parser and scheduler enforce this policy, including retries and restored
queue work. Frozen Windows builds ignore `FLYSCAN_EDITION` environment overrides.

## One release trigger

Configure the destinations below once, then trigger **Release** on `main` as usual.
It checks that destination settings exist before creating a new version/tag. Both
Windows builds are signed and smoke-tested. Both Docker builds are checked before
the complete editions are published. The public assets go to
`RELEASES_REPOSITORY`; private assets go to this private source repository, which
is verified as private before publishing. Each release includes a web source
archive with its Dockerfile and pinned Python dependency lock.

The workflow then deploys that exact tag to two Railway services. Disconnect the
old repository's automatic Railway deployment; the release workflow should be the
only deployment owner. An ordinary push or merge must not deploy a release.
Windows/native CI validates the encrypted password storage; Rust builds are not
run locally.

Repository settings:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Existing updater signing key; keep it unchanged |
| Secret | `RELEASES_TOKEN` | Existing write token for the public downloads repository |
| Secret | `RAILWAY_TOKEN` | Railway project/environment deployment token |
| Variable | `RELEASES_REPOSITORY` | Public downloads repository, currently `santistebanc/flight-scraper-releases` |
| Variable | `RAILWAY_SERVICE_ID` | Public web service in the existing Railway project |
| Variable | `RAILWAY_PRIVATE_SERVICE_ID` | Separate private web/update service in the same project/environment |
| Variable | `PRIVATE_UPDATE_ORIGIN` | Stable HTTPS origin of the private web/update service, without a path |

Use a Railway **project/environment token** as `RAILWAY_TOKEN`, not an account
token. Both services must belong to that token's environment. The workflow uses
the GitHub job token to publish the private GitHub release; it does not need an
additional private write token.

## Prepared Railway destinations

The existing `heartfelt-flow` project now has two empty release services:
`flyscan-public` at `https://flyscan-public-production.up.railway.app` and
`flyscan-private` at `https://flyscan-private-production.up.railway.app`.
Each has a separate `/data` volume, one replica and sleeping enabled. Release
repository variables and the scoped deployment token are configured. The private
password hash, session secret and read-only GitHub token are stored only on the
private service. No release or web deployment was triggered during setup.
The original `flyscan` service and `flyscan.site` remain live until cutover.

## Railway services and domain cutover

Both services run the Dockerfile and `railway.json`. The public image defaults to
the public edition. The private archive and private workflow deployment change
the Dockerfile default to `private`; local private builds can instead use
`docker build --build-arg FLYSCAN_EDITION=private -t flyscan-private .`.
The mode flag is `FLYSCAN_MODE=web`, already set in the image. Production runs
Waitress rather than Flask's development server. Attach separate persistent
volumes at `/data`, one per service. Both prepared Railway services have sleeping
enabled to reduce idle costs. Keep one replica/process per service: SQLite,
the queue, rate budgets and search subscriptions are process-local.

Public service settings:

- `FLYSCAN_PUBLIC_ORIGIN=https://flyscan.site` (a comma-separated list can also
  allow the Railway staging origin during cutover)
- Optional `FLYSCAN_ENABLED_SOURCES` to narrow public sources further.
- Do not set `FLYSCAN_API_KEY`: the public browser cannot keep a shared API key.

Private service settings:

- `FLYSCAN_PUBLIC_ORIGIN` and `FLYSCAN_UPDATE_ORIGIN`: the private HTTPS origin.
- `FLYSCAN_PRIVATE_PASSWORD_HASH`: a Werkzeug password hash of the chosen private
  password. Supply the password through a secure prompt; never put it in shell
  arguments, source, Actions logs or frontend environment variables.
- `FLYSCAN_SESSION_SECRET`: a randomly generated session signing secret.
- `FLYSCAN_RELEASES_TOKEN`: a fine-grained GitHub token with **Contents: read** on
  this private source repository only. This token remains on Railway.
- `FLYSCAN_PRIVATE_RELEASE_REPOSITORY=santistebanc/flyscan`
- Do not set `FLYSCAN_API_KEY`; the private web API uses its signed login session.

Before moving DNS, deploy and check both services at their Railway HTTPS domains.
Check `/v1/version` for the version and edition (after logging into the private
site). Verify public `/v1/sources` excludes Kayak/Momondo and private sources
include them. Confirm a private installer URL rejects an unauthenticated request.
Only then detach `flyscan.site` from the old GitHub Pages site, attach it to the
public Railway service, and apply Railway's CNAME/TXT records at the DNS provider.
Keep the old deployment available for rollback until the new HTTPS site is healthy.
The portfolio's live link remains `https://flyscan.site`.

## Private desktop access and automatic updates

The public app retains its existing installation identity and signed update
endpoint. The private app installs separately as **Flyscan Private**, using
`com.flyscan.private`; its searches, preferences and update channel are separate.
Download the initial installer from the private GitHub release using a GitHub
account that can read this repository. In **App updates**, enter the private
password once. Windows DPAPI encrypts it for the current Windows user. It is not
stored in browser/local storage or embedded in either installer.

The private app checks its protected manifest at startup and every six hours,
authenticates the installer download too, and verifies the existing Tauri
signature before installation. Automatic downloading and installation when idle
are enabled by default for a fresh private installation. Installation waits for
searches and verification windows to finish. Users can disable automatic
installation. The installed app works offline and does not require a login to
use its sources. Password rotation requires reconnecting App updates.

The gateway never redirects clients to unauthenticated private asset URLs. It
streams only an explicitly named installer from a published, matching release;
GitHub authorization is stripped when following an asset redirect off the API
host. There is no shared GitHub token in the desktop app.

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
desktop clearance does not transfer to the Railway IP. Private web therefore
includes all sources but cannot promise that a challenged source will be usable.

## Offline validation

Use `uv run pytest -q`, `npm test --prefix desktop`,
`npm run build --prefix desktop`, and `uv run pre-commit run --all-files`.
`tests/test_deployment.py` exercises edition policy, hosted restrictions, private
login, update authentication and manifest rewriting without contacting providers.
The release workflow builds each container and probes its version, source policy
and password boundary without scraping. It also smoke-tests the packaged sidecar's
edition/source list. Running the hosted server, desktop dev app or actual searches
still requires an explicit owner decision to contact flight sites.
