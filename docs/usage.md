# Using flyscan

Moved from the README.

## Install

```bash
uv sync                          # curl_cffi transport dependencies
npm ci --prefix backend
npm run build --prefix backend    # Node.js 22.13+ required
npm run flyscan -- --help
./dev.sh                         # the app with live reload: http://localhost:1420
```

Every source answers over plain HTTP; no browser, no driver. A browser is only
opened for a person to clear a source's security check (see below). How the app
runs on a laptop, on a remote dev server, and as the installed desktop app
is in [`desktop/README.md`](../desktop/README.md#running-it).

## Usage

```bash
# one date, every source
npm run flyscan -- scrape berlin london 2026-08-22

# a range of departure dates
npm run flyscan -- scrape BER LON 2026-09-01 2026-09-14

# round trip, two adults, business, prices shown in GBP
npm run flyscan -- scrape berlin london 2026-09-01 --return 2026-09-08 \
    --adults 2 --cabin business --base-currency GBP

# a family
npm run flyscan -- scrape BER LON 2026-09-12 --return 2026-09-19 \
    --adults 2 --children 3 --infants 2

# skip the slow ones
npm run flyscan -- scrape BER LON +7 --sources ff-kiwi ff-kayak momondo

# ask every source again regardless of what was cached
npm run flyscan -- scrape BER LON 2026-09-12 --cache-hours 0

npm run flyscan -- query --origin BER --max-stops 1 --top 20   # read the store back
npm run flyscan -- query --summary                             # per-source totals
npm run flyscan -- places berlin                               # find an IATA code
npm run flyscan -- sources                                     # list the sources
npm run flyscan -- rates                                       # show FX rates in use
npm run flyscan -- prune                                       # forget departed flights
npm run flyscan -- cache                                       # what has been cached
npm run flyscan -- cache --purge                               # drop stale entries
npm run flyscan -- serve                                       # local web UI
```

The UI is a React + TypeScript app in `desktop/`, built once and served by
`npm run flyscan -- serve` at <http://127.0.0.1:5000> — the same bundle the desktop
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

`flyscan serve` serves the built bundle (`npm run build --prefix desktop`;
without it, `/` explains how and the API still works). While developing, `./dev.sh`
runs the same app with live reload. The desktop app wraps the identical bundle;
see `desktop/README.md`. The server exposes a versioned API at `/v1` for any other
frontend; see below.

## The price spread

The interesting output is not the cheapest flight — it is the **spread**: the
same Ryanair seat on the same day comes back €28 apart depending on who is
selling it. The CLI shows it directly:

```bash
npm run flyscan -- scrape berlin london 2026-09-19
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
