import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { query } from "../src/models.js";
import { QueueFull } from "../src/scheduler.js";
test("an unexpected transient failure retains the source default retry budget", async () => {
  const f = fixture(false),
    source = new FakeSource("ff-sky", async (q) => {
      if (source.calls === 1) throw new Error("temporary malformed response");
      return [makeOffer(q)];
    });
  try {
    assert.equal((await f.scheduler.submit(source, Q).result).offers.length, 1);
    assert.equal(source.calls, 2);
  } finally {
    await f.close();
  }
});
test("queue capacity includes occupied attempts", async () => {
  const f = fixture(false);
  f.scheduler.maxPending = 1;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    source = new FakeSource("ff-sky", async () => {
      await gate;
      return [];
    });
  try {
    const sub = f.scheduler.submit(source, Q);
    await eventually(() => source.calls === 1);
    assert.throws(
      () => f.scheduler.submit(new FakeSource("ff-kiwi"), Q),
      QueueFull,
    );
    release();
    await sub.result;
  } finally {
    release();
    await f.close();
  }
});
test("completed query history is bounded while challenge-held groups remain", async () => {
  const f = fixture(false);
  try {
    f.scheduler.challenges.record(
      "momondo",
      "https://www.momondo.ie/security/check",
    );
    f.scheduler.submit(new FakeSource("momondo"), Q);
    for (let i = 0; i < 105; i++)
      await f.scheduler.submit(
        new FakeSource("ff-sky"),
        query({
          ...Q,
          depart: new Date(Date.UTC(2028, 0, i + 1)).toISOString().slice(0, 10),
        }),
      ).result;
    const groups = f.scheduler.queryJobs();
    assert.equal(groups.length, 101);
    assert.ok(
      groups.some((g) => g.sources.some((s: any) => s.source === "momondo")),
    );
  } finally {
    await f.close();
  }
});
import { ChallengeRequired, RateLimited, SourceError } from "../src/sources.js";
import { FakeSource, Q, eventually, fixture, makeOffer } from "./helpers.js";
test("concurrent attempts on a reused source keep independent cancellation contexts", async () => {
  const f = fixture(false);
  let entered = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    source = new FakeSource("ff-sky", async (q) => {
      entered++;
      await gate;
      source.context!.check();
      return [makeOffer(q)];
    });
  try {
    const first = f.scheduler.submit(source, Q),
      second = f.scheduler.submit(
        source,
        query({ ...Q, depart: "2027-12-22" }),
      );
    await eventually(() => entered === 2);
    f.scheduler.cancelJob(first.id!);
    release();
    assert.match((await first.result).error, /cancelled/);
    assert.equal((await second.result).offers.length, 1);
  } finally {
    release();
    await f.close();
  }
});
test("challenge wait expiry settles subscribers but preserves the durable hold", async () => {
  const f = fixture();
  f.scheduler.actionTimeout = 0.02;
  const source = new FakeSource("momondo", async () => {
    throw new ChallengeRequired(
      "https://www.momondo.ie/security/check",
      "momondo",
    );
  });
  try {
    const sub = f.scheduler.submit(source, Q);
    assert.match((await sub.result).error, /challenge wait timed out/);
    assert.ok(f.scheduler.challenges.pending().momondo);
  } finally {
    await f.close();
  }
});
test("repeated human-action requests have a budget without clearing the durable challenge", async () => {
  const f = fixture();
  const s = new FakeSource("momondo", async () => {
    throw new ChallengeRequired(
      "https://www.momondo.ie/security/check",
      "momondo",
    );
  });
  try {
    const sub = f.scheduler.submit(s, Q);
    for (let n = 1; n <= 3; n++) {
      await eventually(
        () => s.calls === n && f.scheduler.find(sub.id!)!.state === "blocked",
      );
      f.scheduler.challenges.clear("momondo");
    }
    assert.match((await sub.result).error, /repeatedly/);
    assert.equal(s.calls, 4);
    assert.ok(f.scheduler.challenges.pending().momondo);
  } finally {
    await f.close();
  }
});

test("identical concurrent subscriptions share one scrape and receive independent values", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    source = new FakeSource("ff-sky", async (q) => {
      await gate;
      return [makeOffer(q)];
    });
  try {
    const a = f.scheduler.submit(source, Q, { owner: "a" }),
      b = f.scheduler.submit(source, Q, { owner: "b" });
    assert.equal(a.id, b.id);
    await eventually(() => source.calls === 1);
    release();
    const [ra, rb] = await Promise.all([a.result, b.result]);
    ra.offers[0].price = 0;
    assert.equal(rb.offers[0].price, 100);
    assert.equal(source.calls, 1);
    assert.equal(f.store!.stats().offers, 1);
  } finally {
    release();
    await f.close();
  }
});
test("cancelling one subscription leaves another search running", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    s = new FakeSource("ff-sky", async (q) => {
      await gate;
      return [makeOffer(q)];
    });
  try {
    const a = f.scheduler.submit(s, Q, { owner: "a" }),
      b = f.scheduler.submit(s, Q, { owner: "b" });
    await eventually(() => s.calls === 1);
    f.scheduler.cancelOwner("a");
    assert.equal((await a.result).error, "cancelled");
    assert.equal(f.scheduler.find(b.id!)!.state, "running");
    release();
    assert.equal((await b.result).offers.length, 1);
  } finally {
    release();
    await f.close();
  }
});
test("cancelled physical request keeps its resource slot and cannot persist late results", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    s = new FakeSource("momondo", async (q) => {
      await gate;
      return [makeOffer(q, 100, "momondo")];
    });
  try {
    const a = f.scheduler.submit(s, Q, { owner: "a" });
    await eventually(() => s.calls === 1);
    f.scheduler.cancelJob(a.id!);
    assert.equal((await a.result).error, "cancelled");
    assert.equal(f.scheduler.find(a.id!)!.worker_busy, true);
    assert.equal(f.scheduler.retry(a.id!), null);
    assert.throws(
      () => f.scheduler.submit(new FakeSource("momondo"), Q),
      QueueFull,
    );
    const next = new FakeSource("momondo"),
      b = f.scheduler.submit(next, query({ ...Q, depart: "2027-12-22" }));
    await delay(20);
    assert.equal(next.calls, 0);
    release();
    await b.result;
    assert.equal(f.store!.all("SELECT * FROM offers").length, 1);
    assert.equal(
      f.store!.all("SELECT * FROM trips")[0].depart_date,
      "2027-12-22",
    );
  } finally {
    release();
    await f.close();
  }
});
test("timed out physical request settles promptly, keeps its slot, and never writes late", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    s = new FakeSource("momondo", async (q) => {
      await gate;
      return [makeOffer(q)];
    });
  s.jobTimeout = 0.02;
  try {
    const a = f.scheduler.submit(s, Q);
    await a.result;
    assert.equal(f.scheduler.find(a.id!)!.queue_state, "timed_out");
    assert.equal(f.scheduler.find(a.id!)!.worker_busy, true);
    assert.equal(f.store!.stats().offers, 0);
    release();
    await eventually(() => !f.scheduler.find(a.id!)!.worker_busy);
    assert.equal(f.store!.stats().offers, 0);
  } finally {
    release();
    await f.close();
  }
});
test("a challenge pauses its source, leaves other sources free, and resumes original subscriptions", async () => {
  const f = fixture();
  const s = new FakeSource("momondo", async (q) => {
    if (s.calls === 1)
      throw new ChallengeRequired(
        "https://www.momondo.ie/security/check",
        "momondo",
      );
    return [makeOffer(q, 100, "momondo")];
  });
  try {
    const a = f.scheduler.submit(s, Q);
    await eventually(() => f.scheduler.find(a.id!)!.state === "blocked");
    assert.equal(
      f.store!.get("SELECT status FROM fetches")!.status,
      "challenge",
    );
    const unrelated = f.scheduler.submit(new FakeSource("ff-sky"), Q);
    assert.equal((await unrelated.result).offers.length, 1);
    assert.ok(f.scheduler.challenges.clear("momondo"));
    await a.result;
    assert.equal(s.calls, 2);
    assert.equal(f.scheduler.find(a.id!)!.state, "done");
  } finally {
    await f.close();
  }
});
test("a cancelled challenge remains durable until explicitly cleared", async () => {
  const f = fixture();
  const s = new FakeSource("momondo", async () => {
    throw new ChallengeRequired(
      "https://www.momondo.ie/security/check",
      "momondo",
    );
  });
  try {
    const a = f.scheduler.submit(s, Q);
    await eventually(() => f.scheduler.find(a.id!)!.state === "blocked");
    f.scheduler.cancelJob(a.id!);
    await a.result;
    assert.ok(f.scheduler.challenges.pending().momondo);
    assert.equal(
      f.store!.get("SELECT status FROM fetches")!.status,
      "challenge",
    );
  } finally {
    await f.close();
  }
});
test("transient errors retry and permanent failures settle without retry", async () => {
  const f = fixture();
  const s = new FakeSource("ff-sky", async (q) => {
    if (s.calls === 1) throw new RateLimited(0.01);
    return [makeOffer(q)];
  });
  try {
    const a = f.scheduler.submit(s, Q, { retries: 2 });
    await a.result;
    assert.equal(s.calls, 2);
    assert.equal(f.scheduler.find(a.id!)!.failures, 1);
    const p = new FakeSource("ff-kiwi", async () => {
      throw new SourceError("unsupported cabin");
    });
    const b = f.scheduler.submit(p, Q, { retries: 3 });
    assert.match((await b.result).error, /unsupported cabin/);
    assert.equal(p.calls, 1);
  } finally {
    await f.close();
  }
});
test("fresh ledger answers do not execute the source and preserve count", async () => {
  const f = fixture();
  const s = new FakeSource();
  try {
    await f.scheduler.submit(s, Q).result;
    const a = f.scheduler.submit(s, Q);
    assert.equal(a.id, null);
    assert.equal((await a.result).found, 1);
    assert.equal(s.calls, 1);
    assert.equal(f.scheduler.queryJobs()[0].sources[0].status, "cached");
  } finally {
    await f.close();
  }
});
test("a scrape answered within the last day is reused without asking the source again", async () => {
  const f = fixture();
  const s = new FakeSource();
  try {
    await f.scheduler.submit(s, Q).result;
    const ago = (hours: number) =>
      f.store!.run(
        "UPDATE fetches SET last_fetched=?",
        new Date(Date.now() - hours * 3600000).toISOString(),
      );
    ago(23);
    assert.equal(f.scheduler.submit(s, Q).id, null);
    assert.equal(s.calls, 1);
    ago(25);
    await f.scheduler.submit(s, Q).result;
    assert.equal(s.calls, 2);
  } finally {
    await f.close();
  }
});
test("foreground selection reprioritizes work without submitting or cancelling it", async () => {
  const f = fixture(false);
  f.scheduler.challenges.record(
    "momondo",
    "https://www.momondo.ie/security/check",
  );
  try {
    const a = f.scheduler.submit(new FakeSource("momondo"), Q),
      b = f.scheduler.submit(
        new FakeSource("momondo"),
        query({ ...Q, depart: "2027-12-22" }),
      );
    f.scheduler.select({ ...Q, start: Q.depart, end: Q.depart, ret: "" });
    assert.equal(f.scheduler.find(a.id!)!.priority, 0);
    assert.equal(f.scheduler.find(b.id!)!.priority, 10);
    assert.equal(f.scheduler.queryJobs().length, 2);
    f.scheduler.cancelJob(a.id!);
    f.scheduler.cancelJob(b.id!);
    await Promise.all([a.result, b.result]);
  } finally {
    await f.close();
  }
});
test("queue restoration keeps settled work as history and resumes only unfinished tasks", async () => {
  const old = fixture(false);
  let groups: any[];
  try {
    await old.scheduler.submit(new FakeSource(), Q).result;
    old.scheduler.challenges.record(
      "momondo",
      "https://www.momondo.ie/security/check",
    );
    const waiting = old.scheduler.submit(new FakeSource("momondo"), Q);
    await eventually(
      () => old.scheduler.find(waiting.id!)!.state === "blocked",
    );
    groups = old.scheduler.queryJobs();
  } finally {
    await old.close();
  }
  const next = fixture(false);
  let calls = 0;
  next.scheduler.sourceFactory = (name) =>
    new FakeSource(name, async (q) => {
      calls++;
      return [makeOffer(q)];
    });
  try {
    next.scheduler.restore(groups!);
    await delay(20);
    assert.equal(calls, 0);
    assert.equal(
      next.scheduler
        .queryJobs()
        .flatMap((g) => g.sources)
        .find((s) => s.source === "ff-sky").state,
      "done",
    );
    next.scheduler.challenges.clear("momondo");
    await eventually(() => calls === 1);
    await eventually(() => next.scheduler.snapshot().running === 0);
  } finally {
    await next.close();
  }
});
