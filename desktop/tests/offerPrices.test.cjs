const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/offerPriceOverrides.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { offerPriceKey, applyPriceOverrides, sanitizePriceOverrides, correctionFor, upgradeLegacyOverrides } = mod.exports;
const scope = '[1,0,0,"economy"]';
const seen = "2026-10-01T08:00:00+00:00";
const later = "2026-10-02T08:00:00+00:00";
const at = "2026-10-01T09:00:00.000Z";
const a = { source: "momondo", agent: "Agent A", price_base: 100, price: 110, currency: "USD", seen_at: seen };
const b = { source: "jetradar", agent: "Agent B", price_base: 120, price: 120, currency: "EUR", seen_at: seen };
const row = { trip_key: "trip", offers: [a,b], best: a, spread: 20 };
const plain = (value) => JSON.parse(JSON.stringify(value));

test("correcting one offer recalculates the best fare and spread without losing source quotes", () => {
  const overrides = { [offerPriceKey(scope, row.trip_key, a)]: correctionFor(a, 300, at) };
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
  assert.equal(corrected.corrected_at, at);
  assert.equal(row.best.price_base, 100, "raw results stay immutable");
});

test("a correction holds while the source has not quoted again, in any currency", () => {
  const saved = plain({ [offerPriceKey(scope, "trip", a)]: correctionFor(a, 80, at) });
  const reloaded = { ...row, offers: [{ ...a, price: 100, currency: "EUR" }, b] };
  assert.equal(applyPriceOverrides([reloaded],scope,saved)[0].best.price_base, 80, "a stored copy of the same quote");
  assert.equal(applyPriceOverrides([reloaded],scope,{})[0], reloaded);
});

test("a fresher source quote wins, and the correction is kept to reapply", () => {
  const saved = { [offerPriceKey(scope, "trip", a)]: correctionFor(a, 30, at) };
  const requoted = { ...a, price_base: 130, seen_at: later };
  const result = applyPriceOverrides([{ ...row, offers: [requoted, b] }],scope,saved)[0];
  const offer = result.offers.find((o) => o.source === "momondo");
  assert.equal(offer.price_base, 130, "even a dearer quote outranks a cheaper correction");
  assert.equal(offer.stale_price_base, 30);
  assert.equal(offer.corrected_at, at);
  assert.equal(offer.manual_price, undefined);
  assert.equal(result.best.source, "jetradar");
  const reapplied = { [offerPriceKey(scope, "trip", a)]: correctionFor(requoted, 30) };
  assert.equal(applyPriceOverrides([{ ...row, offers: [requoted, b] }],scope,reapplied)[0].best.price_base, 30);
});

test("version 1 corrections carry no quote date, so they arrive set aside", () => {
  const upgraded = upgradeLegacyOverrides({ [offerPriceKey(scope, "trip", a)]: 80, "[bad]": -1 }, at);
  assert.equal(Object.keys(upgraded).length, 1);
  const offer = applyPriceOverrides([row],scope,upgraded)[0].offers.find((o) => o.source === "momondo");
  assert.equal(offer.price_base, 100);
  assert.equal(offer.stale_price_base, 80);
});

test("party, cabin, itinerary, source and seller keep independent corrections", () => {
  const saved = { [offerPriceKey(scope,"trip",a)]:correctionFor(a,80,at) };
  for(const other of ['[2,0,0,"economy"]','[1,0,0,"business"]']) assert.equal(applyPriceOverrides([row],other,saved)[0],row);
  assert.equal(applyPriceOverrides([{...row,trip_key:"other"}],scope,saved)[0].best.price_base,100);
  assert.equal(offerPriceKey(scope,"trip",a),offerPriceKey(scope,"trip",{...a,agent:" agent a "}));
  assert.notEqual(offerPriceKey(scope,"trip",a),offerPriceKey(scope,"trip",b));
});

test("invalid stored corrections cannot inject free, negative or nonfinite fares", () => {
  for(const raw of [null,[],"bad"]) assert.equal(Object.keys(sanitizePriceOverrides(raw)).length,0);
  const entry=(price)=>({price,at,quoteSeenAt:seen});
  const clean=sanitizePriceOverrides({'[valid]':entry(123),'[zero]':entry(0),'[negative]':entry(-5),'[bad]':entry(NaN),
    '[infinite]':entry(Infinity),'wrong':entry(8),'[bare]':8,'[undated]':{price:5,quoteSeenAt:seen},
    '[unknown quote]':{price:7,at,quoteSeenAt:"soon"}});
  assert.deepEqual(plain(clean),{'[valid]':entry(123),'[unknown quote]':{price:7,at,quoteSeenAt:null}});
});
