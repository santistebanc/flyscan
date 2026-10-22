const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const path = require("node:path");
const vm = require("node:vm");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/api.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const places = [{ code: "LHR", name: "Heathrow", kind: "airport", city: "London" },
  { code: "LGW", name: "Gatwick", kind: "airport", city: "London" }];
function host() {
  const calls = [], storage = new Map(), timers = new Map();
  let now = 1_800_000_000_000, nextTimer = 0, fail = false;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (url) => { calls.push(url); if (fail) throw new Error("Offline"); return { ok: true, json: async () => places }; },
  });
  return { api: new mod.exports.FlightScraperApi("http://127.0.0.1:5111"), calls, storage,
    advance(ms) { now += ms; }, fail(value) { fail = value; } };
}
test("From/To and city labels share one in-flight request and a short query cache", async () => {
  const h = host();
  await Promise.all([h.api.places("LHR"), h.api.places(" lhr ")]);
  assert.equal(h.calls.length, 1);
  await h.api.places("LHR");
  assert.equal(h.calls.length, 1);
  h.advance(6 * 60_000);
  await h.api.places("LHR");
  assert.equal(h.calls.length, 2);
});
test("failed autocomplete requests are retryable instead of cached", async () => {
  const h = host(); h.fail(true);
  await assert.rejects(h.api.places("LHR")); h.fail(false);
  assert.equal((await h.api.places("LHR"))[0].city, "London");
  assert.equal(h.calls.length, 2);
});
test("From/To lookups immediately fill all matching city labels", async () => {
  const h=host();
  await h.api.places("London");
  h.api.airportCities.start();h.api.airportCities.ensure("LHR");h.api.airportCities.ensure("LGW");
  assert.equal(h.api.airportCities.snapshot().LHR,"London");
  assert.equal(h.api.airportCities.snapshot().LGW,"London");
  assert.equal(h.calls.length,1);
});
