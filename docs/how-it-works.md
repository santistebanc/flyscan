# How flyscan works

## Sources

All five take plain IATA codes: an airport (`LHR`) or a city metacode (`LON`, `BER`, `NYC`), so place lookup is one shared step.

| Source | `--sources` | Search call |
|---|---|---|
| [Kayak (FlightsFinder)](https://ie-kayak.flightsfinder.com) | `ff-kayak` | `POST /i/api/search/dynamic/flights/poll` |
| [Sky (FlightsFinder)](https://www.flightsfinder.com/portal/sky) | `ff-sky` | `POST /portal/sky/poll` |
| [Kiwi (FlightsFinder)](https://www.flightsfinder.com/portal/kiwi) | `ff-kiwi` | `POST /portal/kiwi/search` |
| [Momondo](https://www.momondo.ie) | `momondo` | Kayak engine under `/flight-search/` |
| [Jetradar](https://jetradeu.cheapflightsfinder.com) | `jetradar` | Travelpayouts sign → start → poll |

### Kayak and Momondo (one adapter)

- Fetch the search page for a session cookie and its `formtoken`; send the token as `X-CSRF` or the poll returns 401. Send `searchId` from the first poll on every later poll.
- **Cabin** is `cabinClass` inside each leg; economy omits it. A top-level `cabin` is a validation error. Premium needs two spellings; any other spelling is a 400:

  | Cabin | URL path | Body `cabinClass` |
  |---|---|---|
  | economy | *(omit)* | *(omit)* |
  | premium economy | `premium` | `premium-economy` |
  | business / first | `business` / `first` | `business` / `first` |

- **Passengers.** URL: non-adults in one `children` segment, lap infants first as `1L`, children as ages (`/2adults/children-1L-10`). Body: `passengers` codes in order adults, lap infants, children; a lap infant is `INL` (not `INF`) and each `CHD` in `passengerDetails` carries an `age`.
- **Every child is sent as age 10**, inside every airline's child band. Real ages would change the price on this source only and be invisible to the others and to the stored schema.
- **Paging:** polling only re-reads page 1. Walk `searchMetaData.pageNumber` up to `filteredCount`, or you get about a quarter of the results (50 of 194). Each poll is a snapshot, not a superset, so accumulate by `resultId`.
- **Blocks:** a burst of pages earns 403 `BOT_CAPTCHA_REDIRECT`, scoped to the IP, not the session. A new session does not clear it and retries prolong it, so the adapter paces pages and reports the block.
- **Price:** `priceMode: "per-person"`. `displayPrice` is one traveller's share; `fees.totalPrice` is the party total, which is what the other sources quote.
- **URLs:** Kayak `/flights/`, Momondo `/flight-search/`; e.g. `/flights/BER-LON/2026-08-22//1adults` (one-way, note the empty segment), `/2026-08-22/2026-09-05/1adults` (return), `//business/1adults`.
- Coaches and trains come back with an all-numeric operator and `---` as flight number; they are dropped.

### Sky and Kiwi

The page ships a jQuery block with a CSRF token and a per-load session id. The adapter lifts the whole `data: { … }` object from the page, so the token travels and new upstream parameters work without code changes. Results are a pipe-delimited string whose seventh field is HTML.

| | `ff-sky` | `ff-kiwi` |
|---|---|---|
| path | `/portal/sky` | `/portal/kiwi` |
| dates | `outbounddate=2026-08-22` | `outbounddate=22/08/2026` |
| cabin | `Economy` `PremiumEconomy` `Business` `First` | `M` `W` `C` `F` |
| trip | implied by `inbounddate` | `type=oneway` / `type=return` |

Both share `originplace destinationplace adults children infants currency`.

### Jetradar

1. `POST /whitelabels/web/flights/v1/search/sign` signs the exact payload server-side (no secret to copy).
2. `POST /search/wl/start` sends payload + signature; returns `search_id` and the regional results host.
3. `POST /search/wl/results` on that host with `{"search_id": …}` returns tickets.

Steps 1–2 return 401 without `affiliate-marker` and `x-whitelabel-version: v2`. `trip_class`: `Y` economy, `W` premium, `C` business, `F` first.

**Links.** The storefront token is positional: `ORIGIN + DDMM + DEST + [DDMM return] + [cabin] + adults + children + infants`, e.g. `BER2208LON0509b100`. The cabin letter is lowercase and case-sensitive (uppercase silently means economy). Only `b`/`c` → business survives; `w` and `f` link as economy, so first links as business. This affects only the link. `?flightSearch=TOKEN&ticketId=ID` opens one deal: use the 32-char ticket `id` (not the 16-char `hashsum`). It is stable across searches and safe to store; the page re-prices on arrival.

The airline deep link (`GET {host}/searches/{id}/clicks/{proposal_id}`) is **not used**. It expires after about 15 minutes (`results_ttl_ms` 900000), so it can't be stored, and minting one costs a request per offer.

## Cabins and parties

Every source honours the cabin (checked by sweeping cabins on one route). On short-haul routes like BER–LON, premium economy often costs more than business and first usually returns nothing. That is the market, not a bug.

The party is sent as `counts[adults]`, `counts[children]`, `counts[infants_lap]` and `counts[infants_seat]`, echoed back in each result's `data`; shareable links use the same names flat (`?adults=2&children=3&infants_lap=2`). Round trips are one product on every source.

## Currency

- The database stores **EUR only**, plus each offer's quoted currency and amount. `FlightStore` ignores any other base currency instead of relabelling rows. Sorting, filters and "cheapest" use EUR.
- Display currency (UI selector, `--base-currency` on `query`/`scrape`) is a view: it converts at today's rate and never re-scrapes or writes.
- `ff-kayak` and `momondo` ignore `--currency` and quote EUR (their `.ie` host); `flyscan sources` lists this.
- Rates: [open.er-api.com](https://open.er-api.com), then [Frankfurter](https://frankfurter.dev); cached a day in `.fx_cache.json`.

## Storage

`flights.db`: `fetches` (one row per search × source) → `offers` (one seller, one trip, one fetch) → `trips` (one row per distinct flight, keyed by `trip_key`).

- **No separate cache.** `fetches` is both log and decision: `plan()` says per source *fetch* or *skip and why* (never asked, stale, retrying, retries exhausted, in flight, stuck loading, waiting on a human). An older JSON cache was 25 MB for 50 searches, 47% booking URLs, and was removed.
- A fetch owns its offers: re-fetching replaces them. Source, party, cabin, currency and time come from `fetch_id`. There is no price history.
- **`trip_key`** hashes departure date, actual airports, departure and arrival to the minute, stop count and, when present, the searched return date. Not flight numbers: sources disagree on the carrier (`EC7336` vs `U27336`). The return date stops a round trip without a fixed inbound from merging with a one-way (this happened).
- Re-running is idempotent: trips merge, and blank fields are filled, never overwritten.
- Indexes: `(origin, destination, depart_date, source)` for fetches, the route for trips, price globally and per trip.
- Migrations live in `backend/src/schema.ts`, append-only once released, tracked in `PRAGMA user_version`, one transaction each. A newer database is refused.
- All files (`flights.db`, `.challenges/`, caches, `.errors/`, `out/`) live in the working folder or `FLYSCAN_DATA_DIR`.

## Backend

TypeScript in `backend/src/` (one module per concern: sources, scheduler, challenges, store, searches, api, capture, cli). Python is only `flyscan/transport.py`, a long-lived `curl_cffi` worker on private JSON-lines pipes. It knows nothing about sources, flights or SQLite: sessions are opaque, requests within one are sequential, and responses keep body bytes (base64), repeated headers, final URL and cookie scope.

- A cancelled or timed-out request keeps its worker and source slot until it exits; late results never write.
- Cancelling a search drops only its subscriptions; shared scrapes continue.
- A challenge pauses only its source; clearance resumes the waiting subscriptions.
- `ReplayTransport` reads saved responses only and never falls back to the network.

## API

`npm run flyscan -- serve` (or `node backend/dist/index.cjs serve`) serves `/v1` and the frontend. Routes cover searches (+ SSE `events`, `results`), flights, trips, sources, jobs and queue actions, freshness, manual offers, challenges, places, rates, health, version, errors and maintenance; see `backend/src/api.ts`.

- `FLYSCAN_API_KEY` requires `Authorization: Bearer` or `X-API-Key`. Only the read-only SSE endpoint also accepts `api_key` in the URL. SSE resumes with `Last-Event-ID` or `after` and ends after one terminal event.
- `FLYSCAN_MODE=web` (hosted) disables Kayak and Momondo, limits ranges and queue size, restricts mutations and cross-origin writes, and keeps exports and diagnostics private, below the UI too.

## Development and tests

Never contact flight sites without an explicit owner decision: `FLYSCAN_OFFLINE=1` or `--offline` (dev scripts default to it). A source request then fails instead of going live.

```bash
npm test --prefix backend && npm run build --prefix backend
npm run test:transport && npm run test:packaging
npm test --prefix desktop && npm run build --prefix desktop
uv run pre-commit run --all-files
node backend/dist/index.cjs replay tests/recordings/ff-sky-ber-cdg   # no network
```

Golden files in `backend/tests/fixtures/` were exported from the old Python backend; source recordings are in `tests/recordings/`. Environment: `FLYSCAN_PYTHON` (worker interpreter), `FLYSCAN_DATA_DIR`, `FLYSCAN_FRONTEND`.

Packaging: Tauri starts the bundled Node with the backend; the frozen curl worker ships beside it. Users install neither runtime, and Playwright is left out because Tauri owns the check webviews. See [desktop/README.md](../desktop/README.md) and [packaging/README.md](../packaging/README.md). Verification: `npm run verify -- discover`, see [verification.md](verification.md).
