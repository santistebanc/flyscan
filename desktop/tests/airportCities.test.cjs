const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const path = require("node:path");
const vm = require("node:vm");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/airportCities.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const place = (code, city) => ({ code, city, name: `${code} Airport`, kind: "airport" });
function host(lookup = async code => [place(code, "City")], initial = {}) {
  let now = 1_800_000_000_000, id = 0;
  const storage = new Map(Object.entries(initial)), timers = new Map(), calls = [], writes = [];
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); writes.push(key); } },
  });
  const create = () => new mod.exports.AirportCities(query => { calls.push(query); return lookup(query); });
  return { cache: create(), create, calls, storage, writes, key: mod.exports.AIRPORT_CITIES_KEY,
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([,timer]) => timer.at <= target).sort((a,b) => a[1].at-b[1].at)[0];
        if (!next) break;
        now=next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now=target; await flush();
    } };
}
test("one autocomplete response seeds every airport and city code without guessing airport names", async () => {
  const h=host(); let changes=0;
  h.cache.subscribe(()=>changes++);
  h.cache.remember([place("LHR","London"),place("LGW","London"),
    {code:"LON",kind:"city",name:"London (all airports)"},place("XXX","")]);
  h.cache.start();h.cache.ensure(" lhr ");h.cache.ensure("LGW");
  assert.equal(h.calls.length,0);
  assert.equal(h.cache.snapshot().LHR,"London");
  assert.equal(h.cache.snapshot().LGW,"London");
  assert.equal(h.cache.snapshot().LON,"London");
  assert.equal(h.cache.snapshot().XXX,undefined);
  assert.equal(changes,1);
});
test("duplicate visible labels share an airport lookup and resolved names persist across reloads", async () => {
  const h=host(async code=>[place(code,"Paris")]);
  h.cache.start();h.cache.ensure("CDG");h.cache.ensure("CDG");await flush();
  assert.equal(h.calls.length,1);assert.equal(h.cache.snapshot().CDG,"Paris");
  await h.advance(250);
  const restored=h.create();restored.start();restored.ensure("CDG");await flush();
  assert.equal(restored.snapshot().CDG,"Paris");assert.equal(h.calls.length,1);
});

test("country metadata enriches a city-only cache only when details request it and survives reload", async () => {
  const key='flight-scraper.airport-cities-v2',now=1_800_000_000_000;
  const h=host(async code=>[{...place(code,'Berlin'),country:'Germany'}],{
    [key]:JSON.stringify({BER:{city:'Berlin',checkedAt:now}})
  });
  h.cache.start();h.cache.ensure('BER');await flush();
  assert.equal(h.calls.length,0);
  h.cache.ensure('BER',true);h.cache.ensure('BER',true);await flush();
  assert.equal(h.calls.length,1);assert.equal(h.cache.countrySnapshot().BER,'Germany');
  assert.equal(h.cache.snapshot().BER,'Berlin');
  await h.advance(250);
  const restored=h.create();restored.start();restored.ensure('BER',true);await flush();
  assert.equal(restored.countrySnapshot().BER,'Germany');assert.equal(h.calls.length,1);
});

test("missing countries retry after ten minutes without discarding a known city", async () => {
  let attempts=0;
  const h=host(async code=>[{...place(code,'Paris'),country:++attempts===1?'':'France'}]);
  h.cache.start();h.cache.ensure('CDG',true);await flush();
  assert.equal(h.cache.snapshot().CDG,'Paris');assert.equal(h.cache.countrySnapshot().CDG,undefined);
  await h.advance(599_999);assert.equal(h.calls.length,1);
  await h.advance(1);assert.equal(h.calls.length,2);assert.equal(h.cache.countrySnapshot().CDG,'France');
  h.cache.remember([place('CDG','Paris')]);
  assert.equal(h.cache.countrySnapshot().CDG,'France');
});

test("a country-only lookup enriches an existing city without guessing an airport name", async () => {
  const h=host();
  h.cache.remember([place('LHR','London')]);
  h.cache.remember([{code:'LHR',name:'Heathrow Airport',kind:'airport',country:'United Kingdom'}]);
  assert.equal(h.cache.snapshot().LHR,'London');
  assert.equal(h.cache.countrySnapshot().LHR,'United Kingdom');
});
test("an airport label retries a temporary failure while it remains mounted", async () => {
  let attempt=0;
  const h=host(async code=>{if(++attempt===1)throw new Error("Offline");return [place(code,"Chicago")];});
  h.cache.start();h.cache.ensure("ORD");await flush();
  assert.equal(h.cache.snapshot().ORD,undefined);
  await h.advance(59_999);assert.equal(h.calls.length,1);
  await h.advance(1);assert.equal(h.calls.length,2);assert.equal(h.cache.snapshot().ORD,"Chicago");
});
test("unmounting the last label stops failed-airport retries", async () => {
  const h=host(async()=>{throw new Error("Offline");});
  h.cache.start();const release=h.cache.ensure("ORD");await flush();release();
  await h.advance(20*60_000);assert.equal(h.calls.length,1);
});
test("successful misses are cached briefly and retried instead of remaining blank forever", async () => {
  let attempt=0;
  const h=host(async code=>++attempt===1?[]:[place(code,"Mexico City")]);
  h.cache.start();const release=h.cache.ensure("NLU");await flush();release();
  h.cache.ensure("NLU");await h.advance(9*60_000);assert.equal(h.calls.length,1);
  await h.advance(60_000);assert.equal(h.calls.length,2);assert.equal(h.cache.snapshot().NLU,"Mexico City");
});
test("background lookups have at most three requests in flight and skip unmounted queued labels", async () => {
  const pending=[];
  const h=host(query=>new Promise(resolve=>pending.push({query,resolve})));
  h.cache.start();for(const code of ["AAA","BBB","CCC","DDD"])h.cache.ensure(code);
  const release=h.cache.ensure("EEE");release();
  assert.equal(h.calls.length,3);
  pending[0].resolve([place("AAA","Alpha")]);await flush();assert.equal(h.calls.length,4);
  for(const item of pending.slice(1))item.resolve([place(item.query,"City")]);await flush();
  assert.ok(!h.calls.includes("EEE"));
});
test("cache writes are batched and known names remain visible while old data refreshes", async () => {
  const h=host(async code=>[place(code,"Updated")],{'flight-scraper.airport-cities':JSON.stringify({LHR:"London",BAD:5})});
  assert.equal(h.cache.snapshot().LHR,"London");
  h.cache.remember([place("CDG","Paris")]);h.cache.remember([place("ORD","Chicago")]);
  await h.advance(250);assert.equal(h.writes.length,1);
  h.cache.start();h.cache.ensure("LHR");assert.equal(h.cache.snapshot().LHR,"London");
  await flush();assert.equal(h.cache.snapshot().LHR,"Updated");
});
test("stop/start survives effect remounts and cached city names have a bounded persisted size", async () => {
  const h=host();h.cache.start();h.cache.stop();h.cache.start();h.cache.ensure("BER");await flush();
  assert.equal(h.cache.snapshot().BER,"City");
  const codes=Array.from({length:2100},(_,i)=>String.fromCharCode(65+Math.floor(i/676),65+Math.floor(i/26)%26,65+i%26));
  h.cache.remember(codes.map(code=>place(code,"City")));await h.advance(250);
  assert.ok(Object.keys(JSON.parse(h.storage.get(h.key))).length<=2048);
});
test("expired names revalidate in the background and expired misses do not survive reloads", async () => {
  const key='flight-scraper.airport-cities-v2',now=1_800_000_000_000;
  const h=host(async code=>[place(code,"Resolved")],{[key]:JSON.stringify({
    CDG:{city:"Paris",checkedAt:now-181*86_400_000},ORD:{city:null,checkedAt:now-11*60_000},
    BAD:{city:22,checkedAt:now},XXX:{city:"XXX",checkedAt:now}
  })});
  assert.equal(h.cache.snapshot().CDG,"Paris");
  assert.equal(h.cache.snapshot().BAD,undefined);assert.equal(h.cache.snapshot().XXX,undefined);
  h.cache.start();h.cache.ensure("CDG");h.cache.ensure("ORD");await flush();
  assert.equal(h.cache.snapshot().CDG,"Resolved");assert.equal(h.cache.snapshot().ORD,"Resolved");
  assert.equal(h.calls.length,2);
});
test("a reload retries cached blank labels from an older server while preserving known names", async () => {
  const key='flight-scraper.airport-cities-v2',now=1_800_000_000_000;
  const h=host(async code=>[place(code,"Paris")],{[key]:JSON.stringify({
    CDG:{city:null,checkedAt:now},NUE:{city:"Nuremberg",checkedAt:now}
  })});
  h.cache.start();h.cache.ensure("CDG");h.cache.ensure("NUE");await flush();
  assert.equal(h.cache.snapshot().CDG,"Paris");
  assert.equal(h.cache.snapshot().NUE,"Nuremberg");
  assert.deepEqual(h.calls,['CDG']);
});
