import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { App } from "../src/api.js";
import { belongsTo } from "../src/models.js";
import { EventLog, parseParams } from "../src/searches.js";
import { allowedSources, ChallengeRequired } from "../src/sources.js";
import { Places } from "../src/support.js";
import { eventually, FakeSource, fixture, makeOffer, Q } from "./helpers.js";

async function api() {
  const f = fixture(),
    places = new Places(f.transport, join(f.directory, "places.json")),
    frontend = join(f.directory, "frontend");
  mkdirSync(frontend);
  writeFileSync(
    join(frontend, "index.html"),
    "<h1>Offline frontend fixture</h1>",
  );
  const app = new App(f.scheduler, places, frontend),
    server = app.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = async (
    path: string,
    method = "GET",
    body?: any,
    headers: Record<string, string> = {},
  ) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: r.status, data, headers: r.headers };
  };
  return {
    ...f,
    app,
    server,
    base,
    request,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await f.close();
    },
  };
}
const params = {
  origin: "BER",
  destination: "CDG",
  start: Q.depart,
  sources: ["ff-sky"],
};
test("invalid search and manual-flight inputs return client errors without starting work", async () => {
  const f = await api();
  try {
    for (const body of [{ ...params, start: "not-a-date" }, [], null])
      assert.equal((await f.request("/v1/searches", "POST", body)).status, 400);
    assert.equal(
      (await f.request("/v1/jobs", "POST", { source: "ff-sky" })).status,
      400,
    );
    assert.equal(
      (
        await f.request("/v1/manual-offers", "POST", {
          ...Q,
          price: 100,
          outbound: [
            {
              origin: "BADCODE",
              destination: "CDG",
              departure: "invalid",
              arrival: "invalid",
            },
          ],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request("/v1/manual-offers", "POST", {
          ...Q,
          price: 100,
          trip_key: "missing",
        })
      ).status,
      404,
    );
    assert.equal(f.scheduler.snapshot().submitted, 0);
  } finally {
    await f.close();
  }
});
test("API session headers authenticate all endpoints; URL keys only authenticate SSE", async () => {
  const old = process.env.FLYSCAN_API_KEY;
  process.env.FLYSCAN_API_KEY = "test-session";
  const f = await api();
  try {
    assert.equal((await f.request("/v1/health")).status, 401);
    assert.equal(
      (await f.request("/v1/health?api_key=test-session")).status,
      401,
    );
    assert.equal(
      (
        await f.request("/v1/health", "GET", undefined, {
          Authorization: "Bearer wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request("/v1/health", "GET", undefined, {
          Authorization: "Bearer test-session",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("/v1/health", "GET", undefined, {
          "X-API-Key": "test-session",
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/v1/searches/missing/events?api_key=test-session"))
        .status,
      404,
    );
    assert.equal((await f.request("/v1/health", "OPTIONS")).status, 204);
  } finally {
    await f.close();
    if (old === undefined) delete process.env.FLYSCAN_API_KEY;
    else process.env.FLYSCAN_API_KEY = old;
  }
});
test("stored flight reads are offline, complete and have the existing frontend contract", async () => {
  const f = await api();
  try {
    const s = f.store!,
      o = makeOffer();
    s.completeFetch(s.beginFetch(Q, "ff-sky"), [o]);
    const r = await f.request(
      `/v1/flights?origin=BER&destination=CDG&start=${Q.depart}&limit=0`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.data.count, 1);
    assert.equal(r.data.results[0].best.price_base, 100);
    assert.equal(r.data.results[0].outbound.duration, "2h 00m");
    assert.equal(r.data.results[0].best.currency, "EUR");
    assert.equal(
      r.data.last_seen,
      s.get("SELECT last_fetched FROM fetches")!.last_fetched,
    );
    assert.equal((await f.request("/v1/flights?limit=-1")).status, 400);
    assert.equal((await f.request("/v1/flights?adults=NaN")).status, 400);
  } finally {
    await f.close();
  }
});
test("search lifecycle streams partial and complete rows and emits exactly one terminal event", async () => {
  const f = await api();
  f.scheduler.sourceFactory = (name) => new FakeSource(name);
  try {
    const r = await f.request("/v1/searches", "POST", params);
    assert.equal(r.status, 202);
    const id = r.data.search_id;
    await eventually(() => !!f.app.searches.get(id)?.done);
    const result = await f.request(`/v1/searches/${id}/results`);
    assert.equal(result.data.count, 1);
    const job = f.app.searches.get(id)!,
      events = job.log.snapshot();
    assert.equal(events.filter((e) => e.event === "done").length, 1);
    assert.ok(events.some((e) => e.event === "day_partial"));
    assert.ok(events.some((e) => e.event === "day_done"));
    const stream = await f.request(
      `/v1/searches/${id}/events?after=${events.at(-2)!.seq}`,
    );
    assert.equal(stream.status, 200);
    assert.match(stream.data, /"event":"done"/);
    assert.doesNotMatch(stream.data, /"event":"day_done"/);
    assert.equal((await f.request(`/v1/searches/${id}`)).data.status, "done");
  } finally {
    await f.close();
  }
});
test("identical active searches join, forced searches get separate subscriptions", async () => {
  const f = await api();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.scheduler.sourceFactory = (name) =>
    new FakeSource(name, async (q) => {
      await gate;
      return [makeOffer(q)];
    });
  try {
    const first = await f.request("/v1/searches", "POST", params),
      second = await f.request("/v1/searches", "POST", params),
      forced = await f.request("/v1/searches", "POST", {
        ...params,
        force: true,
      });
    assert.equal(second.status, 200);
    assert.equal(second.data.search_id, first.data.search_id);
    assert.notEqual(forced.data.search_id, first.data.search_id);
    release();
    await eventually(() => f.app.searches.get(forced.data.search_id)!.done);
  } finally {
    release();
    await f.close();
  }
});
test("cancelling before search startup performs no source work and finishes once", async () => {
  const f = await api();
  let calls = 0;
  f.scheduler.sourceFactory = (name) =>
    new FakeSource(name, async () => {
      calls++;
      return [];
    });
  try {
    const { job } = f.app.searches.start(parseParams(params, f.scheduler));
    job.cancel();
    await job.run();
    assert.equal(calls, 0);
    assert.equal(job.status, "cancelled");
    assert.equal(
      job.log.snapshot().filter((e) => e.event === "done").length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("failed admission cancels previously admitted subscriptions", async () => {
  const f = await api();
  f.scheduler.maxPending = 1;
  f.scheduler.challenges.record(
    "momondo",
    "https://www.momondo.ie/security/check",
  );
  try {
    const r = await f.request("/v1/searches", "POST", {
      ...params,
      end: "2027-12-22",
      sources: ["momondo"],
    });
    await eventually(() => f.app.searches.get(r.data.search_id)!.done);
    assert.equal(f.app.searches.get(r.data.search_id)!.status, "failed");
    assert.ok(
      f.scheduler
        .jobs()
        .every((j) => ["done", "cancelled", "failed"].includes(j.state)),
    );
  } finally {
    await f.close();
  }
});
test("API challenge cookies resume the blocked source and persist scoped clearance", async () => {
  const f = await api();
  const s = new FakeSource("momondo", async (q) => {
    if (s.calls === 1)
      throw new ChallengeRequired(
        "https://www.momondo.ie/security/check",
        "momondo",
      );
    return [makeOffer(q, 100, "momondo")];
  });
  f.scheduler.sourceFactory = () => s;
  try {
    const result = await f.request("/v1/jobs", "POST", {
      ...Q,
      source: "momondo",
    });
    assert.equal(result.status, 202);
    await eventually(() => !!f.scheduler.challenges.pending().momondo);
    assert.equal(
      (await f.request("/v1/challenges")).data.pending[0].source,
      "momondo",
    );
    assert.equal(
      (
        await f.request("/v1/challenges/momondo/cookies", "POST", {
          cookies: [],
        })
      ).status,
      400,
    );
    const clear = await f.request("/v1/challenges/momondo/cookies", "POST", {
      cookies: [
        {
          name: "clearance",
          value: "earned",
          domain: ".momondo.ie",
          path: "/",
        },
      ],
    });
    assert.equal(clear.data.cleared, true);
    await eventually(() => f.scheduler.find(result.data.id)!.state === "done");
    assert.equal(
      f.scheduler.challenges.cookies.load("momondo")[0].domain,
      ".momondo.ie",
    );
  } finally {
    await f.close();
  }
});
test("manual price endpoints edit only manual offers and preserve frontend shapes", async () => {
  const f = await api();
  try {
    const input = {
      origin: "BER",
      destination: "CDG",
      price: 95,
      agent: "Agent",
      outbound: [
        {
          origin: "BER",
          destination: "CDG",
          departure: Q.depart + "T09:00",
          arrival: Q.depart + "T11:00",
          flight_number: "AF123",
          duration_minutes: 120,
        },
      ],
    };
    const added = await f.request("/v1/manual-offers", "POST", input);
    assert.equal(added.status, 201);
    assert.equal(
      (
        await f.request(`/v1/manual-offers/${added.data.entry_id}`, "PATCH", {
          price: 80,
          agent: "Changed",
        })
      ).status,
      200,
    );
    const flights = await f.request("/v1/flights?start=" + Q.depart);
    assert.equal(flights.data.results[0].best.source, "manual");
    assert.equal(flights.data.results[0].best.price, 80);
    assert.equal(flights.data.results[0].best.entry_id, added.data.entry_id);
    assert.equal(
      (await f.request(`/v1/manual-offers/${added.data.entry_id}`, "DELETE"))
        .status,
      200,
    );
    assert.equal(
      (await f.request(`/v1/manual-offers/${added.data.entry_id}`, "DELETE"))
        .status,
      404,
    );
  } finally {
    await f.close();
  }
});
test("diagnostics merge context without duplicate-stack failures and can be read and cleared", async () => {
  const f = await api();
  try {
    const r = await f.request("/v1/errors", "POST", {
      where: "results",
      message: "oops",
      stack: "outside",
      context: { stack: "inside", value: 1 },
    });
    assert.equal(r.status, 202);
    const read = await f.request("/v1/errors");
    assert.equal(read.data.errors[0].context.stack, "inside");
    assert.equal(read.data.summary[0].count, 1);
    assert.equal((await f.request("/v1/errors", "DELETE")).data.cleared, 1);
  } finally {
    await f.close();
  }
});
test("static frontend is served without exposing paths outside its directory", async () => {
  const f = await api();
  try {
    assert.match((await f.request("/")).data, /Offline frontend fixture/);
    assert.equal((await f.request("/%2e%2e%2fpackage.json")).status, 404);
  } finally {
    await f.close();
  }
});
test("hosted mode restricts sources, writes, diagnostics, database paths and wide ranges", async () => {
  const old = process.env.FLYSCAN_MODE;
  process.env.FLYSCAN_MODE = "web";
  const f = await api();
  try {
    assert.deepEqual(allowedSources(), ["ff-sky", "ff-kiwi", "jetradar"]);
    assert.equal((await f.request("/v1/version")).data.mode, "web");
    assert.equal((await f.request("/v1/errors")).status, 403);
    assert.equal((await f.request("/v1/flights?db=other.db")).status, 400);
    assert.equal(
      (await f.request("/v1/manual-offers", "POST", {})).status,
      403,
    );
    assert.equal(
      (
        await f.request("/v1/searches", "POST", params, {
          Origin: "https://other.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/v1/searches", "POST", {
          ...params,
          end: "2028-02-01",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request("/v1/searches", "POST", {
          ...params,
          sources: ["momondo"],
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.request("/v1/flights?start=2027-01-01&end=2028-01-01")).status,
      400,
    );
    assert.equal(
      (await f.request("/v1/health")).headers.get(
        "access-control-allow-origin",
      ),
      null,
    );
    assert.equal((await f.request("/download/private.csv")).status, 403);
  } finally {
    await f.close();
    if (old === undefined) delete process.env.FLYSCAN_MODE;
    else process.env.FLYSCAN_MODE = old;
  }
});
test("event logs replay independently, retain monotonic sequences, and ignore writes after close", () => {
  const log = new EventLog(2);
  log.append({ event: "one" });
  log.append({ event: "two" });
  log.append({ event: "three" });
  const a: any[] = [],
    b: any[] = [];
  const ua = log.subscribe(1, (e) => a.push(e)),
    ub = log.subscribe(2, (e) => b.push(e));
  log.append({ event: "four" });
  log.close();
  log.append({ event: "five" });
  ua();
  ub();
  assert.deepEqual(
    a.filter(Boolean).map((e) => e.seq),
    [2, 3, 4],
  );
  assert.deepEqual(
    b.filter(Boolean).map((e) => e.seq),
    [3, 4],
  );
  assert.equal(a.at(-1), null);
  assert.equal(log.lastSeq, 4);
});
for (const [changes, expected] of [
  [{}, true],
  [{ depart: "2027-12-20" }, false],
  [{ ret: "2027-12-25" }, false],
  [{ adults: 2 }, false],
  [{ currency: "USD" }, false],
] as const)
  test("query membership " + JSON.stringify(changes), () => {
    assert.equal(
      belongsTo(
        {
          route: "BER-CDG",
          depart: Q.depart,
          ret: "",
          adults: 1,
          children: 0,
          infants: 0,
          cabin: "economy",
          currency: "EUR",
          ...changes,
        },
        {
          origin: " ber ",
          destination: "cdg",
          start: Q.depart,
          adults: "1",
          children: "0",
          infants: "0",
        },
      ),
      expected,
    );
  });
test("the grouped queue view leaves out the flat job list", async () => {
  const f = await api();
  try {
    await f.scheduler.submit(new FakeSource("ff-sky"), Q).result;
    const full = (await f.request("/v1/jobs")).data,
      grouped = (await f.request("/v1/jobs?view=groups")).data;
    assert.equal(full.jobs.length, 1);
    assert.equal(grouped.jobs, undefined);
    assert.deepEqual(
      grouped.query_jobs.map((g: any) => g.sources.length),
      full.query_jobs.map((g: any) => g.sources.length),
    );
    assert.equal(grouped.scheduler.done, 1);
  } finally {
    await f.close();
  }
});
test("progress events carry only rows that changed, and day_done the full set", async () => {
  const f = await api();
  // Jetradar answers last with nothing new, so its event repeats no rows.
  f.scheduler.sourceFactory = (name) =>
    name === "jetradar"
      ? new FakeSource(name, async () => {
          await new Promise((r) => setTimeout(r, 50));
          return [];
        })
      : new FakeSource(name);
  try {
    const r = await f.request("/v1/searches", "POST", {
      origin: Q.origin,
      destination: Q.destination,
      start: Q.depart,
      sources: ["ff-sky", "jetradar"],
    });
    const id = r.data.search_id;
    await eventually(() => !!f.app.searches.get(id)?.done);
    const events = f.app.searches.get(id)!.log.snapshot(),
      partials = events.filter((e) => e.event === "day_partial"),
      done = events.find((e) => e.event === "day_done")!;
    assert.equal(partials.length, 2);
    assert.equal(partials[0].rows.length, 1);
    assert.equal(partials[1].rows.length, 0);
    assert.equal(partials[1].shown, 1);
    assert.equal(done.rows.length, 1);
  } finally {
    await f.close();
  }
});
