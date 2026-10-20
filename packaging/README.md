# Packaging the sidecar

The desktop shell (TypeScript UI) does not reimplement the scrapers — it spawns
this binary and talks to its `/v1` API on localhost. The scraping stays in
Python because `curl_cffi`'s TLS impersonation is what makes the sources answer
a plain HTTP request at all; a browser gets a captcha where it gets a 200.

```bash
uv pip install pyinstaller
python -m PyInstaller --noconfirm --clean --onefile \
  --name flight-scraper-sidecar \
  --distpath packaging/dist --workpath packaging/build --specpath packaging \
  --collect-all curl_cffi --collect-submodules flight_scraper \
  --add-data "../desktop/dist;frontend" \
  --exclude-module playwright --exclude-module patchright \
  --exclude-module scrapling --exclude-module tkinter --exclude-module matplotlib \
  packaging/sidecar.py
```

`--collect-all curl_cffi` is the one that matters: it carries the native libcurl
build. Without it the binary imports fine and then fails on the first request.

The frontend must be built first — `npm install --prefix desktop && npm run
build --prefix desktop` — because `--add-data` carries `desktop/dist` into the
binary as `frontend/`, which is where the server looks when it is packaged.

`--add-data` is resolved relative to **`--specpath`**, not the working
directory, which is why it reads `../desktop/dist` while every other path here
is repo-relative. Get it wrong and PyInstaller prints `Unable to find
...\packaging\templates` and stops — but still exits **0**, so a script around it
carries on and ships a stale binary.

Playwright is excluded on purpose. It exists only to hold a captcha, and the
desktop shell does that in its own webview — which is worth about 150 MB and a
separate `playwright install` step.

## Running it

```
flight-scraper-sidecar --port 5111      # serve the API (the default)
flight-scraper-sidecar scrape BER LON 2026-10-06 --top 5   # any CLI command
```

Anything that is not a known subcommand is treated as arguments to `serve`,
so the shell can just pass a port it has already reserved.

## Measured

| | |
|---|---|
| binary | 19 MB, single file |
| cold start to first `/v1/health` answer | ~2.2 s |
| scraping | verified from a clean directory with no Python installed |

The ~2.2 s is onefile unpacking to a temp directory on every launch. If that
matters, `--onedir` trades a single file for a faster start.
