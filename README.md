# flight-scraper

Searches five flight metasearch sources at once, merges the results so the same
flight from different sellers becomes one row, and converts every price into a
single currency so they can actually be compared.

The interesting output is not the cheapest flight — it is the **spread**: the
same Ryanair seat on the same day comes back €28 apart depending on who is
selling it.

```bash
flight-scraper scrape berlin london 2026-09-19
```

```
  BER  ->  LON

  Sources: ff-kayak, ff-sky, ff-kiwi, momondo, jetradar
  5 searches across 1 day(s)

    2026-09-19  ff-kiwi       314 offers in 4s
    2026-09-19  ff-kayak      225 offers in 12s
    2026-09-19  momondo       227 offers in 13s
    2026-09-19  jetradar      234 offers in 47s
    2026-09-19  ff-sky        251 offers in 57s
    2026-09-19  -> 1251 offers across 593 distinct flights in 57s

       price  route     depart               dur stp  airlines     best source  srcs   spread
  -------------------------------------------------------------------------------------------
      €41.00  BER-STN   2026-09-19T06:00  1h 50m   0  Ryanair      ff-sky          4       28
      €45.00  BER-STN   2026-09-19T16:40  1h 50m   0  Ryanair      ff-sky          4       33
      €65.00  BER-LHR   2026-09-19T07:00  2h 10m   0  Eurowings    ff-sky          5        6
```

## Install

```bash
pip install -e .
```

That puts a `flight-scraper` command on your PATH — but only while the
environment it was installed into is active. On Windows PowerShell:

```powershell
.\.venv\Scripts\Activate.ps1     # then: flight-scraper ...
```

Or skip activation and call it directly:

```powershell
.\.venv\Scriptslight-scraper.exe unblock ff-kayak
```

Every source answers over plain HTTP — no browser, no driver.

## Usage

```bash
# one date, every source
flight-scraper scrape berlin london 2026-08-22

# a range of departure dates
flight-scraper scrape BER LON 2026-09-01 2026-09-14

# round trip, two adults, business, prices shown in GBP
flight-scraper scrape berlin london 2026-09-01 --return 2026-09-08 \
    --adults 2 --cabin business --base-currency GBP

# a family
flight-scraper scrape BER LON 2026-09-12 --return 2026-09-19 \
    --adults 2 --children 3 --infants 2

# skip the slow ones
flight-scraper scrape BER LON +7 --sources ff-kiwi ff-kayak momondo

# ask every source again regardless of what was cached
flight-scraper scrape BER LON 2026-09-12 --cache-hours 0

flight-scraper query --origin BER --max-stops 1 --top 20   # read the store back
flight-scraper query --summary                             # per-source totals
flight-scraper places berlin                               # find an IATA code
flight-scraper sources                                     # list the sources
flight-scraper rates                                       # show FX rates in use
flight-scraper prune                                       # forget departed flights
flight-scraper cache                                       # what has been cached
flight-scraper cache --purge                               # drop stale entries
flight-scraper serve                                       # local web UI
```

The UI is a React + TypeScript app in `desktop/`, built once and served by
`flight-scraper serve` at <http://127.0.0.1:5000> — the same bundle the desktop
shell loads. There is deliberately no server-rendered UI: there used to be one
here *and* the desktop app, each with its own copy of the list, detail panel and
price formatting, and they drifted in ways that only surfaced at runtime.

It shows results **as each source lands** rather than when the slowest one finishes — on a three-source
search that is 374 flights at 4.6 s instead of a blank page until 46 s. Every
date in the range goes in one list sorted by price, because the cheapest way to
make a trip rarely respects date boundaries.

Both dates are **ranges, picked independently**. Departures 23–25 against
returns 24–25 is not one span that slides: it is five separate trips — every
departure day priced against every return day that is not before it — and each
is its own question to every source. The header says how many, because that
number is what widening either range actually costs. A one-way is the same
thing with no return range: one trip per departure day.

Rows carry only what you scan by — price, date, route, departure, duration,
stops, airlines, and how many sellers quoted it. Clicking one opens a detail
panel with the full segment-by-segment itinerary, layovers, and every seller's
price side by side. A row listing six prices is unreadable at a glance; one
listing the cheapest and the word "6 sellers" is not.

**Party, cabin and quote currency live under *Advanced* in the search form.**
They are folded away because most searches are one adult in economy, but they are
part of the search itself: sources only quote the party they were asked about, so
a price is only ever meaningful for a specific one. Changing any of them re-reads
the database for exactly that party — never a scrape — and if nothing has been
scraped for it yet the page says so rather than showing a one-adult price for a
family of four. The detail panel is read-only for the same reason: every price in
it is already for the travellers that were asked about.

Build it with `npm install --prefix desktop && npm run build --prefix desktop`;
without that, `/` explains how and the API still works. While the UI is changing,
`npm run dev --prefix desktop` gives the same app on port 1420 with live reload.
The desktop shell wraps the identical bundle — see `desktop/README.md`; only
clearing a source's security check needs it. The server exposes a versioned API
at `/v1` for any other frontend — see below.

## The sources

All six take plain IATA codes — an airport (`LHR`) or a city metacode that
covers all of a city's airports (`LON`, `BER`, `NYC`). That is why place lookup
is one shared step instead of six.

| Source | `--sources` name | How the search is expressed |
|---|---|---|
| [FlightsFinder (Kayak)](https://ie-kayak.flightsfinder.com) | `ff-kayak` | `POST /i/api/search/dynamic/flights/poll` |
| [FlightsFinder (Sky)](https://www.flightsfinder.com/portal/sky) | `ff-sky` | `POST /portal/sky/poll` |
| [FlightsFinder (Kiwi)](https://www.flightsfinder.com/portal/kiwi) | `ff-kiwi` | `POST /portal/kiwi/search` |
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
every child is sent as `DEFAULT_CHILD_AGE` (10), which sits inside every
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
`momondo` follow their `.ie` host domain and quote EUR. `flight-scraper sources`
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
flight-scraper query --origin BER --destination LON --start 2026-09-01 --max-stops 1
flight-scraper query --summary --base-currency GBP
```

This layout replaced a four-table one on 2026-08-23. There is no migration —
the contents are scraped data that re-fetches in under a minute, so an older
`flights.db` should simply be deleted.

## Layout

```
flight_scraper/
  models.py      SearchQuery, Itinerary, Offer — and trip_key, the merge key
  sources/
    base.py          what a source must provide
    kayak.py         ff-kayak + momondo (one engine, two hosts)
    flightsfinder.py ff-sky + ff-kiwi (one front-end, two portals)
    travelpayouts.py jetradar
  task_queue.py  generic handlers, priorities, retries, deadlines, resource limits, actions
  scheduler.py   scraping adapter; cached results, deduplication, challenge records
  challenge.py   challenge lifecycle; browser/cookie adapters and live reconciliation
  aggregate.py   fans a search across every (source, date) and merges by trip_key
  cache.py       replays a source's answer to an identical recent search
  jobs.py        atomic search start/join, cancellation, completion, and replay
  searches.py    search execution, result presentation, and export adapter
  api.py         the /v1 HTTP surface
  store.py       the normalized SQLite schema above
  fx.py          rate fetching, caching, conversion
  places.py      free text -> IATA
  cli.py, web.py   command/request adapters; web.py serves the app and HTTP interface
                   and the built frontend, and renders nothing itself
desktop/
  src/
    api.ts        typed /v1 client — the part worth keeping if the UI is rebuilt
    platform.ts   the three calls that need the desktop shell, and browser fallbacks
    currency.tsx  display currency and the formatting that depends on it
    useFlights.ts the engine: loadStored reads the DB, runSearch is the only scrape
    App.tsx       header of search controls, source panel, results list
    Details.tsx   itinerary detail and every seller, in the side panel
  src-tauri/      spawns the sidecar on a free port; open_challenge, open_external
```

Adding a source means writing a `Source` subclass and listing it in
`sources/__init__.py`; the CLI and the API both read that registry.

## The API

`flight-scraper serve` exposes `/v1` alongside the built frontend, so another
frontend can drive it.

```
POST   /v1/searches               → {search_id, status}   202, or 200 if it joined one
GET    /v1/searches/{id}          → status snapshot
GET    /v1/searches/{id}/events   → SSE, resumable
GET    /v1/searches/{id}/results  → merged rows, usable mid-run
DELETE /v1/searches/{id}          → cancel
GET    /v1/flights?origin=&…      → what is already stored; never scrapes
GET    /v1/searches               GET /v1/sources    GET /v1/health
GET    /v1/places?q=              GET /v1/rates
```

**Reading is separate from scraping, on purpose.** `GET /v1/flights` answers
only from the database — same row shape as a live search, so the table and the
detail panel cannot tell where a row came from. That split is what lets a UI
fill in the instant a form changes while keeping "go and ask five sources" a
deliberate act. It takes the same filters plus the party, matched exactly so a
family fare is never folded into a one-adult comparison, and reports `last_seen`
so the page can say how old what it is showing is.

```js
const { search_id } = await (await fetch("/v1/searches", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ origin: "BER", destination: "LON", start: "2026-09-12" }),
})).json();

const events = new EventSource(`/v1/searches/${search_id}/events`);
events.onmessage = (e) => render(JSON.parse(e.data));
```

Three things make it usable by something other than a tab you control.

**Streams are replayable.** Events carry a sequence number, so a client that
drops its connection reconnects with `Last-Event-ID` and is caught up from
exactly where it stopped — no gap, no repeat. Two clients can watch one search
and see the identical sequence. The first version kept progress in a
`queue.Queue`, which hands each event to whoever reads first: a second listener
saw half the run, and a dropped connection lost the rest.

**Creation is idempotent.** Posting a search that is already running returns
that search's id with `joined: true` rather than scraping it twice. The sources
are the scarce resource, not the server, so the API's job is to absorb repeated
demand — the cache covers searches that already finished, this covers the one
still in flight. Pass `force: true` to override.

**There is a snapshot as well as a stream.** `GET /v1/searches/{id}` and
`/results` answer the same questions by polling, for clients that cannot hold an
SSE connection. `/results` works mid-run, filtered by `?day=`, `?max_stops=`,
`?limit=`.

Set `FLIGHT_SCRAPER_API_KEY` to require `Authorization: Bearer <key>` or
`X-API-Key`; unset means open, which is fine on localhost and not elsewhere —
an unauthenticated caller spends *your* IP's standing with the sources. CORS is
permissive by default.

### Search lifecycle ownership

`JobRegistry.start()` atomically joins or creates a search and starts its
protected runner. `Job` owns cancellation, aggregator attachment, and terminal
completion; HTTP request handlers do not reach into a running aggregator.
Cancellation during startup is remembered and prevents later scraping.
`searches.py` supplies search execution and export behavior through that lifecycle.
Startup, scraping, and export exceptions all emit an error, mark the search
failed, and close its replay stream with one final event. Collected results
remain inspectable after an export failure.

Event IDs increase independently of retained history. Keeping only the last
5,000 events does not reuse IDs, so reconnect cursors continue to advance.
Search snapshots return copies; queue observations are frozen. Domain terms
are defined in [GLOSSARY.md](GLOSSARY.md).

## Parallelism and rate limits

The unit of work is one **(source, date)** pair, not one date. Six sources over
fourteen days is 84 independent jobs, all submitted up front — a fast source is
never left idle waiting for a slow one on an earlier date.

What keeps that from becoming a stampede is a gate per source rather than one
global worker count — and crucially those gates live in **one process-wide
scheduler**, not in each search. When each search owned its own, two running at
once meant two independent limits and twice the agreed traffic, which is how the
Kayak engine came to answer with a bot block. Each source declares what it
tolerates:

```python
max_concurrency = 2  # searches of this source in flight at once
min_interval = 0.5  # seconds between starting them
```

The Kayak engine sets `1` and `2.5`, because it is the strictest: one search
there already costs a page fetch, a poll per phase and a request per result
page, and overlapping two of them earns an IP-scoped bot block. `--workers`
caps the total in flight across all sources (default 12) so a long date range
does not open a hundred sockets at once.

Days are still handed back oldest-first, so output stays readable even though
everything ran at once — a date that finishes early waits its turn rather than
holding anything up.

The scheduler also collapses **in-flight duplicates**: two searches wanting the
same source and date at the same moment share one scrape, and each gets its own
copy of the result.

Choose the process ledger and worker count when starting the server:
`flight-scraper serve --db path/to/flights.db --workers 12`. Searches inherit
these settings; conflicting database or worker settings are rejected rather
than silently ignored. Results are read through the same scheduler that writes
them. `cache_hours` remains a per-search policy, so a short freshness window
does not inherit an earlier caller's window. Refresh and freshness settings
also distinguish search subscriptions when duplicate requests are joined.

An aggregator owns its subscriptions until its iterator finishes or closes.
Admission errors, cancellation, and `Aggregator.close()` release those
subscriptions, including work submitted before an error. Other subscribers
keep shared scrapes alive. Close an abandoned iterator explicitly or use the
aggregator as a context manager.

Progress events identify the source, outbound and return dates, scrape ID,
and attempt. The frontend derives counts from logical scrapes: retries and
human waits release the running count, and shared completions settle it once.

### The queue

`task_queue.py` owns execution policy; `Scheduler` adds scraping, cached results,
and source challenge records. Existing searches use it automatically. Push a
single scrape from Python with:

```python
from datetime import date
from flight_scraper.models import SearchQuery
from flight_scraper.scheduler import default_scheduler
from flight_scraper.sources import REGISTRY

future = default_scheduler().submit(
    REGISTRY["ff-sky"](),
    SearchQuery("BER", "CDG", date(2026, 12, 21)),
    owner="my-search",
)
# Submission returns immediately. Read the result in background code:
result = future.result()
```

Or post a single job without creating a date-range search:

```http
POST /v1/jobs
Content-Type: application/json

{"source":"ff-sky","origin":"BER","destination":"CDG","depart":"2026-12-21"}
```

This returns HTTP 202 with `id` and a status URL. Identical live scrapes share
one job, including across different callers. A cached answer returns HTTP 200
with `id: null`, `cached: true`, and its stored count. `ret`, passenger counts,
`cabin`, `currency`, and boolean `refresh` are optional. Codes must be three-letter
IATA/currency codes. The usual API-key authentication applies.

```text
GET  /v1/jobs                  source tasks plus independent query_jobs groups
GET  /v1/jobs/{id}             one job, attempts, retry delay and requested action
POST /v1/jobs/{id}/cancel      cancel waiting or running source work
POST /v1/jobs/{id}/promote     raise its priority
POST /v1/jobs/{id}/retry       submit a terminal job again, ignoring cached results
POST /v1/jobs/cancel           cancel queued, delayed and human-waiting work
```

The sidebar shows **query jobs**: one exact origin, destination, departure,
return (if any), passenger mix, cabin and quote currency, with the latest task
for each requested source underneath. Date ranges expand into one query job per
valid departure/return combination. Cached source answers appear in the same
group. Changing the main filters or opening a flight never hides these groups.
The queue retains every live group and the last 100 completed groups in memory;
queue history does not survive a server restart.

```text
POST /v1/queue/selection                        selected search filters, or JSON null
POST /v1/queue/actions/cancel                   cancel unfinished sources in supplied filters
POST /v1/queue/actions/retry                    retry unsuccessful sources in supplied filters
POST /v1/query-jobs/{query_id}/cancel            cancel all unfinished sources
POST /v1/query-jobs/{query_id}/retry             retry failed/cancelled/timed-out sources
POST /v1/query-jobs/{query_id}/sources/{source}/cancel
POST /v1/query-jobs/{query_id}/sources/{source}/retry
```

Group retry preserves successful/cached sources and leaves live work alone.
The header summarizes every queued query matching the selected route, date
ranges, passenger mix, cabin and quote currency. Its retry/cancel actions cover
that entire selection across search subscriptions. They use the filters sent
with the action, independently of another tab's foreground selection. The
sidebar and header share one queue subscription; the sidebar still lists all
queries. Fetch/refresh in the header covers every trip in the selected range.
Individual retry can also explicitly refresh a successful source. Blocked sources
wait for verification; retry never clears a challenge or bypasses a cooldown.
Group actions return `cancelled`, `retried`, `skipped`, and per-source `errors`.
A cancelled or timed-out request still winding down cannot be manually retried
until it releases its physical worker and source slot.

`queue_state` retains the exact queue state; the additive `status` field exposes
`waiting`, `running`, `retrying`, `rate_limited`, `waiting_input`, `completed`,
`cached`, `failed`, `timed_out`, `cancelled`, `cancelling`, and `stopping`.
`ready_in` and `wait_reason` explain scheduling delays; `action` describes human
input. The legacy `jobs` list and its abbreviated `state` remain available.

Execution rules:

- Per-source concurrency and minimum start intervals are checked before a worker
  is allocated. Every retry passes through the same limits. Priorities remain
  steerable with `focus(owner)` for headless callers. Once a UI sets
  `/v1/queue/selection`, its selected filters own foreground priority for both
  existing and future tasks. Every matching query in a selected date range has
  that priority. Other tasks continue when capacity permits. Equal priorities
  start in submission order; running work is never interrupted by selection.
- Only explicit transient failures, connection failures, and timeouts retry.
  Backoff grows exponentially with jitter and a cap. Parse/input errors and
  unexpected programming errors fail immediately. `Source.retries` is the total
  failure-attempt budget (default two), including the first attempt.
- HTTP 429 pauses the whole source for `Retry-After` seconds, or its HTTP-date
  equivalent. Missing/invalid values use 60 seconds. HTTP 503 with `Retry-After`
  uses the same rule; other server errors are transient failures. Cooldowns
  apply to sibling jobs even if the rate-limited job exhausted its attempts.
- Each source attempt has a 180-second wall-clock deadline (`Source.job_timeout`).
  Each HTTP call is capped by the remaining attempt time and `Source.timeout`.
  Queue delays do not consume this budget. Poll pauses support cancellation.
- A timeout settles the future promptly. Python threads cannot forcibly stop an
  arbitrary handler: a handler that ignores its context retains its worker and
  source slot until it exits, and is never retried concurrently. Cooperative
  request timeouts can retry after the previous attempt exits. New handlers
  must use `context.check()`, `context.remaining()`, or `context.sleep()` around
  blocking operations, and check before writing external results.
- CAPTCHA requests pause that source without retaining workers. Clearing the
  challenge through the existing solve/cookie/DELETE endpoints resumes the
  original futures and sibling jobs automatically. Human waits expire after
  15 minutes by default (`Scheduler(action_timeout=...)`). Repeated action
  requests have a separate budget of three resolutions per job.
- The queue accepts at most 10,000 unfinished jobs by default. Python callers get
  `QueueFull`; direct HTTP enqueue returns 429 with `Retry-After: 5`.
  Shutdown rejects submissions and settles unfinished futures as cancelled.
  Search cancellation detaches its subscriptions; another caller sharing the
  scrape still receives the answer. Running scraping work may finish and cache.

The queue is **process-local and in memory**. Restarting loses queued payloads
and job IDs; results and source challenge records remain in SQLite. Limits are
shared within one process, so run one scheduler process per scraping IP. Durable
or multi-process delivery would require a persistent queue/worker adapter.

### Adding another kind of background work

Register a handler on the existing shared queue. This also supports future route
calculation jobs without importing scraping types into the queue module:

```python
from flight_scraper.scheduler import default_scheduler
from flight_scraper.task_queue import ResourceLimit, RetryPolicy

queue = default_scheduler().queue


def calculate_route(payload, context):
    context.check()
    # Replace with the route algorithm; check context inside long loops.
    return {"airports": payload["airports"], "legs": len(payload["airports"]) - 1}


queue.register("route", calculate_route)  # once, during application setup
queue.limit("route-cpu", ResourceLimit(concurrency=2))
job = queue.submit(
    "route",
    {"airports": ["BER", "CDG", "MAD"]},
    resource="route-cpu",
    timeout=30,
    retry=RetryPolicy(max_attempts=1),
)
answer = job.future.result()
```

`TaskQueue` can also be used as a standalone context manager. Handlers return a
value or raise `RetryableError`, `PermanentError`, `RateLimited(retry_after)`, or
`ActionRequired(kind, message, url)`. Resources group jobs that share a limit or
human action. Call `queue.resolve_action(resource)` after the requested action
is completed; it resumes every waiting job for that resource. Observe actions
and retries with `TaskQueue(on_event=callback)`, whose callback receives
`(event, snapshot)` for `action_required`, `retry`, and `finished`. Each frozen
snapshot captures that transition, so retaining it does not observe later
attempts. Callbacks run outside the queue lock and should return quickly.
`submit()` returns a read-only handle with `id` and a standard result future;
only the queue can complete that future. Inspect `handle.describe()`,
`queue.get(id)`, or `queue.tasks()` for consistent observations without mutable
execution context or payload access. The `/v1/jobs` endpoints describe scrapes.
Handlers restart from their beginning after retry/action resolution and must
make their external side effects idempotent. Thread workers suit I/O work;
heavy CPU algorithms should use a process worker behind the handler.

## When a source asks for a human

The Kayak engine answers a flagged request with a 403 whose body names a real
challenge page — a Continue button in front of reCAPTCHA Enterprise:

```json
{ "errors": [{ "code": "BOT_CAPTCHA_REDIRECT" }],
  "captchaRedirectUrl": "https://ie-kayak.flightsfinder.com/security/check?out=…&t=…" }
```

That URL is worth reading rather than treating the 403 as a dead end. (The
*search page* path redirects somewhere else — a static "you look like a bot"
explainer with nothing to solve. Only the API body carries the real one.)

So the run stops asking and hands you the link:

```
  ff-kayak wants a human to confirm you are one:
    https://ie-kayak.flightsfinder.com/security/check?out=%2Fflights%2FBER-LON%2F2026-10-02&t=UFYe…
    open it, or run:  flight-scraper unblock ff-kayak
```

```bash
flight-scraper unblock ff-kayak      # opens it in a visible browser and waits for you
flight-scraper unblock --status      # which sources have been cleared, and how long ago
flight-scraper unblock ff-kayak --forget    # discard a stored clearance
```

`unblock` works standalone. Pending challenges are stored in the selected
SQLite database; clearance cookies and browser profiles live in `.challenges/`.
Use `flight-scraper unblock ff-kayak --db path/to/flights.db` to clear a custom
database. CLI and browser recovery share `ChallengeCoordinator`, including
probing for a current challenge URL and falling back to the recorded URL only
when probing fails. An unsuccessful probe with no recorded URL leaves the
challenge pending.

A running scheduler reconciles that database every 0.2 seconds. Clearing a
challenge from a separate CLI process resumes its original waiting futures;
it does not require a server restart or another search. Clearance-cookie files
are written atomically and reread when a source opens a session, so a running
process uses cookies saved by another process. A cookie-write failure leaves
work paused instead of reporting a clearance that was not saved.

**The scheduler keeps challenged sources paused until clearance is reported.**
Solving locally, posting clearance cookies, or deleting the challenge resumes
waiting work automatically. If an IP block has lifted on its own, use the
existing solve/probe flow or explicitly clear the challenge before asking again.
Challenge records survive shutdown and expired human waits.

Shutdown closes admission to challenge recovery and signals active browsers
to stop. Late probe or browser answers cannot clear the closed coordinator's
ledger or resume its queue. `Scheduler.shutdown(wait=True)` drains recovery
operations as well as scraping workers. Browser cancellation takes effect at
the next check after a blocking browser operation returns.

`unblock` opens the page in a **headed** browser with a profile kept on disk,
waits for you to finish, then stores whatever cookies the site handed back —
`Source.session()` sends them from then on. It does not solve, answer or work
around the challenge; if nobody is there, nothing happens.

Two things make this more than cosmetic:

**It stops the run knocking.** A challenge pauses the source and all its waiting
jobs. They retain their original futures, consume no worker threads, and resume
only after clearance. Requests already in flight may finish; no new request for
that source starts while it is held.

**Other sources carry on.** Only the challenged source stops.

Frontends get it too — a `challenge_required` event on the stream, plus
`GET /v1/challenges` and `DELETE /v1/challenges/{source}`.

**And when the server is on your own machine, the web UI can clear it.**
`POST /v1/challenges/{source}/solve` opens the check in a browser *this process*
owns; you solve it on screen, and the cookies land where the scraper can use
them — which a check cleared in your own Chrome does not, since those cookies
stay in Chrome. It returns immediately and the UI watches `/challenges` for the
source to disappear, because solving takes as long as a person takes.

`GET /challenges` reports `can_solve_here`, which is false when the process has
no browser to open — as in the packaged sidecar, which excludes Playwright
deliberately because the desktop shell uses its own webview instead.

## When something goes wrong

Failures are written to `.errors/errors.jsonl`, one JSON object per line, and
read back with:

```bash
flight-scraper errors                  # what has been failing, and the last few
flight-scraper errors --where source.ff-kayak --json
flight-scraper errors --clear
```

The message is never the useful part. "poll returned HTTP 404" is the same
sentence whether the route was wrong, the session expired, or the site is
blocking us — so every entry carries the **context it happened in**: the route,
the dates, the party, the URL that answered, how many attempts it took. A source
failure also carries the `flight-scraper capture` line that would record it, so
the next step after reading one is a fixture rather than another guess.

`GET /v1/errors` serves the same thing to a frontend, and the page posts its own
failures to `POST /v1/errors` — an unhandled error, a rejected promise, a search
that would not start. In the desktop shell there is no console to open, so an
error that only reached one may as well not have happened.

Entries are capped at 500 so the file can be read whole, and recording never
raises: a failure to record a failure must not become the failure being
reported.

## Tests, and the bytes behind them

```bash
python -m unittest discover -s tests -t .
```

Most of what breaks here is not our code changing but a site changing under it,
and the evidence for that is an error string and a count that dropped — the
bytes that caused it are long gone. So the parsers are tested against recorded
searches:

```bash
flight-scraper capture ff-sky BER CDG 2026-09-28 --out tests/recordings/ff-sky-ber-cdg --trim
```

That runs one real search and writes down every exchange it makes — method,
URL, request headers and body, status, response headers, and each body to its
own file. `--trim` then cuts the result payloads to a few cards, because a full
ff-sky capture is 32 MB of near-identical polls and three cards exercise every
branch of the parser. Cards and their modals are joined by position, so the
`myModalN` ids are renumbered to keep that promise once the ones in between are
dropped.

Replay never touches the network. A URL the recording does not hold, a poll
asked more times than was recorded, or a body that was truncated is an error —
a suite that quietly reaches the internet when a recording is incomplete passes
on a good day and fails in CI for reasons nobody can reproduce.

Beside each recording is what it should parse to: the offer count **and** a
digest of the parsed values — prices, agents, and every segment's carrier,
flight number, airports and times. The count alone is exactly what fails to
notice markup that still parses but comes back with empty flight numbers, which
is how 547 stored easyJet segments lost theirs.

A search that *fails* is recorded too, and kept. A 404 from a poll or a page of
markup that no longer parses is the case this exists for; the recording is what
lets the parser be worked on afterwards without waiting for the site to be in
the same mood again.

## Caching

**The `fetches` table is the cache.** It records *that* a source answered a given
search, and when. A hit means exactly one thing: do not ask that source again
yet. Nothing comes back from it — the offers are in the same database, written
when that source first answered, so whoever needs them reads them there.

```
run 1  5 sources, cold      47s
run 2  same search, 4 skipped   1s   — identical output, read back from the store
```

There used to be a second database holding every offer as JSON as well. That was
a copy of what `flights.db` already had: 25 MB for fifty searches, **47% of it
booking URLs**, some 1.6 KB apiece. Deleting it lost nothing.

`query_key` covers everything that changes an answer: source, route, dates,
cabin, currency and the passenger counts. Change any one and it is a different
search. `--cache-hours` sets the window (default 6, `0` disables).

A source that exhausts its queue attempt budget is recorded as `failed`. The
ledger also bounds repeated failed searches (`max_retries`, default three).
A human challenge is recorded as `challenge` and paused until explicitly
cleared; it never triggers unattended retries.

The decision is **per source**, not per search, so a search with four fresh
sources and one stale one asks only the stale one:

```
ff-kayak   cache      234  1.1h old
ff-kiwi    scrape     272  FETCHED in 3.0s
ff-sky     cache      245  1.1h old
jetradar   cache      364  1.1h old
momondo    cache      235  1.1h old
```

**No database means no cache.** `--db ''` skips storage, and with nowhere to read
a skipped source back from, skipping it would silently drop it from the output —
so in that mode every source is asked.

Only successes are cached — a source that failed gets asked again rather than
having its failure remembered. An empty result *is* a success: the source really
did find nothing, and asking again within the window will not change that.

**Searching again is refreshing.** There is no separate refresh button because
there does not need to be one: a repeat search replays whatever is still fresh
instantly and only re-asks the sources that have gone stale. Every result says
where it came from — `scrape`, `cache` (with its age) or `shared` — so the UI
can show *some prices up to 4.2 h old* rather than implying everything on screen
is live. `POST /v1/freshness` reports the same per source and per date, and
`refresh: true` on a search forces every source to be asked again.

## Forgetting

Nothing about a departed flight can become useful again, and the database
otherwise only grows.

```bash
flight-scraper prune                      # drop everything before today
flight-scraper prune --before 2026-09-01
```

That drops fetches for departed dates; their offers go with them through the
foreign key, and trips left without any offer are swept after.
`POST /v1/maintenance/purge` does the same over HTTP.
