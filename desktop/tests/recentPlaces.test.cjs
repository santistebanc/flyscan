const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");

const code = buildSync({
  entryPoints: [path.join(__dirname, "../src/recentPlaces.ts")],
  bundle: true, write: false, format: "cjs", platform: "node",
}).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, {
  module: mod,
  exports: mod.exports,
  localStorage: undefined,
});
const { filterRecentPlaces, placeLabel } = mod.exports;

const recents = [
  { code: "BER", label: "Berlin (all airports), Germany", usedAt: 3 },
  { code: "TXL", label: "Berlin Tegel, Germany", usedAt: 2 },
  { code: "LON", label: "London (all airports), United Kingdom", usedAt: 1 },
];

test("empty term returns most recent", () => {
  assert.deepEqual(
    filterRecentPlaces(recents, "").map((r) => r.code),
    ["BER", "TXL", "LON"],
  );
});

test("IATA prefix matches codes", () => {
  assert.deepEqual(
    filterRecentPlaces(recents, "tx").map((r) => r.code),
    ["TXL"],
  );
});

test("substring matches labels", () => {
  assert.deepEqual(
    filterRecentPlaces(recents, "london").map((r) => r.code),
    ["LON"],
  );
});

test("placeLabel joins name and country", () => {
  assert.equal(placeLabel("Berlin (all airports)", "Germany"), "Berlin (all airports), Germany");
  assert.equal(placeLabel("BER", ""), "BER");
});
