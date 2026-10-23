# flight-scraper

Python scrapers and a local API (`flight_scraper/`), plus a Tauri 2 / React desktop shell (`desktop/`, see its README). Use the domain terms in `GLOSSARY.md` in code, tests and PRs.

## Stay offline

Live requests to the flight sites risk IP bans and bot challenges. Work against tests, `tests/fixtures/` and `tests/recordings/` (replayed by `flight_scraper.capture`, never the network). The CLI commands `scrape`, `capture`, `unblock`, `places`, `rates` and `serve`, and the desktop dev app, reach the live sites: use the factory's isolated offline preview configuration for development, and run live requests only when an explicit owner decision allows them. A challenge is always put in front of a person; code waits for clearance.

## Checks

- Python: `uv run pytest -q tests/test_<area>.py` while working; `uv run pytest -q` before the PR.
- Desktop: `cd desktop && npm ci` once, then `npm test` and `npm run build` (tsc + vite).
- Everything the commit hook runs: `uv run pre-commit run --all-files`. Factory bootstrap preserves these checks alongside its coordination hooks.
- Rust/Tauri builds are heavy: let CI run them (`CI (Tauri)` on PRs that touch `desktop/src-tauri/`).

## Factory workflow

Use the installed factory skill when developing here. Continue in this thread's isolated workspace and preview; make requested edits promptly, save recoverable commits and reconcile tickets alongside the work. Tickets preserve requirements and may have several contributors. Record implementation evidence before integration; integration PRs can combine tickets and run full checks plus independent reviews. A merge establishes a shared developer version. Production delivery is a separate decision.
