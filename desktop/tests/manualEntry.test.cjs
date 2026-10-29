const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const path = require("node:path");
const { buildSync } = require("esbuild");

const bundle = buildSync({ entryPoints: [path.join(__dirname, "../src/manualEntry.ts")],
  bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(bundle, { module: mod, exports: mod.exports });
const {
  emptyDraft, parseDuration, parseFlightLine, arrivalStamp, clockMinutes, segmentPayload,
  legDrafts, addedAgo, carrierNames, onlyManual,
  itinerarySuggestions, legSuggestions, fieldOptions, draftLeg, nextDraft, segmentDraft, datedLegs, arrivalOffset,
} = mod.exports;

const segment = (number, origin, destination, departure, arrival, extra = {}) => ({
  carrier: number.slice(0, 2), carrier_name: "Ryanair", flight_number: number, origin, destination,
  departure, arrival, duration: "1h 05m", ...extra,
});
const leg = (...segments) => ({
  origin_airport: segments[0].origin, destination_airport: segments.at(-1).destination,
  departure: segments[0].departure, arrival: segments.at(-1).arrival, duration: "", stops: segments.length - 1,
  airlines: "Ryanair", flight_numbers: segments.map((s) => s.flight_number).join(","), segments,
});
const row = (key, outbound, price, inbound = null) => ({
  trip_key: key, depart_date: outbound.departure.slice(0, 10), return_date: inbound ? inbound.departure.slice(0, 10) : "",
  outbound, inbound, best: { price_base: price, source: "momondo" }, offers: [{ source: "momondo", price_base: price }],
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const draft = (fields) => ({ ...emptyDraft("2026-12-21"), ...fields });

const morning = row("morning", leg(segment("FR146", "BER", "STN", "2026-12-21T07:00", "2026-12-21T08:05")), 80);
const evening = row("evening", leg(segment("FR148", "BER", "STN", "2026-12-21T16:40", "2026-12-21T17:45")), 60);
const via = row("via", leg(segment("FR146", "BER", "DUB", "2026-12-21T07:00", "2026-12-21T08:30"),
  segment("EI152", "DUB", "LHR", "2026-12-21T09:30", "2026-12-21T10:50", { carrier_name: "Aer Lingus" })), 120);
const rows = [morning, evening, via];

test("flight times are read the ways booking pages write them", () => {
  assert.equal(parseDuration("2h 05m"), 125);
  assert.equal(parseDuration("2h"), 120);
  assert.equal(parseDuration("45 min"), 45);
  assert.equal(parseDuration("2:05"), 125);
  assert.equal(parseDuration("125"), 125);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration(""), null);
});

test("a pasted line fills a whole flight, overnight included", () => {
  assert.deepEqual({ ...parseFlightLine("FR 146 BER 16:40 → STN 17:45") },
    { flight_number: "FR146", origin: "BER", departs: "16:40", destination: "STN", arrives: "17:45" });
  assert.deepEqual({ ...parseFlightLine("lhr 9:05 - jfk 12:10 +1") },
    { origin: "LHR", departs: "09:05", destination: "JFK", arrives: "12:10", arrivesAfter: 1 });
  assert.equal(parseFlightLine("just some text"), null);
});

test("landing before the clock says you left means the next day, unless told otherwise", () => {
  const overnight = draft({ departs: "23:10", arrives: "01:20" });
  assert.equal(arrivalStamp(overnight), "2026-12-22T01:20");
  assert.equal(clockMinutes(overnight), 130);
  assert.equal(arrivalStamp({ ...overnight, arrivesAfter: 0 }), "2026-12-21T01:20");
});

test("what is sent uses the flight time when given and the clock when not, with known airline names", () => {
  const typed = draft({ flight_number: "fr 146", origin: "ber", destination: "stn", departs: "16:40", arrives: "17:45" });
  const sent = segmentPayload(typed, carrierNames(rows));
  assert.equal(sent.flight_number, "FR146");
  assert.equal(sent.carrier_name, "Ryanair");
  assert.equal(sent.origin, "BER");
  assert.equal(sent.departure, "2026-12-21T16:40");
  assert.equal(sent.duration_minutes, 65);
  assert.equal(segmentPayload({ ...typed, duration: "2h 05m" }).duration_minutes, 125);
});

const building = (fields = {}, extra = {}) => ({
  outbound: [], inbound: [], roundTrip: false, direction: "outbound", form: draft(fields), ...extra,
});
const keys = (list) => plain(list.map((r) => r.trip_key));

test("trips are suggested cheapest first and narrow as a flight number is typed, at any of their flights", () => {
  assert.deepEqual(keys(itinerarySuggestions(rows, building())), ["evening", "morning", "via"]);
  assert.deepEqual(keys(itinerarySuggestions(rows, building({ flight_number: "FR14" }))), ["evening", "morning", "via"]);
  assert.deepEqual(keys(itinerarySuggestions(rows, building({ flight_number: "FR146" }))), ["morning", "via"]);
  // The connection's number finds the trip it is part of.
  assert.deepEqual(keys(itinerarySuggestions(rows, building({ flight_number: "EI1" }))), ["via"]);
  assert.deepEqual(keys(itinerarySuggestions(rows, building({ destination: "DUB" }))), ["via"]);
  // A name on its way to being a code filters nothing yet.
  assert.deepEqual(keys(itinerarySuggestions(rows, building({ destination: "Lo" }))), ["evening", "morning", "via"]);
  assert.deepEqual(keys(itinerarySuggestions(rows, building({}, { roundTrip: true }))), []);
});

test("flights added so far must start the trip, and the next flight is suggested from what follows", () => {
  const first = segmentDraft(via.outbound.segments[0]);
  const after = building({ ...nextDraft([first]) }, { outbound: [first] });
  assert.deepEqual(keys(itinerarySuggestions(rows, after)), ["via"]);
  const legs = legSuggestions(rows, after);
  assert.deepEqual(plain(legs.map((leg) => [leg.segment.flight_number, leg.next])), [["EI152", true]]);
  assert.equal(nextDraft([first]).origin, "DUB");
  assert.equal(nextDraft([], { date: "2026-12-21" }).date, "2026-12-21");
});

test("single flights group the trips that use them, those that come next first", () => {
  const legs = legSuggestions(rows, building({ flight_number: "FR146" }));
  assert.equal(legs.length, 2, "BER→STN and BER→DUB are different flights with one number");
  const toDublin = legs.find((leg) => leg.segment.destination === "DUB");
  assert.deepEqual(keys(toDublin.rows), ["via"]);
  const later = legSuggestions(rows, building({ flight_number: "EI152" }));
  assert.deepEqual(plain(later.map((leg) => [leg.segment.flight_number, leg.next])), [["EI152", false]]);
});

test("each field suggests what the other fields allow, most common first", () => {
  const numbers = fieldOptions(rows, building({ origin: "BER" }), "flight_number");
  assert.deepEqual(plain(numbers.map((o) => [o.value, o.count])), [["FR146", 2], ["FR148", 1]]);
  // A field's own value never hides its alternatives.
  const times = fieldOptions(rows, building({ origin: "BER", departs: "07:00" }), "departs");
  assert.deepEqual(plain(times.map((o) => o.value)), ["07:00", "16:40"]);
  assert.deepEqual(plain(fieldOptions(rows, building({ flight_number: "FR148" }), "destination").map((o) => o.value)), ["STN"]);
});

test("the flights so far become a leg the timeline can draw", () => {
  const first = draft({ flight_number: "FR146", origin: "BER", destination: "DUB", departs: "07:00", arrives: "08:30" });
  const second = draft({ flight_number: "EI152", origin: "DUB", destination: "LHR", departs: "09:30", arrives: "10:50" });
  const leg = draftLeg([first, second], new Map([["EI", "Aer Lingus"]]));
  assert.equal(leg.stops, 1);
  assert.equal(leg.duration, "3h 50m");
  assert.equal(leg.airlines, "FR, Aer Lingus");
  assert.equal(draftLeg([draft({ origin: "BER" })]), null);
});

test("a stored leg turns back into drafts that describe it exactly", () => {
  const drafts = legDrafts(via.outbound);
  assert.equal(drafts.length, 2);
  assert.deepEqual(plain(drafts.map((d) => [d.flight_number, d.origin, d.destination, d.departs, d.arrives])),
    [["FR146", "BER", "DUB", "07:00", "08:30"], ["EI152", "DUB", "LHR", "09:30", "10:50"]]);
  assert.equal(drafts[0].duration, "1h 05m");
  assert.equal(legDrafts(null).length, 0);
});

test("entries say when they were added, and whether a flight is only yours", () => {
  const now = Date.parse("2026-12-10T12:00:00Z");
  assert.equal(addedAgo("2026-12-10T08:00:00+00:00", now), "today");
  assert.equal(addedAgo("2026-12-09T08:00:00+00:00", now), "yesterday");
  assert.equal(addedAgo("2026-12-01T08:00:00+00:00", now), "9 days ago");
  assert.equal(addedAgo(undefined, now), "");
  assert.equal(onlyManual({ offers: [{ source: "manual" }] }), true);
  assert.equal(onlyManual({ offers: [{ source: "manual" }, { source: "momondo" }] }), false);
});

test("each flight's day follows from the trip's date and the flight before, across a month end", () => {
  const legs = [draft({ departs: "23:00", arrives: "01:00" }), draft({ departs: "06:30", arrives: "09:00" }), draft({ departs: "08:00", arrives: "10:00" })];
  const dated = datedLegs(legs, "2026-12-31");
  assert.equal(dated[0].date, "2026-12-31", "the first flight leaves on the trip's date");
  assert.equal(arrivalStamp(dated[0]), "2027-01-01T01:00");
  assert.equal(dated[1].date, "2027-01-01", "a connection leaves the day the flight before lands");
  assert.equal(dated[2].date, "2027-01-02", "a clock earlier than the last landing is the next day");
  assert.equal(datedLegs(legs, "2027-02-10")[2].date, "2027-02-12", "a new trip date moves every flight");
});

test("the landing day comes from the times and the flight time", () => {
  assert.equal(arrivalOffset(draft({ departs: "22:00", arrives: "23:10", duration: "3h 10m" })), 0,
    "flying west, the landing clock reads less than leaving plus flying, on the same day");
  assert.equal(arrivalOffset(draft({ departs: "22:00", arrives: "01:10", duration: "3h 10m" })), 1);
  assert.equal(arrivalOffset(draft({ departs: "10:00", arrives: "14:00", duration: "11h" })), 0, "a westbound flight lands the same day");
  assert.equal(arrivalOffset(draft({ departs: "18:00", arrives: "08:00", duration: "8h" })), 1, "an eastbound overnight lands the next day");
  assert.equal(arrivalOffset(draft({ departs: "23:00", arrives: "01:00" })), 1, "without a flight time, a clock going backwards is the next day");
  assert.equal(arrivalOffset(draft({ departs: "09:00", arrives: "11:00" })), 0);
});
