const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");

function load(file) {
  const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src", file)],
    bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(bundle, { module, exports: module.exports });
  return module.exports;
}
const { sanitizeDisabled, chosenSources, requestedSources, toggleSource, rowsFromSources } = load("sourceSelection.ts");
const known = ["ff-kayak", "ff-sky", "momondo"];

test("a stored choice keeps only distinct names and survives corrupt storage", () => {
  assert.deepEqual(Array.from(sanitizeDisabled(["momondo", 3, "momondo", null])), ["momondo"]);
  assert.deepEqual(Array.from(sanitizeDisabled({ momondo: true })), []);
  assert.deepEqual(Array.from(sanitizeDisabled(null)), []);
});

test("every source is asked by default, including ones added after the choice was stored", () => {
  assert.equal(requestedSources(known, []), undefined);
  assert.deepEqual(Array.from(chosenSources([...known, "jetradar"], ["momondo"])), ["ff-kayak", "ff-sky", "jetradar"]);
});

test("a narrowed choice is sent in the sidecar's order and ignores sources it no longer offers", () => {
  assert.deepEqual(Array.from(requestedSources(known, ["ff-sky", "gone"])), ["ff-kayak", "momondo"]);
  assert.equal(requestedSources(known, ["gone"]), undefined);
});

test("the last checked source cannot be turned off", () => {
  const two = toggleSource(known, [], "ff-kayak");
  assert.deepEqual(Array.from(two), ["ff-kayak"]);
  const one = toggleSource(known, two, "ff-sky");
  assert.deepEqual(Array.from(toggleSource(known, one, "momondo")), Array.from(one));
  assert.deepEqual(Array.from(toggleSource(known, one, "ff-kayak")), ["ff-sky"]);
  // A choice that somehow excludes everything still asks every source.
  assert.deepEqual(Array.from(chosenSources(known, known)), known);
});

test("the list keeps only the chosen sources' offers and reprices each flight from them", () => {
  const offer = (source, price_base) => ({ source, agent: "", price: price_base, currency: "EUR", price_base });
  const shared = { trip_key: "shared", offers: [offer("momondo", 90), offer("ff-sky", 100), offer("ff-kayak", 130)],
    sources: ["momondo", "ff-sky", "ff-kayak"], source_count: 3, spread: 40 };
  shared.best = shared.offers[0];
  const onlyMomondo = { trip_key: "momondo-only", offers: [offer("momondo", 70)], sources: ["momondo"], source_count: 1, spread: null };
  onlyMomondo.best = onlyMomondo.offers[0];
  const rows = [shared, onlyMomondo];

  assert.equal(rowsFromSources(rows, undefined), rows, "every source chosen leaves the rows alone");
  const shown = rowsFromSources(rows, ["ff-sky", "ff-kayak"]);
  assert.deepEqual(Array.from(shown, (row) => row.trip_key), ["shared"]);
  assert.equal(shown[0].best.source, "ff-sky");
  assert.equal(shown[0].spread, 30);
  assert.deepEqual(Array.from(shown[0].sources), ["ff-sky", "ff-kayak"]);
  assert.equal(shown[0].source_count, 2);
  assert.equal(shared.best.source, "momondo", "stored rows stay as they were");
  assert.equal(rowsFromSources(rows, ["momondo", "ff-sky", "ff-kayak"])[0], shared, "untouched rows are reused");
});
