# Coding standards

Read at review time (the `factory-review` standards axis). Each rule describes what the code already does; new code matches it. Where a rule and a nearby file disagree, follow the rule and mention the mismatch in the PR. Formatting and lint are enforced by ruff, tsc and pre-commit, so they're not listed here.

## Everywhere

1. **Domain language.** Names in code, tests, logs and PRs use the terms in `GLOSSARY.md` (source, search, scrape, attempt, challenge, clearance, subscription). A new concept gets a glossary entry in the same PR.
2. **Comments explain why.** Module docstrings say what the module is for and the design choice behind it (see `models.py`). Constants with a non-obvious value carry a `#:` comment giving the reason. Comments that restate the code are noise.
3. **Challenges go to a person.** Code that meets a challenge stops asking that source, surfaces the URL and waits for clearance. Solving, answering or working around a challenge in code is never acceptable.

## Python (`flight_scraper/`)

4. **Network access lives in sources.** Only `flight_scraper/sources/` and the existing fetchers (`fx`, `places`) talk to the network, through the session in `sources/base.py`. Every new request path is replayable by `flight_scraper.capture` (record/replay), so tests can cover it offline.
5. **Failures use the error hierarchy.** Raise `RetryableError`, `RateLimited`, `SourceError` or `ChallengeRequired` (from `task_queue` and `sources/base.py`) and decide retryable versus permanent where the failure is detected. Re-raise with `from exc`. A failing source never stops the others.
6. **The model stays source-agnostic.** Sources reduce their responses to `SearchQuery`, `Itinerary` and `Offer` (`models.py`); source-specific shapes stay inside the source module.
7. **Types.** Public functions and dataclass fields are annotated. Match the annotation style of the file you edit (most files use `typing.List`/`Optional`).
8. **Output.** Diagnostics go through `logging`; `print` is for CLI output in `cli.py`.

## Tests (`tests/`, `desktop/tests/`)

9. **Test names are behaviour sentences**, e.g. `test_cancelling_during_admission_does_not_leave_later_work`. A test class docstring states the contract it guards.
10. **Through the public interface**, at the seams the ticket's brief names. Tests survive refactors of internals.
11. **Offline only.** Tests use fixtures and recordings; the replay player fails loudly on an unrecorded URL, and tests rely on that. A parser change that alters a recording's offer digest explains why in the PR.
12. **Time is controlled.** Timing-sensitive tests use injected clocks or explicit tolerances; tests that sleep for real time stay short and say why.
13. **Tests keep their strength.** A PR keeps every existing assertion at least as strict as before; loosening one needs the owner's agreement in the ticket.

## Desktop (`desktop/src/`)

14. **Two boundaries.** `src/api.ts` is the only module that talks to the local `/v1` API; `src/platform.ts` (and `desktopUpdates.ts`) the only ones that call Tauri, each with a browser fallback. Components go through them.
15. **Logic in plain modules.** Sorting, filtering, ratings and layout maths live in `.ts` modules with `node:test` tests (`flightSort.ts`, `flightFilters.ts`); components stay thin.
16. **Exported functions have a one-line doc comment** stating what they do and the invariant they keep (for example, "without mutating rows").
17. **Strict types.** `tsc` runs in strict mode. New code uses concrete types; an `any` needs a comment saying why.
18. **Styles live beside their feature** (`details.css`, `filters.css`); shared tokens stay in `theme.css`.
