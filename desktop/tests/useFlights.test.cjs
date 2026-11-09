/** Exercise async view isolation through the real hook with a minimal hook host. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/useFlights.ts")],
  bundle: true, external: ["react"], write: false, format: "cjs", platform: "node" }).outputFiles[0].text;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function host(api) {
  let cursor = 0;
  const slots = [];
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback: (callback) => callback,
    // These tests explicitly drive the view changes normally initiated by App.
    useEffect() {},
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports, require: (name) => {
    assert.equal(name, "react"); return hooks;
  } });
  return () => { cursor = 0; return module.exports.useFlights(api); };
}

const row = (key) => ({ trip_key: key, best: { price_base: 10 } });
const answer = (key) => ({ results: [row(key)], sources: [], last_seen: new Date().toISOString() });
const request = { origin: "BER", destination: "CDG", start: "2026-12-21" };

test("first-load feedback covers startup and debounce, then stops for a completed empty response", async () => {
  const pending = deferred();
  const render = host({ storedFlights: () => pending.promise });
  render().selectView(true);
  assert.equal(render().loadingStored, true, "show loading before the debounced read starts");
  const loading = render().loadStored(request);
  assert.equal(render().loadingStored, true);
  pending.resolve({ results: [], sources: [], last_seen: "" });
  await loading;
  assert.equal(render().loadingStored, false);
  assert.equal(render().freshness.kind, "empty");
  render().selectView(false);
  assert.equal(render().loadingStored, false, "an incomplete form is not a pending read");
});

test("background cache reads retain the already loaded flights", async () => {
  const pending = deferred();
  let reads = 0;
  const render = host({ storedFlights: () => ++reads === 1 ? Promise.resolve(answer("cached")) : pending.promise });
  await render().loadStored(request);
  const refresh = render().loadStored(request);
  assert.equal(render().loadingStored, false, "a refresh of an answered view is not loading");
  assert.equal(render().total, 1, "the loading view must not replace existing results");
  assert.deepEqual(Array.from(render().rows, (r) => r.trip_key), ["cached"]);
  pending.resolve(answer("updated"));
  await refresh;
  assert.equal(render().loadingStored, false);
});

test("polling an empty view never flashes the loading indicator", async () => {
  const pending = deferred();
  let reads = 0;
  const empty = { results: [], sources: [], last_seen: "" };
  const render = host({ storedFlights: () => ++reads === 1 ? Promise.resolve(empty) : pending.promise });
  render().selectView(true);
  await render().loadStored(request);
  assert.equal(render().loadingStored, false);
  const poll = render().loadStored(request);
  assert.equal(render().loadingStored, false, "the 3-second refresh must not swap the empty state for a spinner");
  pending.resolve(empty);
  await poll;
  assert.equal(render().loadingStored, false);
  render().selectView(true);
  assert.equal(render().loadingStored, true, "a new view loads again");
});

test("stored and live datasets retain flights beyond the old 300-row display cap", async () => {
  const rows = Array.from({ length: 680 }, (_, i) => ({ ...row(String(i)), best: { price_base: i + 1 } }));
  const stored = host({ storedFlights: async () => ({ ...answer(""), results: rows }) });
  await stored().loadStored(request);
  assert.equal(stored().rows.length, 680);
  assert.equal(stored().rows[679].trip_key, "679");
  let event;
  const live = host({ createSearch: async () => ({ search_id: "current" }),
    streamSearch: (_, handle) => { event = handle; return { close() {} }; } });
  await live().runSearch(request);
  event({ event: "day_partial", rows });
  assert.equal(live().rows.length, 680);
  event({ event: "day_partial", rows: [{ ...row("later"), best: { price_base: 9999 } }] });
  assert.equal(live().rows.length, 681);
  assert.equal(live().rows[680].trip_key, "later");
});

test("a search created after its view was left never attaches a stale stream", async () => {
  const pending = deferred();
  let attached = 0;
  const render = host({ createSearch: () => pending.promise, storedFlights: async () => answer("new"),
    streamSearch: () => { attached++; return { close() {} }; } });
  const running = render().runSearch(request);
  render().selectView();
  await render().loadStored({ ...request, destination: "LON" });
  pending.resolve({ search_id: "old" });
  await running;
  assert.equal(attached, 0);
  assert.deepEqual(Array.from(render().rows, (r) => r.trip_key), ["new"]);
  assert.equal(render().running, false);
});

test("late source events cannot append old-query rows to the selected results", async () => {
  let event, closed = 0;
  const render = host({ createSearch: async () => ({ search_id: "old" }),
    storedFlights: async () => answer("new"), streamSearch: (_, handle) => {
      event = handle; return { close() { closed++; } };
    } });
  await render().runSearch(request);
  event({ event: "day_partial", rows: [row("old")] });
  render().selectView();
  await render().loadStored({ ...request, destination: "LON" });
  event({ event: "day_partial", rows: [row("late-old")] });
  assert.equal(closed, 1);
  assert.deepEqual(Array.from(render().rows, (r) => r.trip_key), ["new"]);
});

test("a delayed ledger response cannot replace a newer view", async () => {
  const pending = deferred();
  const render = host({ storedFlights: (r) => r.destination === "CDG" ? pending.promise : Promise.resolve(answer("new")) });
  const first = render().loadStored(request);
  render().selectView();
  await render().loadStored({ ...request, destination: "LON" });
  pending.resolve(answer("old"));
  await first;
  assert.deepEqual(Array.from(render().rows, (r) => r.trip_key), ["new"]);
});

test("polling does not discard the initial cached results while a read is still pending", async () => {
  const first = deferred(), second = deferred();
  let reads = 0;
  const render = host({ storedFlights: () => ++reads === 1 ? first.promise : second.promise });
  const initial = render().loadStored(request);
  // The 3-second refresh fires before the first database response arrives.
  const poll = render().loadStored({ ...request });
  assert.equal(render().loadingStored, true);
  first.resolve(answer("cached"));
  await initial;
  assert.deepEqual(Array.from(render().rows, (r) => r.trip_key), ["cached"],
    "a background refresh must not invalidate the pending initial load");
  assert.equal(reads, 1, "identical stored reads should share the in-flight request");
  second.resolve(answer("later"));
  await poll;
  assert.equal(render().loadingStored, false);
});

test("an old view finishing cannot release the current view's pending read", async () => {
  const old = deferred(), current = deferred();
  let reads = 0;
  const render = host({ storedFlights: () => ++reads === 1 ? old.promise : current.promise });
  const initial = render().loadStored(request);
  render().selectView();
  const nextRequest = { ...request, destination: "LON" };
  const next = render().loadStored(nextRequest);
  old.resolve(answer("old"));
  await initial;
  assert.equal(render().loadingStored, true, "a stale response must not hide the current loading indicator");
  const poll = render().loadStored(nextRequest);
  assert.equal(reads, 2, "the current read must still be shared after the stale one finishes");
  current.resolve(answer("current"));
  await Promise.all([next, poll]);
  assert.deepEqual(Array.from(render().rows, (r) => r.trip_key), ["current"]);
});

test("a failed initial cache read can be retried by the next refresh", async () => {
  let reads = 0;
  const render = host({ storedFlights: async () => {
    if (++reads === 1) throw new Error("sidecar restarting");
    return answer("cached");
  } });
  await render().loadStored(request);
  assert.equal(render().loadingStored, false, "a failed request must not leave loading stuck on");
  await render().loadStored(request);
  assert.equal(reads, 2);
  assert.deepEqual(Array.from(render().rows, (r) => r.trip_key), ["cached"]);
});

test("a scheduled ledger read cannot invalidate a newly started search stream", async () => {
  let event, reads = 0;
  const render = host({ createSearch: async () => ({ search_id: "current" }),
    storedFlights: async () => { reads++; return answer("cached"); },
    streamSearch: (_, handle) => { event = handle; return { close() {} }; } });
  await render().runSearch(request);
  await render().loadStored(request);
  event({ event: "day_partial", rows: [row("live")] });
  assert.equal(reads, 0);
  assert.deepEqual(Array.from(render().rows, (r) => r.trip_key), ["live"]);
});

test("polls skip the full read until the stored flights for the view change", async () => {
  let reads = 0, stamp = "a";
  const render = host({
    storedFlights: async () => ({ ...answer(`read${++reads}`), stamp }),
    storedStamp: async () => ({ stamp }),
  });
  await render().loadStored(request);
  await render().loadStored(request, { ifChanged: true });
  assert.equal(reads, 1, "an unchanged stamp needs no full read");
  stamp = "b";
  await render().loadStored(request, { ifChanged: true });
  assert.equal(reads, 2);
  assert.deepEqual(Array.from(render().rows, (r) => r.trip_key), ["read2"]);
  await render().loadStored(request);
  assert.equal(reads, 3, "an explicit reload always reads");
});
