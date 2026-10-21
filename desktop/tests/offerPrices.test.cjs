const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/offerPriceOverrides.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { offerPriceKey, applyPriceOverrides, sanitizePriceOverrides } = mod.exports;
const scope = '[1,0,0,"economy"]';
const a = { source: "momondo", agent: "Agent A", price_base: 100, price: 110, currency: "USD" };
const b = { source: "jetradar", agent: "Agent B", price_base: 120, price: 120, currency: "EUR" };
const row = { trip_key: "trip", offers: [a,b], best: a, spread: 20 };

test("correcting one offer recalculates the best fare and spread without losing source quotes", () => {
  const overrides = { [offerPriceKey(scope, row.trip_key, a)]: 300 };
  const result = applyPriceOverrides([row], scope, overrides)[0];
  assert.equal(result.best.source, "jetradar");
  assert.equal(result.best.price_base, 120);
  assert.equal(result.spread, 180);
  const corrected = result.offers.find((offer) => offer.source === "momondo");
  assert.equal(corrected.price, 110);
  assert.equal(corrected.currency, "USD");
  assert.equal(corrected.price_base, 300);
  assert.equal(corrected.original_price_base, 100);
  assert.equal(corrected.manual_price, true);
  assert.equal(row.best.price_base, 100, "raw results stay immutable");
});

test("corrections survive source refreshes and restore to the latest quote", () => {
  const saved = JSON.parse(JSON.stringify({ [offerPriceKey(scope, "trip", a)]: 80 }));
  const next = { ...row, offers: [{...a, price_base: 115},b] };
  assert.equal(applyPriceOverrides([next],scope,saved)[0].best.price_base,80);
  assert.equal(applyPriceOverrides([next],scope,{})[0],next);
});

test("party, cabin, itinerary, source and seller keep independent corrections", () => {
  const saved = { [offerPriceKey(scope,"trip",a)]:80 };
  for(const other of ['[2,0,0,"economy"]','[1,0,0,"business"]']) assert.equal(applyPriceOverrides([row],other,saved)[0],row);
  assert.equal(applyPriceOverrides([{...row,trip_key:"other"}],scope,saved)[0].best.price_base,100);
  assert.equal(offerPriceKey(scope,"trip",a),offerPriceKey(scope,"trip",{...a,agent:" agent a "}));
  assert.notEqual(offerPriceKey(scope,"trip",a),offerPriceKey(scope,"trip",b));
});

test("invalid stored corrections cannot inject free, negative or nonfinite fares", () => {
  for(const raw of [null,[],"bad"]) assert.equal(Object.keys(sanitizePriceOverrides(raw)).length,0);
  const clean=sanitizePriceOverrides({'[valid]':123,'[zero]':0,'[negative]':-5,'[bad]':NaN,'[infinite]':Infinity,'wrong':8});
  assert.equal(Object.keys(clean).length,1);
  assert.equal(clean['[valid]'],123);
});
