# flyscan

Use the domain terms in `GLOSSARY.md` in code, tests and PRs.

## Stay offline

Live requests to the flight sites risk IP bans and bot challenges. Set `FLYSCAN_OFFLINE=1`; use tests, `tests/fixtures/` and `tests/recordings/` (replayed by `backend/src/transport.ts`, never the network). Run live requests only when an explicit owner decision allows them. A challenge is always put in front of a person; code waits for clearance.

## Showing a change

On the shared dev server (the owner on a phone): run `remote-dev/dev.sh` from the checkout you edit and give the owner the URL it prints. It hot-reloads from then on; run it again only after switching checkouts. Releases go through the `Release` workflow, started only when the owner asks.

## Checks

- Backend: `npm ci --prefix backend` once, then `npm test --prefix backend` and `npm run build --prefix backend`.
- Curl transport: `npm run test:transport` (after `uv sync`). Release tools: `npm run test:packaging`.
- Desktop: `cd desktop && npm ci` once, then `npm test` and `npm run build` (tsc + vite).
- Everything the commit hook runs: `uv run pre-commit run --all-files`.
- Rust/Tauri builds are heavy: let CI run them (`CI (Tauri)` on PRs that touch `desktop/src-tauri/`).
