const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const code = buildSync({ entryPoints: [path.join(__dirname, "../src/flightTimeline.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const { partsOf, journeyTiming, flightTimelines, percent, dayOffset, scaleClock, timingNote, localMidnights, isOvernight } = mod.exports;

test("filtered bounds shrink without reusing hidden outliers from the timing cache", () => {
  const normal = { departure: "2026-11-01T08:00", duration: "3h", segments: [] };
  const outlier = { departure: "2026-11-01T20:00", duration: "61h 36m", segments: [] };
  const all = flightTimelines([{ outbound: normal }, { outbound: outlier }]);
  const filtered = flightTimelines(Array.from({ length: 350 }, () => ({ outbound: normal })), all.journeys);
  assert.equal(filtered.outbound.min, 480);
  assert.equal(filtered.outbound.max, 660);
  assert.ok(all.outbound.max > 3 * 1440);
  assert.equal(filtered.journeys.get(normal), all.journeys.get(normal));
  assert.equal(filtered.journeys.has(outlier), false);
  assert.equal(flightTimelines([], all.journeys).outbound, null);
});
const leg = (departure, duration, extra = {}) => ({ departure, duration, arrival: "2026-11-01T09:00",
  origin_airport: "BER", destination_airport: "LHR", segments: [], ...extra });
const segmentA = { origin: "BER", destination: "LHR", departure: "2026-12-10T12:15",
  arrival: "2026-12-10T13:20", duration: "2h 05m", carrier: "AA" };
const segmentB = { origin: "LHR", destination: "DFW", departure: "2026-12-10T14:45",
  arrival: "2026-12-10T19:10", duration: "10h 25m", carrier: "AA" };

test("the captured Jetradar return keeps its flights across the MDW to ORD airport change", () => {
  const inbound = require("./fixtures/jetradar-airport-transfer.json");
  const timing = journeyTiming(inbound);
  assert.equal(timing.detailed, true, "the airport change must not hide five fully timed flights");
  assert.equal(timing.parts.length, 9);
  assert.equal(timing.parts[1].part.transfer, true);
  assert.equal(timing.parts[1].part.minutes, 1384);
  assert.equal(timing.parts[1].part.fromJourneyDuration, true);
  assert.equal(timing.parts[8].end - timing.start, 2992);
  assert.equal(timing.durationDifference, 0);
});

test("a source total mismatch retains the available flight and layover segments", () => {
  const selected = leg("2026-12-10T11:05", "32h 11m", {
    destination_airport: "SLP", arrival: "2026-12-11T12:16", segments: [
      { ...segmentA, departure: "2026-12-10T11:05", arrival: "2026-12-10T12:10" },
      { ...segmentB, departure: "2026-12-10T13:50", arrival: "2026-12-10T18:25" },
      { ...segmentA, origin: "DFW", destination: "SLP", departure: "2026-12-11T09:58",
        arrival: "2026-12-11T12:16", duration: "2h 18m" },
    ],
  });
  const timing = journeyTiming(selected);
  assert.equal(timing.detailed, true, "complete segment timing must not be hidden by a conflicting total");
  assert.equal(timing.parts.length, 5);
  assert.equal(timing.durationDifference, 10);
  assert.equal(timing.parts[4].end - timing.start, 1921);
  assert.equal(timing.end - timing.start, 1931);
  assert.match(timingNote(timing), /reported total 32h 11m, flight and layover details 32h 1m/);
});

test("shared bounds use all rows, not the first or currently visible flight", () => {
  const a = leg("2026-11-01T08:00", "2h"), b = leg("2026-11-01T06:00", "20h");
  const rows = [{ outbound: a }, ...Array.from({ length: 120 }, () => ({ outbound: a })), { outbound: b }];
  const data = flightTimelines(rows);
  assert.equal(data.outbound.min, 360);
  assert.equal(data.outbound.max, 1560);
  assert.equal(percent(data.journeys.get(a).start, data.outbound), 10);
  assert.equal(percent(data.journeys.get(a).end, data.outbound), 20);
});
test("dates normalize to the same departure day, with overnight arrivals continuing", () => {
  const a = journeyTiming(leg("2026-11-01T22:00", "29h"));
  const b = journeyTiming(leg("2026-11-19T22:00", "29h"));
  assert.equal(a.start, b.start);
  assert.equal(a.end, b.end);
  assert.equal(a.end, 3060);
  assert.equal(scaleClock(a.end), "03:00 +2");
  assert.equal(dayOffset("2026-11-01T22:00", "2026-11-03T03:00"), 2);
});
test("outbound and return have independent bounds, excluding days spent away", () => {
  const data = flightTimelines([{ outbound: leg("2026-11-01T06:00", "2h"),
    inbound: leg("2026-12-20T18:00", "3h", { origin_airport: "LHR" }) }]);
  assert.equal(data.outbound.min, 360);
  assert.equal(data.outbound.max, 480);
  assert.equal(data.inbound.min, 1080);
  assert.equal(data.inbound.max, 1260);
});
test("segment placement uses elapsed flight durations and same-airport waits", () => {
  const l = leg(segmentA.departure, "13h 55m", { segments: [segmentA, segmentB] });
  const timing = journeyTiming(l);
  assert.equal(timing.detailed, true);
  assert.equal(timing.parts[0].end - timing.parts[0].start, 125);
  assert.equal(timing.parts[1].end - timing.parts[1].start, 85);
  assert.equal(timing.parts[2].end - timing.parts[2].start, 625);
  assert.equal(timing.end, 1570); // origin-clock 02:10 +1, not destination-local 19:10
});

test("destination-local arrival clocks and intermediate departure clocks never determine flying time", () => {
  const original = leg(segmentA.departure, "13h 55m", { arrival: segmentB.arrival, segments: [segmentA, segmentB] });
  const changedClocks = { ...original, arrival: "2026-12-09T23:10-10:00", segments: [
    { ...segmentA, departure: "2026-12-10T20:15+08:00" },
    { ...segmentB, arrival: "2026-12-11T12:10+14:00" },
  ] };
  const a = journeyTiming(original), b = journeyTiming(changedClocks);
  assert.equal(b.start, a.start, "only the leg's original departure clock anchors the journey");
  assert.equal(b.end, a.end);
  assert.deepEqual(Array.from(b.parts, (p) => [p.start, p.end]), Array.from(a.parts, (p) => [p.start, p.end]));
});

test("mixed-offset and different-airport waits stay unknown rather than guessing time-zone offsets", () => {
  assert.equal(partsOf({ segments: [segmentA, { ...segmentB, departure: "2026-12-10T14:45Z" }] })[1].minutes, null);
  assert.equal(partsOf({ segments: [segmentA, { ...segmentB, origin: "JFK" }] })[1].minutes, null);
});
test("overnight waits and explicit DST offsets retain elapsed time", () => {
  const overnight = partsOf({ segments: [{ ...segmentA, arrival: "2026-12-10T19:10" },
    { ...segmentB, departure: "2026-12-11T09:58" }] });
  assert.equal(overnight[1].minutes, 888);
  const dst = partsOf({ segments: [{ ...segmentA, arrival: "2026-10-25T01:30+02:00" },
    { ...segmentB, departure: "2026-10-25T02:30+01:00" }] });
  assert.equal(dst[1].minutes, 120);
});
test("ambiguous transfers and partial durations use summary intervals", () => {
  for (const segments of [[segmentA, { ...segmentB, origin: "LGW" }, { ...segmentB, origin: "JFK" }],
    [segmentA, { ...segmentB, duration: "" }]]) {
    const timing = journeyTiming(leg(segmentA.departure, "20h", { segments }));
    assert.equal(timing.detailed, false);
    assert.equal(timing.parts.length, 1);
    assert.equal(timing.end - timing.start, 1200);
    assert.equal(timing.parts[0].part.detailed, false);
  }
});

test("airport-change time uses the journey duration without comparing airport-local clocks", () => {
  const inbound = require("./fixtures/jetradar-airport-transfer.json");
  const segments = inbound.segments.map((s) => ({ ...s }));
  // Keep known waits intact; changing either side of the airport change cannot
  // change its elapsed duration, even across time zones or a calendar day.
  segments[0].arrival = "2026-12-13T01:51+09:00";
  segments[1].departure = "2026-12-12T23:55-10:00";
  const timing = journeyTiming({ ...inbound, segments });
  assert.equal(timing.detailed, true);
  assert.equal(timing.parts[1].part.minutes, 1384);
  assert.equal(timing.parts[8].end - timing.start, 2992);
});

test("airport changes stay unknown if the remaining duration is negative or ambiguous", () => {
  const inbound = require("./fixtures/jetradar-airport-transfer.json");
  const variants = [
    { ...inbound, duration: "1h" },
    { ...inbound, duration: "" },
    { ...inbound, segments: inbound.segments.map((s, i) => i === 3 ? { ...s, origin: "MAD" } : s) },
    { ...inbound, segments: inbound.segments.map((s, i) => i === 2 ? { ...s, duration: "" } : s) },
  ];
  for (const variant of variants) {
    assert.equal(partsOf(variant)[1].minutes, null);
    assert.notEqual(journeyTiming(variant)?.detailed, true);
  }
});

test("shared bounds include detailed arrivals later than a conflicting reported total", () => {
  const outbound = leg(segmentA.departure, "5h", { segments: [segmentA, segmentB] });
  const data = flightTimelines([{ outbound }]);
  const timing = data.journeys.get(outbound);
  assert.equal(timing.detailed, true);
  assert.equal(timing.durationDifference, 300 - 835);
  assert.equal(data.outbound.max, timing.parts[2].end);
  assert.equal(percent(timing.parts[2].end, data.outbound), 100);
  assert.match(timingNote(timing), /differs by 8h 55m/);
  assert.equal(timingNote(journeyTiming(leg("2026-11-01T08:00", "2h"))), undefined);
});
test("invalid dates and unknown durations do not create arbitrary positions or bounds", () => {
  const invalid = [leg("bad", "2h"), leg("2026-02-30T08:00", "2h"),
    leg("2026-11-01T24:10", "2h"), leg("2026-11-01T08:00", "")];
  for (const l of invalid) assert.equal(journeyTiming(l), null);
  assert.equal(flightTimelines(invalid.map((outbound) => ({ outbound }))).outbound, null);
  assert.equal(flightTimelines([]).inbound, null);
});
test("new minimums and maximums expand the scale; sorting preserves it", () => {
  const rows = [{ outbound: leg("2026-11-01T10:00", "2h") }, { outbound: leg("2026-11-02T12:00", "2h") }];
  const original = flightTimelines(rows);
  const reordered = flightTimelines([...rows].reverse());
  assert.equal(JSON.stringify(original.outbound), JSON.stringify(reordered.outbound));
  const larger = flightTimelines([...rows, { outbound: leg("2026-11-03T06:00", "60h") }]);
  assert.equal(larger.outbound.min, 360);
  assert.equal(larger.outbound.max, 3960);
  assert.equal(percent(larger.journeys.get(rows[0].outbound).start, larger.outbound), 240 / 3600 * 100);
});
const midnights = (timing) => Array.from(localMidnights(timing), (m) => m.at);
const flight = (origin, destination, departure, arrival, duration) =>
  ({ origin, destination, departure, arrival, duration, carrier: "AA" });
test("midnight during a same-airport layover falls at the layover airport's 00:00", () => {
  const timing = journeyTiming(leg("2026-12-10T20:00", "6h", { segments: [
    flight("BER", "LHR", "2026-12-10T20:00", "2026-12-10T21:00", "2h"),
    flight("LHR", "DFW", "2026-12-11T00:30", "2026-12-11T01:00", "1h 30m"),
  ] }));
  // LHR arrival is 22:00 BER-clock elapsed; the LHR clock reads 21:00 there, so 00:00 is 3h later.
  assert.deepEqual(midnights(timing), [1320 + 180]);
});
test("midnight during a time-zone-changing flight follows the interpolated local clock", () => {
  // 10h airborne while the wall clock advances 6h: 00:00 is 4/6 of the way through.
  const timing = journeyTiming(leg("2026-12-10T20:00", "10h", { segments: [
    flight("BER", "DXB", "2026-12-10T20:00", "2026-12-11T02:00", "10h"),
  ] }));
  assert.deepEqual(midnights(timing), [1200 + 400]);
});
test("a westbound flight whose local clock stays before midnight has no moon", () => {
  const timing = journeyTiming(leg("2026-12-10T22:00", "10h", { segments: [
    flight("LHR", "LAX", "2026-12-10T22:00", "2026-12-10T23:30", "10h"),
  ] }));
  assert.deepEqual(midnights(timing), []);
});
test("multi-day journeys mark each local midnight, including summary-only legs", () => {
  const summary = journeyTiming(leg("2026-12-10T12:00", "49h", { arrival: "2026-12-12T13:00" }));
  // Local clock advances 49h over 49h elapsed: midnights 12h and 36h in.
  assert.deepEqual(midnights(summary), [720 + 720, 720 + 2160]);
  assert.deepEqual(Array.from(localMidnights(summary), (m) => m.label), ["Dec 11", "Dec 12"]);
  assert.deepEqual(midnights(journeyTiming(leg("bad", "2h"))  ?? { parts: [] }), []);
});

test("midnight divisions continue after a short journey across the entire shared scale", () => {
  const short = journeyTiming(leg("2026-12-10T08:00", "2h", { arrival: "2026-12-10T10:00" }));
  assert.deepEqual(midnights(short), []);
  const marks = localMidnights(short, { min: 360, max: 4320 });
  assert.deepEqual(Array.from(marks, (m) => m.at), [1440, 2880, 4320]);
  assert.deepEqual(Array.from(marks, (m) => m.label), ["Dec 11", "Dec 12", "Dec 13"]);
  assert.equal(short.end, 600, "extending guides never extends the flight itself");
});

test("empty space after arrival uses the destination's local midnight", () => {
  const timing = journeyTiming(leg("2026-12-10T22:00", "10h", { segments: [
    flight("LHR", "LAX", "2026-12-10T22:00", "2026-12-10T23:30", "10h"),
  ] }));
  const marks = localMidnights(timing, { min: 1200, max: 4000 });
  assert.deepEqual(Array.from(marks, (m) => m.at), [1950, 3390]);
  assert.deepEqual(Array.from(marks, (m) => m.label), ["Dec 11", "Dec 12"]);
});

test("empty space before departure uses the origin clock and stays within the scale", () => {
  const timing = journeyTiming(leg("2026-12-10T08:00", "2h", { arrival: "2026-12-10T10:00" }));
  const marks = localMidnights(timing, { min: -1800, max: 200 });
  assert.deepEqual(Array.from(marks, (m) => m.at), [-1440, 0]);
  assert.deepEqual(Array.from(marks, (m) => m.label), ["Dec 9", "Dec 10"]);
});

test("midnight at arrival is not duplicated and unknown arrival clocks are not guessed", () => {
  const timing = journeyTiming(leg("2026-12-10T22:00", "2h", { arrival: "2026-12-11T00:00" }));
  assert.deepEqual(Array.from(localMidnights(timing, { min: 1200, max: 2880 }), (m) => m.at), [1440, 2880]);
  const unknown = journeyTiming(leg("2026-12-10T08:00", "2h", { arrival: "" }));
  assert.deepEqual(Array.from(localMidnights(unknown, { min: 360, max: 2880 })), []);
});
test("only layovers whose local clock passes midnight are overnight", () => {
  const [, overnight] = partsOf(leg("2026-12-10T20:00", "6h", { segments: [
    flight("BER", "LHR", "2026-12-10T20:00", "2026-12-10T21:00", "2h"),
    flight("LHR", "DFW", "2026-12-11T00:30", "2026-12-11T01:00", "1h 30m"),
  ] }));
  const [, daytime] = partsOf(leg("2026-12-10T08:00", "6h", { segments: [
    flight("BER", "LHR", "2026-12-10T08:00", "2026-12-10T09:00", "2h"),
    flight("LHR", "DFW", "2026-12-10T23:30", "2026-12-11T01:00", "1h 30m"),
  ] }));
  assert.equal(isOvernight(overnight), true);
  assert.equal(isOvernight(daytime), false);
  assert.equal(isOvernight(partsOf(leg("2026-12-10T08:00", "2h"))[0]), false);
});
