import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { query, segment, tripKey, tripPairs } from "../src/models.js";
import {
  Source,
  dateSegments,
  parseKayak,
  parseTravelpayouts,
} from "../src/sources.js";
import { OfflineTransport, ReplayTransport } from "../src/transport.js";
const root = resolve(process.cwd(), "..");
const expected = JSON.parse(
  readFileSync(resolve("tests/fixtures/parser-reference.json"), "utf8"),
);
for (const name of Object.keys(expected))
  test(`recorded source parity: ${name}`, async () => {
    const transport = new ReplayTransport(
      resolve(root, "tests/recordings", name),
    );
    const q = query(transport.index.query),
      source = new Source(transport.index.source, transport);
    const offers = await source.search(q);
    const rows = offers.map((o) => ({
      price: o.price,
      currency: o.currency,
      agent: o.agent,
      deeplink: o.deeplink,
      source_id: o.source_id,
      outbound: o.itinerary.outbound,
      inbound: o.itinerary.inbound,
      trip_key: tripKey(o.itinerary),
    }));
    assert.deepEqual(rows, expected[name]);
  });
test("clock-only segments retain westbound local dates and overnight connections", () => {
  const segments = [
    segment({ departure: "17:55", arrival: "17:50", duration_minutes: 115 }),
    segment({ departure: "01:00", arrival: "05:00", duration_minutes: 180 }),
  ];
  dateSegments(segments, "2026-12-01");
  assert.equal(segments[0].arrival, "2026-12-01T17:50");
  assert.equal(segments[1].departure, "2026-12-02T01:00");
});
test("two independent date ranges omit impossible return dates", () =>
  assert.equal(
    tripPairs("2026-12-23", "2026-12-25", "2026-12-24", "2026-12-25").length,
    5,
  ));
test("offline transport cannot open a live session", async () =>
  assert.rejects(() => new OfflineTransport().open(), /offline/));
const metadata = JSON.parse(
  readFileSync(resolve("tests/fixtures/metadata-reference.json"), "utf8"),
);
for (const c of metadata)
  test(`captured metadata parity: ${c.name}`, () => {
    const q = query(c.query),
      offers =
        c.source === "momondo"
          ? parseKayak(c.payload, q, "momondo")
          : parseTravelpayouts(c.payload, q);
    assert.deepEqual(
      offers.map((o) => ({
        outbound: o.itinerary.outbound,
        inbound: o.itinerary.inbound,
        price: o.price,
        currency: o.currency,
        agent: o.agent,
        source_id: o.source_id,
        deeplink: o.deeplink,
        trip_key: tripKey(o.itinerary),
      })),
      c.expected,
    );
  });
