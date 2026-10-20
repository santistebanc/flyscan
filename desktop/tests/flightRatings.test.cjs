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

test("prices and each journey direction receive five independent relative ratings", () => {
  const rows = [1, 2, 3, 4, 5].map((i) => row(String(i), i * 100, `${6 - i}h 00m`, `${i}h 00m`));
  const ratings = flightRatings(rows);
  for (let i = 1; i <= 5; i++) {
    const result = ratings.get(String(i));
    assert.equal(result.price.level, i);
    assert.equal(result.outbound.level, 6 - i);
    assert.equal(result.inbound.level, i);
  }
  assert.equal(ratings.get("1").price.description, "Excellent · Lowest prices in this list");
  assert.equal(ratings.get("1").outbound.description, "Poor · Longest journeys in this list");
});

test("ratings use the actual min/max range, with equal ratings for ties regardless of sorting", () => {
  const rows = [10, 20, 30, 40, 1000000, 10].map((price, i) => row(String(i), price));
  const ratings = flightRatings(rows);
  assert.equal(ratings.get("0").price.level, ratings.get("5").price.level);
  assert.equal(ratings.get("3").price.level, 1);
  assert.equal(ratings.get("4").price.level, 5);
  const reversed = flightRatings([...rows].reverse());
  for (const item of rows) assert.equal(ratings.get(item.trip_key).price.level, reversed.get(item.trip_key).price.level);
});

test("new minimums and maximums immediately rescale existing prices and durations", () => {
  const rows = [row("a", 100, "1h"), row("b", 200, "2h"), row("c", 300, "3h")];
  assert.equal(flightRatings(rows).get("b").price.level, 3);
  const higher = flightRatings([...rows, row("new-max", 1000, "10h")]);
  assert.equal(higher.get("b").price.level, 1);
  assert.equal(higher.get("b").outbound.level, 1);
  const lower = flightRatings([...rows.slice(1), row("new-min", 50, "30m")]);
  assert.equal(lower.get("b").price.level, 4);
  assert.equal(lower.get("b").outbound.level, 4);
});

test("missing and invalid data are unrated; a single value or equal list uses the middle tier", () => {
  const rows = [row("valid", 10), row("tie", 10), row("none", null, "", ""),
    row("bad", NaN, "unknown", "0h 00m"), row("negative", -5, "-1h", "")];
  const ratings = flightRatings(rows);
  assert.equal(ratings.get("valid").price.level, 3);
  assert.match(ratings.get("valid").price.description, /No price difference/);
  for (const id of ["none", "bad", "negative"]) {
    assert.equal(ratings.get(id).price, undefined);
    assert.equal(ratings.get(id).outbound, undefined);
    assert.equal(ratings.get(id).inbound, undefined);
  }
  assert.equal(flightRatings([]).size, 0);
});

test("ratings use only the filtered list passed in and recalculate when it changes", () => {
  const rows = [row("a", 10), row("b", 20), row("c", 30)];
  assert.equal(flightRatings(rows).get("b").price.level, 3);
  assert.equal(flightRatings(rows.slice(1)).get("b").price.level, 1);
  assert.equal(flightRatings(rows.slice(0, 2)).get("b").price.level, 5);
});

test("display duration parsing handles multi-day journeys and rejects unknown or zero durations", () => {
  for (const [text, expected] of [["1h 05m", 65], ["35m", 35], ["28h", 1680],
    [" 2H 30M ", 150], ["", null], ["0h 00m", null], ["unknown", null], ["1h garbage", null]]) {
    assert.equal(durationMinutes(text), expected);
  }
});
