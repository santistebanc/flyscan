const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");

function load(file, globals = {}) {
  const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src", file)],
    bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports, URLSearchParams, AbortController,
    window: { setTimeout, clearTimeout }, ...globals });
  return module.exports;
}
const { canCancel, canRetry, sourceDetail, queueSummary, matchesSelection, rangeStats, groupStatus, sortQueueGroups, splitQueueGroups, queueStatusCounts } = load("queueModel.ts");
const job = (queue_state, fields = {}) => ({ queue_state, worker_busy: false, ...fields });
const group = (id, sources, extra = {}) => ({ id, sources, created_at: "2026-10-20T10:00:00Z", ...extra });
const orderedIds = (groups) => Array.from(sortQueueGroups(groups), (g) => g.id);

test("compact status counts combine successes and failures and omit empty statuses", () => {
  const counts = queueStatusCounts([job("done", { status: "cached" }), job("done", { status: "completed" }),
    job("cancelled"), job("timed_out"), job("running")]);
  assert.deepEqual(Array.from(counts, ({ state, count }) => [state, count]),
    [["done", 2], ["cancelled", 1], ["failed", 1], ["running", 1]]);
  assert.equal(counts.reduce((total, status) => total + status.count, 0), 5);
  assert.equal(queueStatusCounts([]).length, 0);
});

test("status counts distinguish verification and queued work from physical workers still stopping", () => {
  const counts = queueStatusCounts([job("waiting_action"), job("queued"), job("retry_wait"),
    job("cancelled", { worker_busy: true })]);
  assert.deepEqual(Array.from(counts, ({ state, count }) => [state, count]),
    [["input", 1], ["running", 1], ["waiting", 2]]);
});

test("retry counts acknowledge only the affected sources and retain completed results", () => {
  const jobs = [job("done", { state: "done", source: "ff-kayak" }),
    job("failed", { state: "failed", source: "ff-sky" }), job("failed", { state: "failed", source: "momondo" })];
  assert.deepEqual(Array.from(queueStatusCounts(jobs, { action: "retry", source: "ff-sky" }), ({ state, count }) => [state, count]),
    [["done", 1], ["failed", 1], ["running", 1]]);
  assert.deepEqual(Array.from(queueStatusCounts(jobs, { action: "retry" }), ({ state, count }) => [state, count]),
    [["done", 1], ["running", 2]]);
});

test("only settled jobs outside the selected filters move to inactive searches", () => {
  const groups = [
    group("selected-done", [job("done")], { mine: true }),
    group("selected-failed", [job("failed")], { mine: true }),
    ...["running", "queued", "retry_wait", "waiting_action"].map((state) => group(state, [job(state)])),
    group("stopping", [job("cancelled", { worker_busy: true })]),
    group("outside-done", [job("done")]),
    group("outside-failed", [job("failed")]),
    group("outside-cancelled", [job("cancelled")]),
    group("outside-timeout", [job("timed_out")]),
  ];
  const split = splitQueueGroups(groups);
  assert.deepEqual(Array.from(split.inactive, (g) => g.id).sort(), ["outside-cancelled", "outside-done", "outside-failed", "outside-timeout"]);
  assert.equal(split.active.length, 7);
});

test("an inactive job becomes visible as soon as its retry is requested", () => {
  const groups = [group("retrying", [job("failed")]), group("other", [job("done")])];
  const split = splitQueueGroups(groups, ["retrying"]);
  assert.deepEqual(Array.from(split.active, (g) => g.id), ["retrying"]);
  assert.deepEqual(Array.from(split.inactive, (g) => g.id), ["other"]);
  assert.equal(splitQueueGroups(groups).active.length, 0, "a rejected retry returns to inactive history");
});

test("jobs move between sections as filters and the last remaining worker change", () => {
  const current = group("one", [job("done"), job("cancelled", { worker_busy: true })]);
  assert.equal(splitQueueGroups([current]).active.length, 1);
  current.sources[1].worker_busy = false;
  assert.equal(splitQueueGroups([current]).inactive.length, 1);
  current.mine = true;
  assert.equal(splitQueueGroups([current]).active.length, 1);
});

test("queue groups follow active work, scheduler priority and FIFO rather than selected or newest first", () => {
  const groups = [
    group("finished-selected", [job("done", { id: 1 })], { mine: true }),
    group("background-new", [job("queued", { id: 30, priority: 10 })]),
    group("background-old", [job("queued", { id: 20, priority: 10 })]),
    group("selected-next", [job("queued", { id: 40, priority: 0 })]),
    group("running", [job("running", { id: 10, priority: 10 })]),
  ];
  assert.deepEqual(orderedIds(groups), ["running", "selected-next", "background-old", "background-new", "finished-selected"]);
  assert.equal(groups[0].id, "finished-selected", "sorting must not mutate the queue snapshot");
});

test("ready work precedes cooldowns, occupied sources and verification waits", () => {
  const groups = [
    group("verification", [job("waiting_action", { id: 1, priority: 0 })]),
    group("occupied", [job("queued", { id: 2, priority: 0, wait_reason: "source_busy", ready_in: 0 })]),
    group("long-wait", [job("queued", { id: 3, priority: 0, ready_in: 30 })]),
    group("short-wait", [job("retry_wait", { id: 4, priority: 10, ready_in: 5 })]),
    group("ready", [job("queued", { id: 5, priority: 10, ready_in: 0 })]),
  ];
  assert.deepEqual(orderedIds(groups), ["ready", "short-wait", "long-wait", "occupied", "verification"]);
  groups[2].sources[0].ready_in = 0;
  assert.equal(orderedIds(groups)[0], "long-wait", "selected priority takes effect when its cooldown expires");
});

test("a group's next runnable source determines its position, excluding its blocked and completed sources", () => {
  const mixed = group("mixed", [
    job("done", { id: 1, priority: 0 }),
    job("queued", { id: 2, priority: 0, ready_in: 60 }),
    job("queued", { id: 100, priority: 10, ready_in: 0 }),
  ]);
  const other = group("other", [job("queued", { id: 50, priority: 10, ready_in: 0 })]);
  assert.deepEqual(orderedIds([mixed, other]), ["other", "mixed"]);
});

test("shared cooldown snapshot drift does not reverse source priority or FIFO", () => {
  const groups = [
    group("background-new", [job("queued", { id: 30, priority: 10, ready_in: 12.001 })]),
    group("background-old", [job("queued", { id: 20, priority: 10, ready_in: 12.002 })]),
    group("selected", [job("queued", { id: 40, priority: 0, ready_in: 12.003 })]),
  ];
  assert.deepEqual(orderedIds(groups), ["selected", "background-old", "background-new"]);
});

test("retried tasks take their new FIFO position and stopping workers remain active", () => {
  const groups = [
    group("retried-old-search", [job("queued", { id: 100, priority: 10 })], { created_at: "2026-01-01" }),
    group("already-waiting", [job("queued", { id: 90, priority: 10 })], { created_at: "2026-10-20" }),
    group("stopping", [job("cancelled", { id: 80, worker_busy: true })]),
  ];
  assert.deepEqual(orderedIds(groups), ["stopping", "already-waiting", "retried-old-search"]);
});

test("completed, failed and cancelled groups stay below live work, with recent history first", () => {
  const groups = [
    group("old-done", [job("done")], { created_at: "2026-01-01", mine: true }),
    group("failed", [job("failed")], { created_at: "2026-10-19" }),
    group("new-cancelled", [job("cancelled")], { created_at: "2026-10-20" }),
    group("waiting", [job("queued", { id: 10, priority: 10 })]),
  ];
  assert.deepEqual(orderedIds(groups), ["waiting", "new-cancelled", "failed", "old-done"]);
});

test("running, delayed and input-waiting sources can each be cancelled", () => {
  for (const state of ["queued", "running", "retry_wait", "waiting_action"]) {
    assert.equal(canCancel(job(state)), true);
    assert.equal(canRetry(job(state)), false);
  }
});

test("cancelled and timed-out workers cannot be retried before releasing capacity", () => {
  for (const state of ["cancelled", "timed_out", "failed", "done"]) {
    assert.equal(canRetry(job(state, { worker_busy: true })), false);
    assert.equal(canRetry(job(state)), true);
    assert.equal(canCancel(job(state)), false);
  }
});

test("input, retry delay and rate limits have distinct explanations", () => {
  assert.match(sourceDetail({ status: "waiting_input", action: { message: "Verify this source" } }), /verification/);
  assert.match(sourceDetail({ status: "rate_limited", ready_in: 12.3 }), /short break.*13s/);
  assert.match(sourceDetail({ status: "retrying", attempts: 2, ready_in: 5, error: "Offline" }), /Attempt 2.*5s.*Offline/);
  assert.match(sourceDetail({ status: "cancelling" }), /current request to stop/);
});

test("queue summary counts logical source tasks, including work needing input", () => {
  assert.equal(queueSummary([job("running"), job("retry_wait"), job("waiting_action"), job("done")]),
    "1 searching · 1 queued · 1 needs your help");
});

test("queue reads remain global; selection and exact group controls use separate endpoints", async () => {
  const calls = [];
  const { FlightScraperApi } = load("api.ts", {
    fetch: async (url, init) => { calls.push({ url, ...init }); return { ok: true, json: async () => ({}) }; },
  });
  const api = new FlightScraperApi("http://local");
  await api.queue();
  await api.selectQueueQuery({ origin: "BER", destination: "CDG", start: "2026-12-21", currency: "USD" });
  await api.queryJobAction("one", "retry");
  await api.queryJobAction("one", "cancel", "ff-sky");
  await api.queueRangeAction({ origin: "BER", destination: "CDG", start: "2026-12-21", end: "2026-12-23" }, "cancel");
  assert.equal(calls[0].url, "http://local/v1/jobs");
  assert.equal(calls[1].url, "http://local/v1/queue/selection");
  assert.equal(JSON.parse(calls[1].body).currency, "USD");
  assert.equal(calls[2].url, "http://local/v1/query-jobs/one/retry");
  assert.equal(calls[3].url, "http://local/v1/query-jobs/one/sources/ff-sky/cancel");
  assert.equal(calls[4].url, "http://local/v1/queue/actions/cancel");
  assert.equal(JSON.parse(calls[4].body).end, "2026-12-23");
});

test("selected-range summaries count every matching query and no unrelated work", () => {
  const selection = { origin: "BER", destination: "CDG", start: "2026-12-21", end: "2026-12-22" };
  const base = { origin: "BER", destination: "CDG", depart: "2026-12-21", ret: "",
    adults: 1, children: 0, infants: 0, cabin: "economy", currency: "EUR" };
  const groups = [
    { ...base, sources: [job("done", { state: "done", count: 12 }), job("waiting_action", { state: "blocked" })] },
    { ...base, depart: "2026-12-22", sources: [job("cancelled", { state: "cancelled" })] },
    ...[{ depart: "2026-12-23" }, { adults: 2 }, { children: 1 }, { infants: 1 },
      { cabin: "business" }, { currency: "USD" }, { destination: "LON" }, { ret: "2026-12-28" }]
      .map((over) => ({ ...base, ...over, sources: [job("running", { state: "running", count: 1000 })] })),
  ];
  const selected = groups.filter((g) => matchesSelection(g, selection));
  const stats = rangeStats(selected);
  assert.equal(stats.groups, 2);
  assert.equal(stats.total, 3);
  assert.equal(stats.done, 1);
  assert.equal(stats.offers, 12);
  assert.equal(stats.cancellable, 1);
  assert.equal(stats.retryable, 1);
  assert.equal(matchesSelection(base, null), false);
});

test("return date ranges and quote currency scope the header independently", () => {
  const selection = { origin: "BER", destination: "CDG", start: "2026-12-21", end: "2026-12-22",
    ret: "2026-12-28", ret_end: "2026-12-29", currency: "USD" };
  const group = { origin: "BER", destination: "CDG", depart: "2026-12-22", ret: "2026-12-29",
    adults: 1, children: 0, infants: 0, cabin: "economy", currency: "USD" };
  assert.equal(matchesSelection(group, selection), true);
  assert.equal(matchesSelection({ ...group, ret: "2026-12-30" }, selection), false);
  assert.equal(matchesSelection({ ...group, currency: "EUR" }, selection), false);
});

test("group indicators keep failures and verification visible alongside active work", () => {
  const running = job("running");
  assert.equal(groupStatus([running]).state, "running");
  assert.equal(groupStatus([job("done")]).state, "done");
  assert.equal(groupStatus([job("queued")]).state, "waiting");
  assert.equal(groupStatus([job("retry_wait")]).state, "waiting");
  assert.equal(groupStatus([job("cancelled")]).state, "cancelled");
  const failed = groupStatus([running, job("failed")]);
  assert.equal(failed.state, "failed");
  assert.equal(failed.loading, true);
  const input = groupStatus([running, job("waiting_action")]);
  assert.equal(input.state, "input");
  assert.equal(input.loading, true);
  assert.equal(groupStatus([job("cancelled", { worker_busy: true })]).loading, true);
});
