import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ChallengeCookies } from "../src/challenges.js";
import {
  ErrorLog,
  Places,
  RateTable,
  Rates,
  atomicJSON,
} from "../src/support.js";
import { HttpResponse, type Transport } from "../src/transport.js";
import { fixture } from "./helpers.js";
import { roundMoney } from "../src/models.js";
test("price rounding retains Python behavior at binary and decimal half-cent boundaries", () => {
  for (const [amount, expected] of [
    [1.005, 1],
    [2.675, 2.67],
    [2.625, 2.62],
    [2.375, 2.38],
    [-2.625, -2.62],
  ])
    assert.equal(roundMoney(amount), expected);
});
test("durable clearance filtering preserves scoped cookies and can restore the original jar", async () => {
  const f = fixture(false);
  try {
    const cookies = new ChallengeCookies(join(f.directory, "cookies"));
    cookies.save(
      "momondo",
      [
        { name: "durable", value: "a", domain: ".momondo.ie", path: "/" },
        {
          name: "session",
          value: "b",
          domain: ".momondo.ie",
          path: "/flights",
        },
      ],
      "url",
      ["durable"],
    );
    assert.ok(cookies.narrow("momondo"));
    assert.deepEqual(
      cookies.load("momondo").map((c) => c.name),
      ["durable"],
    );
    assert.equal(cookies.load("momondo")[0].domain, ".momondo.ie");
    assert.ok(!cookies.narrow("momondo"));
    assert.ok(cookies.restore("momondo"));
    assert.equal(cookies.load("momondo").length, 2);
  } finally {
    await f.close();
  }
});
test("legacy dictionary clearance loads and expires using the original timestamp", async () => {
  const f = fixture(false);
  try {
    const c = new ChallengeCookies(join(f.directory, "cookies"));
    atomicJSON(join(c.path, "momondo.json"), {
      cookies: { earned: "value" },
      solved_at: new Date().toISOString(),
    });
    assert.deepEqual(c.load("momondo"), [{ name: "earned", value: "value" }]);
    atomicJSON(join(c.path, "momondo.json"), {
      cookies: { earned: "value" },
      solved_at: "2000-01-01T00:00:00Z",
    });
    assert.deepEqual(c.load("momondo"), []);
  } finally {
    await f.close();
  }
});
test("rates convert missing currencies to null and never invent a comparable price", () => {
  const rates = new RateTable("EUR", { USD: 2 });
  assert.equal(rates.convert(100, "USD"), 50);
  assert.equal(rates.convert(100, "EUR"), 100);
  assert.equal(rates.convert(100, "XXX"), null);
  assert.equal(rates.convert(null, "EUR"), null);
});
test("offline rates reuse the previous on-disk table even when stale", async () => {
  const f = fixture(false);
  const original = process.env.FLYSCAN_OFFLINE;
  process.env.FLYSCAN_OFFLINE = "1";
  try {
    const path = join(f.directory, "fx.json");
    atomicJSON(path, {
      EUR: {
        base: "EUR",
        rates: { USD: 2 },
        fetched_at: "2000-01-01T00:00:00Z",
        provider: "fixture",
      },
    });
    assert.equal(
      (await new Rates(f.transport, path).get()).convert(100, "USD"),
      50,
    );
  } finally {
    if (original === undefined) delete process.env.FLYSCAN_OFFLINE;
    else process.env.FLYSCAN_OFFLINE = original;
    await f.close();
  }
});
test("place codes and legacy cached resolutions need no transport requests", async () => {
  const f = fixture(false);
  try {
    const path = join(f.directory, "places.json"),
      places = new Places(f.transport, path);
    assert.equal((await places.resolve(" ber ")).code, "BER");
    atomicJSON(path, {
      "city|berlin": {
        code: "BER",
        name: "Berlin",
        country: "Germany",
        kind: "city",
        city: "Berlin",
        detail: "",
      },
    });
    assert.equal((await places.resolve("Berlin")).country, "Germany");
  } finally {
    await f.close();
  }
});
test("autocomplete preserves city and country metadata and deduplicates place codes", async () => {
  const f = fixture(false);
  let closed = false;
  const transport: Transport = {
    open: async () => ({
      request: async () =>
        new HttpResponse(
          200,
          "https://example.invalid",
          [],
          Buffer.from(
            JSON.stringify([
              {
                code: "BER",
                name: "Berlin",
                country_name: "Germany",
                type: "city",
              },
              { code: "BER", name: "Airport Berlin", type: "airport" },
              {
                code: "LHR",
                name: "Heathrow",
                type: "airport",
                city_name: "London",
                country_name: "United Kingdom",
              },
            ]),
          ),
        ),
      close: async () => {
        closed = true;
      },
    }),
    close: async () => {},
  };
  try {
    const places = await new Places(
      transport,
      join(f.directory, "cache"),
    ).search("ber");
    assert.equal(places.length, 2);
    assert.equal(places[0].city, "Berlin");
    assert.equal(places[1].country, "United Kingdom");
    assert.ok(closed);
  } finally {
    await f.close();
  }
});
test("unwritable error logs never throw while reporting another failure", async () => {
  const f = fixture(false);
  try {
    const file = join(f.directory, "file");
    writeFileSync(file, "a regular file");
    const log = new ErrorLog(join(file, "errors.jsonl"));
    assert.equal(typeof log.record("test", new Error("original")), "string");
  } finally {
    await f.close();
  }
});
