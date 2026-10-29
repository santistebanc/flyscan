const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/flightRatings.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { flightRatings, durationMinutes } = mod.exports;
const row = (id, price, duration = "1h 00m", back = "") => ({
  trip_key: id, best: { price_base: price }, duration, return_duration: back,
});

test("prices are rated by how far above the cheapest fare they are", () => {
  // Bands end at +10%, +25%, +50% and +100%; beyond that is Poor.
  const rows = [100, 110, 111, 125, 150, 200, 201].map((price) => row(String(price), price));
  const ratings = flightRatings(rows);
  assert.deepEqual(rows.map((r) => ratings.get(r.trip_key).price.level), [1, 1, 2, 2, 3, 4, 5]);
  assert.equal(ratings.get("100").price.description, "Excellent · The cheapest in this list");
  assert.equal(ratings.get("125").price.description, "Good · 25% above the cheapest in this list");
});

test("one extreme fare does not squash every other fare into the best band", () => {
  const rows = [893, 1069, 1596, 2021, 11176].map((price) => row(String(price), price));
  const ratings = flightRatings(rows);
  assert.deepEqual(rows.map((r) => ratings.get(r.trip_key).price.level), [1, 2, 4, 5, 5]);
});

test("durations use wider bands than prices, independently per direction", () => {
  // Bands end at +15%, +35%, +60% and +100%.
  const rows = [["a", "10h", "2h"], ["b", "11h 30m", "2h 42m"], ["c", "13h 30m", "3h 12m"],
    ["d", "16h", "4h"], ["e", "20h 06m", "2h"]].map(([id, out, back]) => row(id, 100, out, back));
  const ratings = flightRatings(rows);
  assert.deepEqual(rows.map((r) => ratings.get(r.trip_key).outbound.level), [1, 1, 2, 3, 5]);
  assert.deepEqual(rows.map((r) => ratings.get(r.trip_key).inbound.level), [1, 2, 3, 4, 1]);
  assert.equal(ratings.get("d").outbound.description, "Average · 60% longer than the shortest in this list");
});

test("only the exact best value is called the cheapest; ties share a rating regardless of order", () => {
  const rows = [row("a", 1000), row("b", 1004), row("c", 1000)];
  const ratings = flightRatings(rows);
  assert.match(ratings.get("b").price.description, /1% above the cheapest/);
  assert.equal(ratings.get("a").price.description, ratings.get("c").price.description);
  const reversed = flightRatings([...rows].reverse());
  for (const item of rows) assert.deepEqual(ratings.get(item.trip_key).price, reversed.get(item.trip_key).price);
});

test("missing and invalid data are unrated; a single value is the best", () => {
  const rows = [row("valid", 10), row("none", null, "", ""),
    row("bad", NaN, "unknown", "0h 00m"), row("negative", -5, "-1h", "")];
  const ratings = flightRatings(rows);
  assert.equal(ratings.get("valid").price.level, 1);
  for (const id of ["none", "bad", "negative"]) {
    assert.equal(ratings.get(id).price, undefined);
    assert.equal(ratings.get(id).outbound, undefined);
    assert.equal(ratings.get(id).inbound, undefined);
  }
  assert.equal(flightRatings([]).size, 0);
});

test("ratings use only the filtered list passed in and recalculate when it changes", () => {
  const rows = [row("a", 100), row("b", 130), row("c", 300)];
  assert.equal(flightRatings(rows).get("b").price.level, 3);
  assert.equal(flightRatings(rows.slice(1)).get("b").price.level, 1);
});

test("display duration parsing handles multi-day journeys and rejects unknown or zero durations", () => {
  for (const [text, expected] of [["1h 05m", 65], ["35m", 35], ["28h", 1680],
    [" 2H 30M ", 150], ["", null], ["0h 00m", null], ["unknown", null], ["1h garbage", null]]) {
    assert.equal(durationMinutes(text), expected);
  }
});
