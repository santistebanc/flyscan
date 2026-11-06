import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { digestOffers, trimPayload } from "../src/capture.js";
import { query } from "../src/models.js";
import {
  ChallengeRequired,
  parseKayak,
  parsePortal,
  RateLimited,
  RetryableError,
  Source,
  SourceError,
} from "../src/sources.js";
import {
  HttpResponse,
  PythonTransport,
  ReplayTransport,
  type Transport,
} from "../src/transport.js";
import { Q } from "./helpers.js";

function fake(answers: (HttpResponse | Error)[]) {
  let calls = 0;
  const transport: Transport = {
    open: async () => ({
      request: async () => {
        const answer = answers[calls++];
        if (answer instanceof Error) throw answer;
        if (!answer) throw new Error("unexpected request");
        return answer;
      },
      close: async () => {},
    }),
    close: async () => {},
  };
  return {
    transport,
    get calls() {
      return calls;
    },
  };
}
const response = (
  text: string,
  status = 200,
  url = "https://www.flightsfinder.com/portal/sky",
  headers: Record<string, string> = {},
) => new HttpResponse(status, url, Object.entries(headers), Buffer.from(text));
const page =
  "$.ajax({type: 'POST', url: '/portal/sky/poll', dataType: 'text', data: { 'session': 'abc123' }})";
const card =
  '<div class="list-item" data-price="12345" data-best="abc"><div class="stops"><p><span>07:00</span><span>BER</span></p><p><span>09:05</span><span>CDG</span></p></div></div>';
const poll = (flag: string, count: string, markup: string) =>
  [flag, count, "", "", "", "", markup].join("|");
for (const [name, cabin, expected] of [
  ["ff-sky", "premiumeconomy", "PremiumEconomy"],
  ["ff-kiwi", "business", "C"],
  ["ff-kayak", "premiumeconomy", "/premium/"],
  ["momondo", "business", "/business/"],
  ["jetradar", "first", "b100"],
] as const)
  test(`source URL preserves cabin: ${name} ${cabin}`, () => {
    const s = new Source(
      name,
      new ReplayTransport(resolve("../tests/recordings/ff-sky-ber-cdg")),
    );
    assert.ok(s.searchURL(query({ ...Q, cabin })).includes(expected));
  });
test("Kayak URL and payload preserve child ages and lap-infant passenger codes", () => {
  const s = new Source("ff-kayak", fake([]).transport),
    q = query({
      ...Q,
      adults: 2,
      children: 3,
      infants: 2,
      cabin: "premiumeconomy",
    });
  assert.match(s.searchURL(q), /2adults\/children-1L-1L-10-10-10/);
  const body = s.kayakBody(q);
  assert.deepEqual(body.userSearchParams.passengers, [
    "ADT",
    "ADT",
    "INL",
    "INL",
    "CHD",
    "CHD",
    "CHD",
  ]);
  assert.equal(body.userSearchParams.legs[0].cabinClass, "premium-economy");
  assert.ok(!("cabinClass" in s.kayakBody(Q).userSearchParams.legs[0]));
});
test("portal retains collected offers on a later timeout and does not restart the search", async () => {
  const f = fake([
      response(page),
      response(poll("N", "1", card)),
      new RetryableError("timeout"),
    ]),
    source = new Source("ff-sky", f.transport);
  source.pause = async () => {};
  assert.equal((await source.search(Q)).length, 1);
  assert.equal(f.calls, 3);
});
test("portal surfaces a timeout before any results instead of returning an empty success", async () => {
  const f = fake([response(page), new RetryableError("timeout")]);
  await assert.rejects(
    () => new Source("ff-sky", f.transport).search(Q),
    /timeout/,
  );
});
test("three stable result counts settle a portal even if its HTML bytes drift", async () => {
  const f = fake([
      response(page),
      ...["", " ", "  "].map((p) => response(poll("N", "1", card + p))),
    ]),
    s = new Source("ff-sky", f.transport);
  s.pause = async () => {};
  assert.equal((await s.search(Q)).length, 1);
  assert.equal(f.calls, 4);
});
test("rate limiting is never swallowed as a partial successful scrape", async () => {
  const f = fake([
      response(page),
      response(poll("N", "1", card)),
      response("limited", 429, undefined, { "Retry-After": "12" }),
    ]),
    s = new Source("ff-sky", f.transport);
  s.pause = async () => {};
  await assert.rejects(
    () => s.search(Q),
    (e) => e instanceof RateLimited && e.retryAfter === 12,
  );
});
for (const [status, headers, type] of [
  [408, {}, RetryableError],
  [500, {}, RetryableError],
  [503, { "Retry-After": "NaN" }, RateLimited],
  [404, {}, SourceError],
] as const)
  test(`HTTP ${status} has the expected failure classification`, async () => {
    const f = fake([response("failure", status, undefined, headers)]),
      s = new Source("ff-sky", f.transport),
      session = await f.transport.open();
    await assert.rejects(
      () => s.request(session, "GET", "https://example.invalid"),
      type,
    );
  });
for (const [text, url, challenge] of [
  ["<h1>Security check</h1>", "https://www.momondo.ie/security/check", true],
  ["<h1>Are you a robot</h1>", "https://www.momondo.ie/flights", true],
  ["<h1>Changed markup</h1>", "https://www.momondo.ie/flights", false],
] as const)
  test(`Kayak missing form token: ${url} ${challenge}`, async () => {
    const f = fake([response(text, 200, url)]);
    await assert.rejects(
      () => new Source("momondo", f.transport).search(Q),
      (e) =>
        challenge
          ? e instanceof ChallengeRequired
          : e instanceof SourceError && !(e instanceof ChallengeRequired),
    );
    assert.equal(f.calls, 1);
  });
test("Kayak poll challenge preserves its human verification URL", async () => {
  const f = fake([
    response('{"formtoken":"abc"}'),
    response(
      '{"captchaRedirectUrl":"https://www.momondo.ie/security/check?t=earned"}',
      403,
    ),
  ]);
  await assert.rejects(
    () => new Source("momondo", f.transport).search(Q),
    (e) => e instanceof ChallengeRequired && e.url.endsWith("?t=earned"),
  );
});
test("captured modal reference follows the card rather than its position, including after trimming", () => {
  const markup = readFileSync(
      "../tests/fixtures/ff-sky-ber-mad-modal-reference.html",
      "utf8",
    ),
    q = query({
      ...Q,
      destination: "MAD",
      depart: "2026-12-11",
      ret: "2026-12-19",
    });
  for (const html of [
    markup,
    trimPayload(Buffer.from("Y|1|0|0|0|0|" + markup), 1)
      .toString()
      .split("|")[6],
  ]) {
    const [o] = parsePortal(html, "ff-sky", q);
    assert.equal(o.price, 104);
    assert.deepEqual(
      o.itinerary.inbound!.segments.map((s) => s.flight_number),
      ["FR3009", "FR2669"],
    );
    assert.equal(
      o.itinerary.inbound!.segments[0].departure,
      o.itinerary.inbound!.departure,
    );
    assert.equal(
      o.itinerary.inbound!.segments.at(-1)!.arrival,
      o.itinerary.inbound!.arrival,
    );
  }
  const [missing] = parsePortal(
    markup.replace('id="myModal120"', 'id="unavailable"'),
    "ff-sky",
    q,
  );
  assert.deepEqual(missing.itinerary.inbound!.segments, []);
});
test("Kayak uses whole-party total prices and excludes ground transport", () => {
  const c = JSON.parse(
      readFileSync("tests/fixtures/metadata-reference.json", "utf8"),
    ).find((c: any) => c.source === "momondo"),
    payload = structuredClone(c.payload);
  payload.results[0].bookingOptions = [
    {
      providerCode: "test",
      fees: { totalPrice: { price: 450, currency: "EUR" } },
      displayPrice: { price: 150, currency: "EUR" },
    },
  ];
  assert.equal(parseKayak(payload, query(c.query), "momondo")[0].price, 450);
  Object.values(payload.segments).forEach((s: any) => {
    s.airline = "123";
    s.flightNumber = "---";
  });
  assert.deepEqual(parseKayak(payload, query(c.query), "momondo"), []);
});
test("recording digests preserve original expectations", async () => {
  for (const name of ["ff-sky-ber-cdg", "ff-kiwi-ber-cdg"]) {
    const t = new ReplayTransport(resolve("../tests/recordings", name));
    const offers = await new Source(t.index.source, t).search(
      query(t.index.query),
    );
    assert.equal(digestOffers(offers), t.index.expect.digest);
  }
});
test("replay rejects exhausted, truncated, missing and mismatched data without network fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flyscan-replay-"));
  try {
    const write = (entry: any) => {
      writeFileSync(
        join(dir, "index.json"),
        JSON.stringify({ exchanges: [entry] }),
      );
      writeFileSync(join(dir, "body"), "first");
    };
    write({
      method: "GET",
      url: "https://example.invalid?q=1",
      status: 200,
      body: "body",
    });
    let session = await new ReplayTransport(dir).open();
    await assert.rejects(
      () => session.request("GET", "https://example.invalid?q=2"),
      /mismatch/,
    );
    session = await new ReplayTransport(dir).open();
    assert.equal(
      (await session.request("GET", "https://example.invalid?q=1")).text,
      "first",
    );
    await assert.rejects(
      () => session.request("GET", "https://example.invalid?q=1"),
      /exhausted/,
    );
    write({
      method: "GET",
      url: "https://example.invalid/",
      status: 200,
      body: "body",
      truncated: true,
    });
    session = await new ReplayTransport(dir).open();
    await assert.rejects(
      () => session.request("GET", "https://example.invalid/"),
      /truncated/,
    );
    write({
      method: "GET",
      url: "https://example.invalid/",
      status: 200,
      body: "missing",
    });
    session = await new ReplayTransport(dir).open();
    await assert.rejects(
      () => session.request("GET", "https://example.invalid/"),
      /missing/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("missing Python interpreter rejects pending work and shuts down without hanging", async () => {
  const t = new PythonTransport(
    undefined,
    resolve("does-not-exist-python.exe"),
  );
  try {
    await assert.rejects(() => t.open(), /ENOENT/);
  } finally {
    await t.close();
  }
});
test("forced transport shutdown rejects active requests and releases the worker process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flyscan-worker-")),
    previous = process.env.FLYSCAN_TRANSPORT_ARGS;
  const worker = join(dir, "worker.cjs");
  writeFileSync(
    worker,
    `const readline=require('node:readline');setInterval(()=>{},1000);readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.op==='open')process.stdout.write(JSON.stringify({id:m.id,result:null})+'\\n');if(m.op==='shutdown')process.exit(0);});`,
  );
  process.env.FLYSCAN_TRANSPORT_ARGS = JSON.stringify([worker]);
  const transport = new PythonTransport(process.execPath);
  try {
    const session = await transport.open(),
      pending = assert.rejects(
        () => session.request("GET", "https://example.invalid"),
        /transport exited/,
      );
    await transport.close(true);
    await pending;
  } finally {
    await transport.close(true);
    if (previous === undefined) delete process.env.FLYSCAN_TRANSPORT_ARGS;
    else process.env.FLYSCAN_TRANSPORT_ARGS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
