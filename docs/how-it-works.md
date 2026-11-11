# How flyscan works

Moved from the README.

## The sources

All six take plain IATA codes — an airport (`LHR`) or a city metacode that
covers all of a city's airports (`LON`, `BER`, `NYC`). That is why place lookup
is one shared step instead of six.

| Source | `--sources` name | How the search is expressed |
|---|---|---|
| [Kayak (FlightsFinder)](https://ie-kayak.flightsfinder.com) | `ff-kayak` | `POST /i/api/search/dynamic/flights/poll` |
| [Sky (FlightsFinder)](https://www.flightsfinder.com/portal/sky) | `ff-sky` | `POST /portal/sky/poll` |
| [Kiwi (FlightsFinder)](https://www.flightsfinder.com/portal/kiwi) | `ff-kiwi` | `POST /portal/kiwi/search` |
| [Momondo](https://www.momondo.ie) | `momondo` | same engine as `ff-kayak`, under `/flight-search/` |
| [Jetradar](https://jetradeu.cheapflightsfinder.com) | `jetradar` | Travelpayouts sign → start → poll |

### FlightsFinder — Kayak, and Momondo

Both run the Kayak engine, so one adapter drives both hosts. Fetch the search
page for a session cookie and the `formtoken` embedded in it, then POST the
search; the token goes in an `X-CSRF` header, without which the poll returns
401.

```jsonc
{
  "filterParams": {},
  "userSearchParams": {
    "legs": [{
      "origin":      {"airports": ["BER"], "locationType": "airports"},
      "destination": {"airports": ["LON"], "locationType": "airports"},
      "date": "2026-08-22",
      "flex": "exact",
      "cabinClass": "business"     // omit entirely for economy
    }],
    "passengers": ["ADT", "CHD"],   // one code per passenger
    "passengerDetails": [{"ptc": "ADT"}, {"ptc": "CHD"}],
    "sortMode": "price_a",
    "searchId": "uRGCN5jZ5R"        // from the first poll, on every poll after
  },
  "searchMetaData": {"pageNumber": 1, "searchTypes": [], "skipResultsInSecondPhase": false}
}
```

Cabin lives *inside each leg* as `cabinClass`, and needs **two different
spellings** — the URL path wants `premium`, the request body wants
`premium-economy`, and every other form of it (`premium`, `premiumeconomy`,
`premium_economy`, `premiumEconomy`, `p`) is a 400:

| cabin | URL path | body `cabinClass` |
|---|---|---|
| economy | *(omitted)* | *(omitted)* |
| premium economy | `premium` | `premium-economy` |
| business | `business` | `business` |
| first | `first` | `first` |

Sending a `cabin` key at the top level is a validation error, and economy is
expressed by leaving it out entirely.

Passengers are two things at once. In the URL, everyone who is not an adult
goes in one `children` segment — a lap infant is the literal `1L`, a child is
**an age**, infants first:

```
/2adults/children-1L-10             2 adults, 1 child, 1 lap infant
/2adults/children-1L-1L-10-10-10    2 adults, 3 children, 2 lap infants
/5adults/children-1L-1L-1L-1L-10-10 5 adults, 2 children, 4 lap infants
```

In the body they are a list of type codes — adults, then lap infants, then
children — where a lap infant is `INL` (not `INF`) and each child carries an age:

```jsonc
"passengers": ["ADT", "ADT", "INL", "CHD"],
"passengerDetails": [{"ptc": "ADT"}, {"ptc": "ADT"},
                     {"ptc": "INL"}, {"ptc": "CHD", "age": 10}]
```

**Real child ages are not modelled.** This engine demands a number per child, so
every child is sent as age 10, which sits inside every
airline's child fare band. Carrying true ages would change the price on this one
source while being invisible to the other four and to the stored schema — a
search keyed on them would look distinct while producing results nothing could
tell apart.

Polling to completion only ever re-reads the **first page**. The real count is
in `filteredCount`, and the rest is reached by walking
`searchMetaData.pageNumber` — without which these two sources return about a
quarter of what they found (50 results out of 194 on a typical search).

Paging costs requests, though, and a burst of them earns a 403 with
`BOT_CAPTCHA_REDIRECT`. That block is scoped to the **IP, not the session**, so
opening a fresh session does not clear it and retrying only prolongs it — the
adapter paces its paged requests and reports the block plainly instead. Each poll returns a page of results for the state
of the search at that moment rather than a superset of the last, so results are
accumulated across polls by `resultId`.

This engine reports `priceMode: "per-person"`: `displayPrice` is one
traveller's share and `fees.totalPrice` is what the party pays. Read the wrong
one and a three-passenger search looks a third the price of the other six
sources, all of which quote trip totals.

The two brands serve results under different paths — Kayak uses `/flights/`,
Momondo `/flight-search/` — and the search itself is the URL's path:

```
/flights/BER-LON/2026-08-22//1adults            one-way (note the empty segment)
/flights/BER-LON/2026-08-22/2026-09-05/1adults  round trip
/flights/BER-LON/2026-08-22//business/1adults   cabin as its own segment
```

This endpoint also sells coaches and trains. Those come back with an all-numeric
operator code and `---` where the flight number should be, and are dropped.

### FlightsFinder — Sky and Kiwi

The search page ships a jQuery block holding a CSRF token and a per-page-load
session id; the results come back from a POST to that block's endpoint as a
pipe-delimited string whose seventh field is rendered HTML. Rather than
hard-coding the body, the adapter lifts the whole `data: { … }` object out of
the page, so the unguessable session token travels with us and a new upstream
parameter is picked up for free.

Page parameters:

| | `ff-sky` | `ff-kiwi` |
|---|---|---|
| path | `/portal/sky` | `/portal/kiwi` |
| dates | `outbounddate=2026-08-22` | `outbounddate=22/08/2026` |
| cabin | `Economy` `PremiumEconomy` `Business` `First` | `M` `W` `C` `F` |
| trip | implied by `inbounddate` | `type=oneway` / `type=return` |
| shared | `originplace` `destinationplace` `adults` `children` `infants` `currency` | |

### Jetradar (Travelpayouts)

Three JSON calls. `POST /whitelabels/web/flights/v1/search/sign` returns a
signature for the exact payload you intend to run — computed server-side, so
there is no secret to reproduce. `POST /search/wl/start` replays that payload
plus the signature and returns a `search_id` and the regional host holding the
results. `POST /search/wl/results` on that host, with `{"search_id": …}`,
returns tickets. Both of the first two calls 401 without the
`affiliate-marker` and `x-whitelabel-version: v2` headers.

```jsonc
{
  "currency_code": "EUR", "market_code": "DE", "citizenship": "DE",
  "host": "jetradeu.cheapflightsfinder.com", "marker": "148729.Z…-148729",
  "search_params": {
    "directions": [{"origin": "BER", "destination": "LON", "date": "2026-08-22"}],
    "passengers": {"adults": 1, "children": 0, "infants": 0},
    "trip_class": "Y"                 // Y economy, W premium, C business, F first
  }
}
```

The storefront's own shareable link is a compact positional token:

```
/flights/BER2208LON100          one-way, 1 adult
/flights/BER2208LON0509100      returning 05 Sep
/flights/BER2208LONb100         business
/flights/BER2208LON0509b100     business, returning 05 Sep
/flights/BER2208LON0509210      2 adults + 1 child
/flights/BER2208LON0209232      2 adults + 3 children + 2 lap infants
```

`ORIGIN + DDMM + DESTINATION + [DDMM return] + [cabin] + adults + children +
infants`, parsed strictly by position. The cabin letter is **lowercase and
case-sensitive** — an uppercase one is silently ignored and the search falls
back to economy. Only two cabins survive this token: `b` (or `c`) gives
`trip_class=C`; everything else, `w` and `f` included, gives `Y`. First class
therefore links as business, the nearest cabin it can express — which affects
only the link, since the search posts `trip_class` straight to the API.

**Linking to one deal, not the whole search.** Adding a ticket id to the token
lands on that specific result:

```
/?flightSearch=BER0509LON100&ticketId=6c0d35f6bc67b1a4c6c27258101331cb
```

`ticketId` is the ticket's `id` (32 chars — not `hashsum`, which is 16), and
those ids are stable across searches, so this is safe to store. The page
re-runs the search with the ticket highlighted and says whether the fare moved.

The airline's own booking URL does exist, one call away:

```
GET https://{results_host}/searches/{search_id}/clicks/{proposal_id}
  -> {"url": "https://www.easyjet.com/deeplink?…", "expire_at_unix_sec": …}
```

It is deliberately **not** used. That URL expires about **15 minutes** after it
is minted — `results_ttl_ms` is `900000`, the same window — so it cannot be
stored in a database meant to be queried days later, and resolving one on demand
means running a whole fresh search before the browser can open. A stable link
that re-prices itself on arrival beats a direct link that is usually dead. One
scrape would also have to spend an extra request per offer to mint links that
expire before anyone clicks them.

## Cabins

All five honour the cabin, verified by sweeping every source against every
cabin on one route and comparing minimum prices — a source quietly serving
economy shows up as a flat row:

```
source       economy    prem econ  business   first
ff-kayak     194@€88    50@€258    50@€228    20@€7326
ff-sky       258@€89     9@€443   253@€238    none
ff-kiwi      300@€95   254@€321   500@€269    26@€5917
momondo      196@€88     50@€258    78@€230    25@€6780
jetradar     279@€83    110@€262   189@€233    none
```

Two things in that table are real rather than bugs. **Premium economy costs
more than business** on every source, because BER–LON is short-haul: business
is ordinary Eurobusiness, while almost nothing on the route sells a premium
economy cabin, so the filter only matches rare connecting itineraries on
long-haul equipment. And **first class mostly returns nothing**, for the same
reason — six independent sources agreeing is the tell that it is the market,
not the code.

The party goes under `counts[adults]`, `counts[children]`,
`counts[infants_lap]` and `counts[infants_seat]` — the API echoes all four back
in each result's `data` blob, which is how they were confirmed. The shareable
link takes the same names flat: `?adults=2&children=3&infants_lap=2`.

## Round trips

Every source sells a round trip as one product, so both legs are captured and
merged normally.

```
€132.00 BER-LGW out 06:35 ret 07:00   jetradar, ff-sky, ff-kayak, momondo, ff-kiwi
```

## Currency

**The database stores EUR, and only EUR.** Each offer also keeps the currency it
was actually quoted in and that original amount, so nothing is silently
rewritten — but the comparable column is always EUR. `FlightStore` ignores any
other base currency it is handed rather than relabelling rows: a column whose
meaning depends on when it was written is worse than no column.

Sorting, filtering and "cheapest" all use the EUR column, because comparing a
USD offer to a EUR one any other way is meaningless.

Display currency is a **view setting**. The UI has a "show prices in" selector
that converts everything on screen at today's rate — it never re-searches, never
re-scrapes, and never touches stored data. Switching EUR → USD → GBP → EUR
returns exactly the original figures.

Two sources ignore `--currency` and always quote their own: `ff-kayak` and
`momondo` follow their `.ie` host domain and quote EUR. `flyscan sources`
lists which is which. The other three honour it. Either way each offer records the currency it was actually
quoted in, so the conversion is right regardless.

Rates come from [open.er-api.com](https://open.er-api.com), falling back to
[Frankfurter](https://frankfurter.dev) — both free, no key — and are cached in
`.fx_cache.json` for a day. `--base-currency` on `query` and `scrape` is display-only in the
same way: it converts EUR for the printed table and the CSV, so the same data
reads in EUR, GBP or USD without rescraping.

## Storage

`flights.db` holds three tables, and nothing is said twice.

```
fetches   one row per (search, source) — what was asked of whom, and how it went
   ↑
offers    a price: one seller, one trip, one fetch
   ↓
trips     one row per distinct flight, keyed by trip_key
```

**There is no separate cache.** "Has this source answered this search recently"
and "what did it answer" are the same fact, so they are stored once. `fetches` is
both the log and the decision: `plan()` reads it and returns, per source, *fetch
it* or *skip it and why* — never asked, stale, retrying, retries exhausted, in
flight, stuck loading, or waiting on a human. Each of those states exists because
it went wrong at some point.

An earlier design kept a second database holding every offer as JSON against the
search that produced it. That was a copy of what was already here — 25 MB for
fifty searches, **47% of it booking URLs** — so it went, and a fetch now records
only that it happened.

**Every offer belongs to a fetch.** Source, party, cabin, requested currency and
timestamp all come from `fetch_id` rather than being repeated on every row, and a
fetch *owns* its offers: re-fetching deletes them and inserts the fresh set. What
is in `offers` is therefore always current, and there is no price history.

**Prices are EUR and only EUR**, converted when scraped. A column whose meaning
depends on whichever run wrote it cannot be sorted, and "cheapest across five
sellers" is the whole point.

**`trip_key`** is what makes the merge work: a hash of departure date, actual
airports, departure and arrival to the minute, and stop count. Deliberately *not*
flight numbers: sources disagree on the operating carrier — the same easyJet
service is `EC7336` to one and `U27336` to another — so keying on them would
split matches that are really the same seat.

The searched **return date** is part of the key too, whenever there is one. Not
for symmetry: a source that prices a round trip without fixing which flight comes
back yields a trip with no inbound at all, and without the return date its key is
identical to a plain one-way's. The two then merge, and a one-way fare ends up at
the top of a round-trip list being compared against round-trip prices. That is
not hypothetical — it happened, and it is why the component is here.

Re-running a search is idempotent. Trips are matched, not duplicated, and their
blank fields are filled in by whichever source knows more rather than overwritten.

Queries are indexed on `(origin, destination, depart_date, source)` for the
fetch lookup, on the same route triple for trips, and on price both globally and
per trip.

```bash
npm run flyscan -- query --origin BER --destination LON --start 2026-09-01 --max-stops 1
npm run flyscan -- query --summary --base-currency GBP
```

Schema changes after this layout go in `migrations` in `backend/src/schema.ts`, appended and
never edited once released. The database records how many it has taken
(`PRAGMA user_version`) and runs the rest when opened, each in one transaction, so
an installed app keeps its data, prices added by hand included, across updates. A
database written by a newer version is refused rather than misread.

Every file the app keeps (`flights.db`, `.challenges/`, the place and rate caches,
`.errors/`, `out/`) sits in the working directory. Set `FLYSCAN_DATA_DIR`
to give an environment its own folder; the desktop app runs its service in the
app's data folder for the same reason.

## Backend architecture

The application backend is TypeScript in `backend/src/`. Python is limited to
`flyscan/transport.py`, a private, long-lived `curl_cffi` worker.
The React client and backend share the `/v1` wire types in
`shared/contracts.ts`.

- `sources.ts` builds source requests and parses their responses.
- `scheduler.ts` owns scrape sharing, subscriptions, priorities, retries, per-source
  limits, cancellation and physical worker occupancy.
- `challenges.ts` owns challenge persistence, human clearance, cookie storage and
  queue resumption. Playwright is used only to display checks during browser development.
- `store.ts` owns SQLite reads and writes. `schema.ts` retains the released schema
  and append-only migrations, including stable trip and query identities.
- `searches.ts` owns search startup, progress, results, cancellation, completion
  and resumable event logs.
- `api.ts` serves `/v1`, the compiled frontend and local exports.
- `support.ts` provides currency conversion, place lookup and error logging.
- `capture.ts` records and trims exchanges. `ReplayTransport` strictly reads saved
  responses and never falls back to the network.
- `cli.ts` supplies the CLI and server entry points.

The transport protocol uses JSON lines on private stdin/stdout pipes. TypeScript
opens an opaque session, issues sequential requests within that session, and closes
it. Distinct sessions can request concurrently. Responses preserve body bytes as
base64, repeated headers, final URLs and cookie scope. Python has no knowledge of
sources, flights, retries, searches, challenges or SQLite.

A cancelled or timed-out request retains its physical worker and per-source slot
until it exits. Late results cannot write to the database. Cancelling a search
releases only its subscriptions; other searches sharing its scrapes continue.
A challenge pauses its source while unrelated sources remain available, and
human-earned clearance resumes the original waiting subscriptions.

## The API

`npm run flyscan -- serve` or `node backend/dist/index.cjs serve` serves `/v1` and the
built frontend. Installed desktop users need neither Node nor Python installed.

```text
POST   /v1/searches
GET    /v1/searches
GET    /v1/searches/{id}
GET    /v1/searches/{id}/events
GET    /v1/searches/{id}/results
DELETE /v1/searches/{id}
GET    /v1/flights
GET    /v1/trips
GET    /v1/sources
GET    /v1/jobs
POST   /v1/jobs
GET    /v1/jobs/{id}
POST   /v1/jobs/{id}/{cancel|promote|retry}
POST   /v1/jobs/cancel
POST   /v1/query-jobs/{id}/{cancel|retry}
POST   /v1/query-jobs/{id}/sources/{source}/{cancel|retry}
POST   /v1/queue/selection
POST   /v1/queue/actions/{cancel|retry}
POST   /v1/freshness
POST   /v1/manual-offers
PATCH  /v1/manual-offers/{id}
DELETE /v1/manual-offers/{id}
GET    /v1/challenges
POST   /v1/challenges/{source}/solve
POST   /v1/challenges/{source}/cookies
DELETE /v1/challenges/{source}
GET    /v1/places?q=berlin
GET    /v1/rates?base=EUR
GET    /v1/health
GET    /v1/version
GET    /v1/errors
POST   /v1/errors
DELETE /v1/errors
POST   /v1/maintenance/purge
```

Set `FLYSCAN_API_KEY` to require `Authorization: Bearer <key>` or `X-API-Key`.
Only the read-only SSE endpoint also accepts `api_key` in its URL, for native
EventSource clients. SSE resumes with `Last-Event-ID` or `after` and ends after
one terminal search event. The desktop shell supplies a fresh session credential.

Hosted mode (`FLYSCAN_MODE=web`) disables Kayak and Momondo, limits search ranges
and queue capacity, restricts mutations and cross-origin writes, and keeps server
exports and diagnostics private. The same restrictions apply below the UI.

## Offline development and tests

Flight sites must not be contacted while developing without an explicit owner
decision. Set `FLYSCAN_OFFLINE=1`, or pass `--offline` to the CLI. Both development
scripts default to offline mode. Offline mode supports stored-data reads and local
API work; attempting a source request fails instead of silently making a live call.

```bash
npm test --prefix backend
npm run build --prefix backend
npm run test:transport
npm run test:packaging
npm test --prefix desktop
npm run build --prefix desktop
uv run pre-commit run --all-files

# Replay captured responses; no browser or network is used.
node backend/dist/index.cjs replay tests/recordings/ff-sky-ber-cdg
```

Backend tests cover parser outputs and digests against recordings, captured timing
and codeshare metadata, a database written by the previous Python implementation,
search and challenge lifecycles, cancellation, shared work, queue restoration,
HTTP authentication, SSE replay, manual prices and hosted restrictions. Golden
reference files in `backend/tests/fixtures/` were exported from the Python backend
before removing it; the original source recordings remain in `tests/recordings/`.

The checkout CLI runs with `npm run flyscan -- <command>` after building the backend.
`FLYSCAN_PYTHON` selects the curl worker's interpreter when using the source checkout.
`FLYSCAN_DATA_DIR` selects an isolated data directory. Existing database and cache
paths remain compatible. `FLYSCAN_FRONTEND` selects the compiled frontend.

## Packaging

Tauri starts Node directly with the compiled TypeScript backend and frontend resources.
The backend owns a separate frozen curl worker, connected only through private pipes.
`flyscan/transport.py` is the only Python source file in the repository. Release tools,
version updates, smoke probes and tests run in Node/TypeScript. Users install neither
Node nor Python: both runtimes ship in the desktop bundle. Playwright is omitted from
installed desktop builds because Tauri owns the verification webviews.

See [desktop/README.md](../desktop/README.md) for development and
[packaging/README.md](../packaging/README.md) for builds. Releases still go through the
Release workflow only when requested by the owner.

## Verification

Run `npm run verify -- discover` for offline scenarios and source-bound evidence.
See [the verification guide](verification.md) for commands, controls and limits.
