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
