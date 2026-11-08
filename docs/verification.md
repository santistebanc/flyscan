# Offline verification

Run `npm run verify -- discover` for scenarios and required checks, then `doctor`
to check Node and installed dependencies. Install with `npm ci --prefix backend`
and `npm ci --prefix desktop`. Scenario children always receive
`FLYSCAN_OFFLINE=1` and a disposable data directory.

- `npm run verify -- run recorded-search` runs both retained recordings through
  the real TypeScript CLI. Both offer count and semantic digest must match each
  recording's expectations. The CLI uses ReplayTransport with no network fallback.
- `npm run verify -- controls recorded-search` additionally copies a recording
  into disposable state and changes the count, changes only the digest, and marks
  responses truncated. Each real CLI replay must fail for the expected reason.
  Source recordings are never edited. The control record lists those rejections.
- `npm run verify -- run queue-lifecycle` runs the existing scheduler/API tests
  and desktop queue model, connection and hook tests. They cover shared scrapes,
  independent cancellation, retry, durable challenge holds, restored work and
  stale connection handling.
- `npm run verify -- evidence RUN_ID` checks that a result belongs to the current
  commit and source fingerprint. Failed, incomplete or stale runs are not green.

Evidence is retained under ignored `tmp/verification/RUN_ID/`. The public-shaped
`evidence.json` contains hashes, check outcomes and limits; per-check logs are
private diagnostics. A rerun creates a new record. Each scenario removes its own
scratch data and preserves results, including failures.

Keep the existing `npm test`, `npm run build` and
`uv run pre-commit run --all-files` checks. Native transport tests may use their
documented local loopback server; the verification scenarios do not query flight
sites. Neither model/hook tests nor replay prove browser appearance, current
fares, native app installation or Tauri release readiness. UI changes still need
a named browser journey and visual evidence. No UI behavior changes here, and no
release is authorized by a passing verification run.
