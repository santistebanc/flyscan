import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { storedRow } from "../src/api.js";
import { manualItinerary } from "../src/manual.js";
import { query, queryKey, segment, tripKey } from "../src/models.js";
import { schema } from "../src/schema.js";
import { FlightStore, mergeSegments } from "../src/store.js";
import { fixture, makeOffer, Q } from "./helpers.js";

test("new databases apply released migrations once and reopen without changing data", async () => {
  const f = fixture(false);
  const path = join(f.directory, "db.sqlite");
  try {
    const store = new FlightStore(path);
    assert.equal(store.get("PRAGMA user_version")!.user_version, 2);
    store.completeFetch(store.beginFetch(Q, "ff-sky"), [makeOffer()]);
    store.close();
    const reopened = new FlightStore(path);
    assert.equal(reopened.stats().offers, 1);
    assert.equal(reopened.get("PRAGMA user_version")!.user_version, 2);
    reopened.close();
  } finally {
    await f.close();
  }
});
test("an actual Python-written database retains identical flight rows and query identities", async () => {
  const f = fixture(false);
  try {
    const reference = JSON.parse(
        readFileSync("tests/fixtures/database-reference.json", "utf8"),
      ),
      path = join(f.directory, "python.sqlite");
    writeFileSync(path, Buffer.from(reference.database, "base64"));
    const store = new FlightStore(path);
    try {
      assert.deepEqual(
        store.browse({ limit: null }).map(storedRow),
        reference.expected,
      );
      for (const [name, key] of Object.entries(reference.query_keys))
        assert.equal(queryKey(name, query(reference.query)), key);
    } finally {
      store.close();
    }
  } finally {
    await f.close();
  }
});
test("a released schema-zero database migrates and keeps quoted timestamps", async () => {
  const f = fixture(false);
  try {
    const path = join(f.directory, "old.sqlite"),
      old = new DatabaseSync(path);
    old.exec(schema);
    old.exec(
      "INSERT INTO fetches(query_key,origin,destination,depart_date,source,last_fetched) VALUES('old','BER','CDG','2027-12-21','ff-sky','2026-11-01T10:00:00+00:00');INSERT INTO trips(trip_key,origin,destination,depart_date) VALUES('old','BER','CDG','2027-12-21');INSERT INTO offers(fetch_id,trip_id,agent,price) VALUES(1,1,'agent',100)",
    );
    old.close();
    const store = new FlightStore(path);
    assert.equal(
      store.get("SELECT seen_at FROM offers")!.seen_at,
      "2026-11-01T10:00:00+00:00",
    );
    store.close();
  } finally {
    await f.close();
  }
});
test("newer database versions fail without downgrading or erasing data", async () => {
  const f = fixture(false);
  try {
    const path = join(f.directory, "future.sqlite"),
      old = new FlightStore(path);
    old.db.exec("PRAGMA user_version=999");
    old.close();
    assert.throws(() => new FlightStore(path), /newer version/);
    const db = new DatabaseSync(path);
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 999);
    db.close();
  } finally {
    await f.close();
  }
});
for (const [status, retries, age, why, fetch] of [
  ["success", 0, 1, "fresh", false],
  ["success", 0, 23.9, "fresh", false],
  ["success", 0, 24.1, "stale", true],
  ["failed", 1, 0, "retrying", true],
  ["failed", 3, 0, "retries exhausted", false],
  ["challenge", 0, 48, "needs a human", false],
  ["loading", 0, 0.01, "in flight", false],
  ["loading", 0, 1, "stuck loading", true],
] as const)
  test(`ledger plan: ${status} ${age}h old is ${why}`, async () => {
    const f = fixture();
    try {
      const id = f.store!.beginFetch(Q, "ff-sky");
      f.store!.run(
        "UPDATE fetches SET status=?,retries=?,last_fetched=? WHERE id=?",
        status,
        retries,
        new Date(Date.now() - age * 3600000).toISOString(),
        id,
      );
      const plan = f.store!.plan(Q, ["ff-sky"])["ff-sky"];
      assert.equal(plan.why, why);
      assert.equal(plan.fetch, fetch);
    } finally {
      await f.close();
    }
  });
test("completing a fetch replaces vanished offers and keeps the cheapest duplicate seller", async () => {
  const f = fixture();
  try {
    const store = f.store!,
      id = store.beginFetch(Q, "ff-sky"),
      one = makeOffer(),
      two = makeOffer(Q, 80);
    two.agent = "same";
    const three = makeOffer(Q, 90);
    three.agent = "same";
    assert.equal(store.completeFetch(id, [one, two, three]), 2);
    assert.equal(store.browse({ start: Q.depart })[0].offers[0].price, 80);
    store.completeFetch(id, [one]);
    assert.equal(store.stats().offers, 1);
  } finally {
    await f.close();
  }
});
test("failure and challenge records retain earlier offers; only a success replaces them", async () => {
  const f = fixture();
  try {
    const s = f.store!,
      id = s.beginFetch(Q, "ff-sky");
    s.completeFetch(id, [makeOffer()]);
    s.failFetch(id, "timeout");
    assert.equal(s.stats().offers, 1);
    s.challengeFetch(id, "https://example.invalid/security/check");
    assert.equal(s.stats().offers, 1);
    assert.equal(s.plan(Q, ["ff-sky"])["ff-sky"].why, "needs a human");
    s.clearChallenges("ff-sky");
    assert.equal(s.get("SELECT status FROM fetches")!.status, "pending");
  } finally {
    await f.close();
  }
});
test("failed transactions retain the previous complete set of offers", async () => {
  const f = fixture();
  try {
    const s = f.store!,
      id = s.beginFetch(Q, "ff-sky");
    s.completeFetch(id, [makeOffer()]);
    s.db.exec(
      "CREATE TRIGGER reject_offers BEFORE INSERT ON offers BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    assert.throws(() => s.completeFetch(id, [makeOffer(Q, 1)]), /test failure/);
    assert.equal(s.get("SELECT price FROM offers")!.price, 100);
  } finally {
    await f.close();
  }
});
test("party, cabin, return kind and date windows remain separate", async () => {
  const f = fixture();
  try {
    const s = f.store!,
      queries = [
        Q,
        query({ ...Q, adults: 2 }),
        query({ ...Q, cabin: "business" }),
        query({ ...Q, ret: "2027-12-25" }),
        query({ ...Q, depart: "2027-12-22" }),
      ];
    queries.forEach((q) =>
      s.completeFetch(s.beginFetch(q, "ff-sky"), [makeOffer(q)]),
    );
    assert.equal(s.browse({ start: Q.depart, end: Q.depart }).length, 1);
    assert.equal(s.browse({ start: Q.depart, end: "2027-12-22" }).length, 2);
    assert.equal(
      s.browse({
        start: Q.depart,
        end: Q.depart,
        ret: "2027-12-24",
        ret_end: "2027-12-26",
      }).length,
      1,
    );
    assert.equal(s.browse({ adults: 2, start: Q.depart }).length, 1);
    assert.equal(s.browse({ cabin: "business", start: Q.depart }).length, 1);
  } finally {
    await f.close();
  }
});
test("unlimited stored reads retain flights beyond the old 1000-row ceiling", async () => {
  const f = fixture();
  try {
    const offers = Array.from({ length: 1105 }, (_, i) => {
      const o = makeOffer(Q, i + 10);
      o.itinerary.outbound.departure = `${Q.depart}T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`;
      return o;
    });
    f.store!.completeFetch(f.store!.beginFetch(Q, "ff-sky"), offers);
    assert.equal(f.store!.browse({ limit: 25 }).length, 25);
    assert.equal(f.store!.browse({ limit: null }).length, 1105);
  } finally {
    await f.close();
  }
});
test("manual entries survive scrape refreshes and cannot modify scraped prices", async () => {
  const f = fixture();
  try {
    const s = f.store!,
      o = makeOffer(),
      fetch = s.beginFetch(Q, "ff-sky");
    s.completeFetch(fetch, [o]);
    const first = s.addManual(
        Q,
        80,
        "Agent",
        "https://example.invalid",
        tripKey(o.itinerary),
      ),
      second = s.addManual(Q, 90, "Other", "", tripKey(o.itinerary));
    assert.equal(s.stats().offers, 3);
    s.completeFetch(fetch, [makeOffer(Q, 110)]);
    assert.equal(s.stats().offers, 3);
    assert.ok(!s.updateManual(fetch, 1));
    assert.ok(!s.deleteManual(fetch));
    assert.ok(s.updateManual(first.entry_id, 75, "Updated"));
    assert.ok(s.deleteManual(second.entry_id));
    assert.equal(s.browse()[0].offers[0].price, 75);
  } finally {
    await f.close();
  }
});
test("connecting schedules contribute to identity while marketing codes do not", () => {
  const a = makeOffer().itinerary;
  a.outbound.segments = [
    segment({
      origin: "BER",
      destination: "LHR",
      departure: "2027-12-21T09:00",
      arrival: "2027-12-21T10:00",
      flight_number: "BA100",
    }),
    segment({
      origin: "LHR",
      destination: "CDG",
      departure: "2027-12-21T11:00",
      arrival: "2027-12-21T12:00",
    }),
  ];
  const b = structuredClone(a);
  b.outbound.segments[0].flight_number = "AA999";
  assert.equal(tripKey(a), tripKey(b));
  b.outbound.segments[1].departure = "2027-12-21T12:00";
  assert.notEqual(tripKey(a), tripKey(b));
});
test("segment enrichment requires matching clocks and fills only missing fields", () => {
  const s = segment({
      origin: "BER",
      destination: "LHR",
      departure: "2027-12-21T09:00",
      arrival: "2027-12-21T10:00",
    }),
    fresh = { ...s, carrier: "BA", duration_minutes: 60 };
  const merged = mergeSegments(JSON.stringify([s]), JSON.stringify([fresh]));
  assert.equal(JSON.parse(merged!)[0].carrier, "BA");
  assert.equal(
    mergeSegments(
      JSON.stringify([s]),
      JSON.stringify([{ ...fresh, arrival: "2027-12-21T10:30" }]),
    ),
    null,
  );
});
test("manual flight durations add layovers and reject backwards connections", () => {
  const p = {
    ...Q,
    outbound: [
      {
        origin: "BER",
        destination: "LHR",
        departure: "2027-12-21T09:00",
        arrival: "2027-12-21T10:00",
        duration_minutes: 120,
      },
      {
        origin: "LHR",
        destination: "CDG",
        departure: "2027-12-21T11:00",
        arrival: "2027-12-21T13:00",
        duration_minutes: 60,
      },
    ],
  };
  const i = manualItinerary(p);
  assert.equal(i.outbound.duration_minutes, 240);
  assert.equal(i.outbound.stops, 1);
  p.outbound[1].departure = "2027-12-21T09:00";
  assert.throws(() => manualItinerary(p), /before/);
});
