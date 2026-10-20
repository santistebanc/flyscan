const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/progress.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const moduleContext = { exports: {} };
vm.runInNewContext(bundle, { module: moduleContext, exports: moduleContext.exports });
const { emptyProgress, reduceProgress } = moduleContext.exports;

function sequence(events, total = 1) {
  let state = reduceProgress(emptyProgress(), { event: "start", seq: 1, jobs: total, sources: ["ff-sky"] });
  let seq = 2;
  for (const event of events) state = reduceProgress(state, {
    source: "ff-sky", day: "2026-12-21", ret: null, scrape_id: 7, attempt: 1,
    count: 12, error: "", elapsed: 1, age_hours: null, origin: "scrape", seq: seq++, ...event,
  });
  return state;
}

test("retries count one logical scrape and release the running count", () => {
  const state = sequence([
    { event: "source_start" }, { event: "source_retry", message: "timeout" },
    { event: "source_start", attempt: 2 }, { event: "source_retry", attempt: 2, message: "timeout" },
    { event: "source_start", attempt: 3 }, { event: "source_done", attempt: 3 },
  ]);
  assert.equal(state.counts.running, 0);
  assert.equal(state.counts.done, 1);
  assert.equal(state.sources["ff-sky"].phase, "done");
});

test("a shared completion releases a previously observed attempt", () => {
  const state = sequence([{ event: "source_start" }, { event: "source_done", origin: "shared" }]);
  assert.equal(state.counts.running, 0);
  assert.equal(state.counts.done, 1);
});

test("retry and challenge waits consume no running scrape", () => {
  for (const waiting of [{ event: "source_retry", message: "offline" }, { event: "challenge_required" }]) {
    const state = sequence([{ event: "source_start" }, waiting]);
    assert.equal(state.counts.running, 0);
    assert.equal(state.counts.done, 0);
  }
});

test("two return dates retain independent running state", () => {
  const state = sequence([
    { event: "source_start", ret: "2026-12-28" },
    { event: "source_start", ret: "2026-12-29", scrape_id: 8 },
    { event: "source_done", ret: "2026-12-28" },
  ], 2);
  assert.equal(state.counts.running, 1);
  assert.equal(state.counts.done, 1);
  assert.equal(state.sources["ff-sky"].phase, "fetching");
});

test("replayed completion events do not double count", () => {
  const completed = sequence([{ event: "source_done" }]);
  const replayed = reduceProgress(completed, { event: "source_done", seq: 2,
    source: "ff-sky", day: "2026-12-21", ret: null, scrape_id: 7, attempt: 1 });
  assert.equal(replayed.counts.done, 1);
});

test("cached answers finish without ever becoming running", () => {
  const state = sequence([{ event: "source_done", origin: "cache", scrape_id: null, attempt: 0 }]);
  assert.equal(state.counts.running, 0);
  assert.equal(state.counts.done, 1);
  assert.equal(state.sources["ff-sky"].phase, "skipped");
});
