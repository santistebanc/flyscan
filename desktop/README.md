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
src/App.tsx       header of search controls, source panel, results list
src/Details.tsx   itinerary detail and every seller, in the side panel
src/styles.css    base layout and interaction styles
src/theme.css     Ledger: dark blue slate, compact grid, tabular figures
src-tauri/        spawns the sidecar on a free port; open_challenge, open_external
```

React + TypeScript, built with Vite. This is the **only** frontend: the same
bundle is loaded by the desktop shell, served by `flight-scraper serve`, and run
with live reload during development. There used to be a second, server-rendered
UI in the Python package; keeping two in step failed often enough that deleting
one was the fix.

The window is a frame, not a page: every search control across a fixed header,
the results down the left, and a fixed side panel on the right showing either
the search queue or the flight you have picked. The results *are* the
page and scroll the window; the header and the panel are pinned out of that
flow, which is why the header remeasures itself into `--header-h` whenever
Advanced opens. Rows carry only what you scan by — price, day, itinerary,
duration — and the panel carries the full itinerary, layovers and every
seller's price for whichever row is selected, by click or with ↑ and ↓.
The chosen Ledger theme keeps the grid compact, with dark blue-slate surfaces,
blue accents, and a sidebar on the right. Geist and Geist Mono are bundled in
`src/assets/fonts`; their OFL licenses ship in `public/licenses`. The temporary
design comparison and picker are not part of the application build.

All money crossing `/v1` is EUR — numbers, never formatted strings, and the
database stores EUR only — so the "show prices in" selector is a re-render rather
than another scrape. It is
persisted in `localStorage` and never reaches the database.

Party, cabin and quote currency sit under **Advanced** in the search form,
folded away by default and opened automatically when the remembered form holds
anything non-default. Changing any search parameter re-reads the database for
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

For an installable Windows release, run `./packaging/build-windows.ps1` from
the repository root. It produces a per-user NSIS installer with the frontend
and Python service included. See [`../packaging/README.md`](../packaging/README.md)
for prerequisites, signing and data storage. The installed app waits for its
authenticated service before showing the main window and keeps writable data
under local app data instead of the installation directory.

For development:

Build the sidecar first (see `../packaging/README.md`), then:

```bash
cd desktop
npm install
cp ../packaging/dist/flight-scraper-sidecar.exe \
   src-tauri/binaries/flight-scraper-sidecar-$(rustc -vV | sed -n 's/host: //p').exe
npm run tauri dev
```

The suffix is not optional: Tauri resolves `externalBin` by target triple and
the build fails without an exact match. `FLIGHT_SCRAPER_SIDECAR` overrides the
path if you would rather point at a binary somewhere else.

## Running the same UI in a browser

While the UI is changing quickly, the desktop shell is the slow way to see a
change. A Rust edit costs a full stop-rebuild-restart, because the running app
holds `target/debug/flight-scraper-sidecar.exe` and the build script has to
delete that file before it can copy a new one — so `tauri dev` cannot rebuild
itself while it is up.

The same frontend runs as an ordinary web page, with live reload:

```bash
flight-scraper serve --port 5111    # or the packaged sidecar
npm run dev --prefix desktop        # http://localhost:1420
```

`src/platform.ts` is what makes this work. It resolves the three shell-only
calls at runtime:

| | desktop | browser |
|---|---|---|
| `apiBase` | the port the shell reserved | `?api=…`, else `VITE_API_BASE`, else `:5111` in dev, the page's own origin when built |
| `openExternal` | `open_external` command | `window.open` |
| `openChallenge` | webview + cookie read-back | refuses, and says why |

Point it at another port with `http://localhost:1420/?api=http://127.0.0.1:5200`.

**Clearing a security check is the one thing that cannot work here**, and the
challenge banner says so rather than offering a button that does nothing. A
browser cannot read cookies from another origin, so a challenge solved in a tab
leaves the scraper just as blocked — which is the whole reason the desktop shell
exists. Use the desktop app when a source actually asks for a human.

## Notes

- Flight rows default to fixed ranges anchored at midnight at the departure
  airport. Each direction uses the smallest fitting 24-hour, 27-hour, 30-hour
  (or longer, in three-hour increments) range,
  advancing by elapsed travel time. The row displays its range; compare bar
  lengths within the same range. Other results cannot stretch that row's scale.
  Timeline > Shared scale instead aligns all filtered results per direction,
  from the earliest departure to the latest elapsed-time arrival. The display
  choice is remembered separately from result filters. Departure dates align
  on day zero; endpoint labels, midnight dates and tooltips retain airport-local
  clocks, including timezone changes.
  Midnight date indicators have a reserved row above the flight bars. Their
  measured widths keep them inside the plot; collisions add date rows, and the
  plot grows to preserve spacing from flight times and connection labels.
  Rounded-hour dividers use the departure-clock reference, with labels below
  the bars. Their intervals adapt to the plot's measured width and time span:
  wider plots show more hours; narrow or multi-day plots use fewer markers.
- Airport codes show resolved city names beside them in the timeline and details.
  Names are cached locally; unresolved names leave the airport code visible.
  Departure and return calendars mark the other calendar's range with a warm
  underline and keep the current calendar's selection blue. Advanced search
  fields expand below the result filters within the results pane, keeping the
  sidebar in place. Endpoint dates share the airport row in the details panel.
- Booking options offer a price correction button. Enter the corrected total
  in the current display currency; it updates the cheapest offer, sorting,
  filters and colors. Corrections are saved in this app for the exact journey,
  source, seller, passenger counts and cabin, and survive source refreshes.
  The original source quote remains visible. Restore source price removes the
  correction and uses the latest source quote again.
- Timeline bounds and per-leg positions are memoized on the results dataset,
  including offscreen rows. Bounds follow the filtered results; segment timings
  are reused from the full dataset. Sorting and favorites do not rescan it.
  Rows remain virtualized. Dates sit below the price; journey durations sit
  inside the timeline, leaving most of the width for comparison.
- Colored segments use reported flight durations and same-airport connection
  times. Missing segment timing produces a neutral summary interval. Complete
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
  Price, layover and journey duration colors compare the minimum and maximum of the
  matching results, including offscreen rows, independently for price, outbound
  duration and return duration, plus connections across both directions.
  Sorting and scrolling do not change the colors.

- A visible selected flight keeps its screen position when results are added,
  removed, reordered or remeasured. Normal scrolling moves the anchor, and an
  offscreen selection does not pull the view back. One extra selected row may
  stay mounted outside the virtual range; the rest of the list remains virtual.
  New visible arrivals fade in for 160 ms without moving their geometry.
  Initial loads, sorting, filtering and virtual remounts do not replay that fade;
  reduced-motion preferences skip it. Hover uses a light tint, while selection
  has a stronger fill and a persistent accent edge.
  Alternating backgrounds use the full results index, so virtual scrolling
  cannot change a flight's stripe. Timeline dividers gain contrast on hovered
  and selected rows. Sorting offers Best, Cheapest, Departure and Shortest.

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
