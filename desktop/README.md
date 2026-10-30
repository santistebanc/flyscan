# Desktop shell

TypeScript UI, Python scrapers, Tauri in between.

The scraping stays in Python for one concrete reason: `curl_cffi`'s TLS
impersonation is what makes the sources answer a plain HTTP request at all — a
real browser gets a captcha where it gets a 200. Node has no equally good
equivalent, so the shell spawns the packaged Python binary and talks to its
`/v1` API on localhost. Nothing about the scrapers changes.

## Why a desktop app, and not a web page

A source's security check grants **cookies**, and those cookies are what unblock
the scraper — verified: a session without them is still 403 even right after
someone solved the challenge. A user clearing it in their own browser keeps the
cookies there, where a server cannot reach them.

Here the challenge opens in a window this app owns:

```
challenge_required  →  open_challenge(url)      Rust: a WebviewWindow
                    →  you solve it in the app
                    →  window.cookies()         Rust: reads the jar
                    →  POST /v1/challenges/{source}/cookies
```

The captcha is never solved, answered or worked around by this code. It is put
in front of the person sitting at the machine, and it waits.

That also lets the sidecar drop Playwright — about 150 MB and a separate
`playwright install` step — because the webview already here does the job.

## Layout

```
src/api.ts        typed client for /v1  ← survives any UI rewrite
src/platform.ts   the three calls that need the shell, and their browser fallbacks
src/currency.tsx  display currency + formatting (React context)
src/useFlights.ts the engine: loadStored reads the DB, runSearch is the only scrape
src/App.tsx       search bar, results list, side panel with Flight and Queue tabs
src/Details.tsx   booking options and itinerary of the selected flight
src/styles.css    Ledger, refined: dark blue slate, Geist, tabular figures
src-tauri/        spawns the sidecar on a free port; open_challenge, open_external
```

React + TypeScript, built with Vite. This is the **only** frontend: the same
bundle is loaded by the desktop shell, served by `flight-scraper serve`, and run
with live reload during development. There used to be a second, server-rendered
UI in the Python package; keeping two in step failed often enough that deleting
one was the fix.

The window is a frame, not a page: one search bar across a fixed header — From,
To, Depart, Return, Travellers and Fetch, each segment opening its own popover —
the results down the left, and a fixed side panel on the right with two tabs,
the flight you have picked and the search queue. The results *are* the page and
scroll the window; the header and the panel are pinned out of that flow, which
is why the header remeasures itself into `--header-h` when it wraps. At
900px and narrower the panel is never above the list: it is a sheet along the
bottom, folded to its tabs until a flight is picked or a security check needs
someone. On a phone, upright or on its side, the header scrolls away too. Rows carry
only what you scan by — price, dates, and per direction the times either side
of the bars, connections, duration and stops — and the Flight tab carries
booking first, then the full itinerary, for whichever row is selected, by click
or with ↑ and ↓. Escape puts the flight down and returns to the queue. The
"Ledger, refined" design keeps dark blue-slate surfaces and blue accents. Geist
and Geist Mono are bundled in `src/assets/fonts`; their OFL licenses ship in
`public/licenses`.

All money crossing `/v1` is EUR — numbers, never formatted strings, and the
database stores EUR only — so the "show prices in" selector is a re-render rather
than another scrape. It is
persisted in `localStorage` and never reaches the database.

Party, cabin and quote currency sit under **Travellers** in the search bar,
which summarises them when closed. Changing any search parameter re-reads the database for
exactly that party — never a scrape. Quote currency is the one exception to the
re-read: it changes what the sources are asked to quote, but stored prices are
EUR only, so re-querying on it could not return anything different.

The search form is remembered under `flight-scraper:form`, so a reload lands back
where you left off. A departure date that has already passed is
**pushed forward** rather than restored or discarded — coming back next week
should not re-run a search for last Tuesday, which can only come back empty, but
the trip is still the trip. The length is preserved, so a saved seven-night trip
returns as a seven-night trip from the default date, and a one-way stays one-way.

## Running it

There are three ways, one per need.

**Developing on a laptop: `./dev.sh`** from the repository root, then open
http://localhost:1420. The service restarts itself on Python edits and the UI
hot-reloads; Vite forwards `/v1` to the service on :5111. A security check
opens in a Chromium window on the laptop (Playwright is a dev dependency): the
service owns that browser, so the cookies it earns land where the scraper uses
them. Dev data lives in `./data`.

**Developing from a phone: `beelink/dev.sh`**, run on the Beelink from the
checkout being edited (T3 Code's worktree, say), then open
http://beelink-home:1420 on the tailnet. It is the same loop as a set of user
services, pointed at that checkout until it is run from another one. A check
opens in a real Chromium on a phone-shaped virtual screen, which noVNC streams
on :6080. The check opens as soon as a source asks, since starting a browser on
the shared Beelink takes a while, and Verify, or Open stream once it is open,
shows the stream in a new tab. `beelink/dev.sh stop` and `status` do what
they say. Its data lives in `~/.local/share/flight-scraper-dev`.

**Using it: the installed desktop app**, built and published by the Release
workflow (see [`../packaging/README.md`](../packaging/README.md)) and updated
in place from then on. It runs its own service, keeps its data under local app
data, and opens a check in a webview it owns, handing the cookies back to the
service.

`npm run tauri dev` is only for work on the shell itself: the check window, the
updater, the sidecar lifecycle. Build the sidecar first, then:

```bash
cd desktop
cp ../packaging/dist/flight-scraper-sidecar.exe    src-tauri/binaries/flight-scraper-sidecar-$(rustc -vV | sed -n 's/host: //p').exe
npm run tauri dev
```

The suffix is not optional: Tauri resolves `externalBin` by target triple and
the build fails without an exact match. `FLIGHT_SCRAPER_SIDECAR` overrides the
path. A Rust edit costs a full stop-rebuild-restart, because the running app
holds the sidecar binary the build has to replace.

`src/platform.ts` resolves the shell-only calls at runtime:

| | desktop | browser |
|---|---|---|
| `apiBase` | the port the shell reserved | `?api=…`, else the page's own origin |
| `openExternal` | `open_external` command | `window.open` |
| `openChallenge` | webview + cookie read-back | not used: the service opens the check itself |

## Notes

- Flight rows span whole days from 05:00 to 05:00, advancing by elapsed travel
  time: from the last 05:00 at or before departure on the departure clock to
  the first 05:00 at or after arrival on the destination clock, and at least
  one day. BER 06:00 → LGW 07:05 reads 05:00–05:00 +1; a 03:00 departure starts
  at 05:00 the day before. Compare bar
  lengths within the same range. Other results cannot stretch that row's scale.
  Scale > Shared instead aligns all filtered results per direction,
  from the earliest departure to the latest elapsed-time arrival, using the same
  05:00 boundaries on the departure clock. The display
  choice is remembered separately from result filters.
  The plot carries no clock labels: departure and arrival times flank the bars,
  with `+1` when the local arrival date is later, and a faint line marks each
  local midnight, labelled to its right with the date that begins, in a strip above the bars. Midnights follow
  airport-local clocks, interpolated between each segment's timestamps across
  timezone changes; empty range space continues the departure clock before
  takeoff and the destination clock after landing. Connection codes and
  durations sit centred under the bars, airport changes in amber, overnight
  waits with a moon. A leg without segment times draws one dashed interval and
  says "Schedule not detailed", except for nonstop flights. Duration and stops
  sit at the right; nonstop legs show no stops label.
- Hover titles name each flight, layover and transfer; airport codes show their
  city on hover. Details show “city, country” beside the codes and wrap long
  names. Countries share the city cache; older city-only
  entries are enriched when details need them, and missing countries retry
  after ten minutes while the labels remain visible.
  From/To show the resolved city beside the code in quieter text, using the
  same cache; clicking either opens a search popover with recent places first.
  Missing names use the same autocomplete API as From/To. Every useful match
  from either field seeds the shared city cache, and identical queries share
  requests and a five-minute query cache. City names persist locally for 180
  days, with stale names still visible while refreshing. Empty matches expire
  after ten minutes within the current session and clear on reload, so a backend
  update can fill previously missing names. Temporary failures retry with backoff while labels remain
  mounted. Background name lookups use at most three requests at once, writes
  are batched, and the persistent cache is capped at 2,048 entries. Existing
  saved names migrate automatically. Unresolved names leave the code visible.
  Departure and return calendars mark the other calendar's range with a warm
  underline and keep the current calendar's selection blue. The return picker
  opens with its range's ending month on the right and the previous month on
  the left. Without a return selection, it puts the departure month on the left
  instead; the departure picker keeps its selected starting month on the left.
  Completing a date range keeps either picker open for further adjustments;
  Done, clicking outside, toggling its segment, or pressing Escape dismisses it.
  Only one search-bar popover is open at a time.
- Booking options offer a price correction button. Enter the corrected total
  in the current display currency; it updates the cheapest offer, sorting,
  filters and colors. Corrections are saved in this app for the exact journey,
  source, seller, passenger counts and cabin, and survive source refreshes.
  The original source quote remains visible. Restore source price removes the
  correction and uses the latest source quote again.
- Timeline bounds and per-leg positions are memoized on the results dataset,
  including offscreen rows. Bounds follow the filtered results; segment timings
  are reused from the full dataset. Sorting and favorites do not rescan it.
  Rows remain virtualized. Favorites occupy a separate column sized to the star
  button. The price column shows the price and the trip's dates, and shares
  the width of its widest content across all filtered results, including
  offscreen rows, so scrolling cannot shift its alignment.
- Colored segments use reported flight durations and same-airport connection
  times. Each airline in a search's results gets its own color, and the most
  frequent airlines get the most appealing ones. Filtering does not repaint
  them; only past nine airlines do rare ones share a color. Missing segment
  timing produces a neutral summary interval. Complete
  details stay visible when their sum disagrees with the reported total; a
  warning explains the difference, and both scale modes include both arrivals.
  The scale never treats naive local timestamps at different airports as
  elapsed time.

- Connections default to a maximum of 12 hours each, including overnight waits.
  The Layovers filter offers 6, 8, 12 and 16 hours, a custom limit, and No limit.
  Stops also hides routes that revisit an airport within either direction by
  default; the ordinary arrival/departure at a connection is one visit, and
  outbound and return are independent. Both preferences are remembered, and
  Reset restores these defaults. Legacy unrestricted defaults migrate once;
  subsequent explicit No limit choices persist. Empty results offer to relax
  connection preferences when doing so would reveal flights. Filtering never
  deletes stored results or starts a scrape.
  Stop and layover choices that yield no flights under the other active filters
  are hidden. The selected value remains available, as do the unrestricted
  choices and custom layover input.
  Default connection preferences use neutral toolbar styling. Only changes from
  the defaults highlight a filter and reveal Reset, including choosing No limit
  or allowing routes that revisit an airport.
  Price and journey duration colors compare each value with the best among the
  matching results, including offscreen rows: price bands end at 10%, 25%, 50%
  and 100% above the cheapest, duration bands at 15%, 35%, 60% and 100% longer
  than the shortest, with outbound and return rated separately. Connections use
  fixed thresholds instead, since a shorter wait is not always better: 1–3h is
  best, under 1h is tight and rated like 3–6h, 6–12h is below average and over
  12h poor. Sorting and scrolling do not change the colors.

- A visible selected flight keeps its screen position when results arrive,
  disappear or are remeasured. Normal scrolling moves the anchor, and an
  offscreen selection does not pull the view back. Changing the sort or a filter
  is different: the list jumps to its top to show the new order. A pill under
  the results bar counts flights that arrived above the first row on screen
  ("12 new flights above") and scrolls up to them. When the selected flight is
  out of view, a chip at the bottom gives its place ("#57 of 1,838") and scrolls
  to it, or says the filters hide it. Those two scroll smoothly within two
  screens and jump beyond, and never animate under reduced motion. One extra
  selected row may stay mounted outside the virtual range; the rest of the list
  remains virtual.
  New visible arrivals fade in for 160 ms without moving their geometry.
  Initial loads, sorting, filtering and virtual remounts do not replay that fade;
  reduced-motion preferences skip it. Hover uses a thin border highlight;
  selection raises the row's background and adds an accent bar on its left
  edge. Neither affects row sizes. Timeline markings keep the same colors and
  opacity on hovered and selected rows. Sorting offers Best, Cheapest, Departure and Shortest.
- The Times filter offers quick picks (depart after 06, 09, 12 or 15; arrive
  before 12, 15, 18 or 22) and a dropdown reaching any half hour, per direction.
- The update control is a quiet icon until an update is available, then an
  "Update available" pill; either opens the same dialog.

- `open_challenge` is an **async** command on purpose. Reading webview cookies
  deadlocks on Windows from a synchronous command or an event handler.
- The shell reserves a free port and passes it to the sidecar, then the frontend
  asks for it via `api_base()` rather than assuming one.
- The sidecar is watched from **both ends**, because one is not enough. The
  shell kills it when the main window is destroyed — but Ctrl+C in a `tauri dev`
  terminal, a crash, or a rebuild kills the shell with no window event at all,
  and the sidecar is left holding its port, the database, and its own binary.
  That last one is nasty: the next `cargo` build panics with a bare
  `PermissionDenied` while trying to delete the locked exe, a long way from its
  cause. So the shell also passes `--exit-with-parent <pid>`, and the sidecar
  waits on that handle and exits when it goes.
- This machine is **aarch64-pc-windows-msvc**. Shipping to x64 needs a sidecar
  built on (or cross-compiled for) that target — PyInstaller does not
  cross-compile.
