/** Queue requests must settle so one lost connection cannot stop refreshes. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/api.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;

function connection() {
  const timers = new Map(), requests = [];
  let timerId = 0;
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports, Error, AbortController, URLSearchParams,
    window: { setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
      clearTimeout(id) { timers.delete(id); } },
    fetch: (url, init) => new Promise((resolve, reject) => {
      const request = { url, init, resolve, aborted: false }; requests.push(request);
      init.signal?.addEventListener("abort", () => { request.aborted = true; reject(new Error("Aborted")); });
    }),
  });
  return { api: new module.exports.FlightScraperApi("http://local"), requests,
    expire() { for (const [id, t] of [...timers]) { if (t.ms <= 10000) { timers.delete(id); t.fn(); } } } };
}

test("a stalled queue read is aborted within ten seconds", async () => {
  const c = connection();
  const pending = c.api.queue().catch((error) => error);
  c.expire();
  const aborted = c.requests[0].aborted;
  c.requests[0].resolve({ ok: true, json: async () => ({}) });
  const result = await pending;
  assert.equal(aborted, true, "a hung fetch must not stop subsequent polls indefinitely");
  assert.match(result.message, /timed out/i);
});

test("a stalled retry request is bounded and is never automatically resent", async () => {
  const c = connection();
  const pending = c.api.queryJobAction("one", "retry").catch((error) => error);
  c.expire();
  const aborted = c.requests[0].aborted;
  c.requests[0].resolve({ ok: true, json: async () => ({}) });
  await pending;
  assert.equal(aborted, true);
  assert.equal(c.requests.length, 1, "a timed out POST may already have been accepted");
});

test("queue reads explicitly bypass cached responses", async () => {
  const c = connection();
  const pending = c.api.queue();
  c.requests[0].resolve({ ok: true, json: async () => ({}) }); await pending;
  assert.equal(c.requests[0].init.cache, "no-store");
});
