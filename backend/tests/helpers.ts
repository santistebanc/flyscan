import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { leg, offer, query, type Offer, type Query } from "../src/models.js";
import { Scheduler } from "../src/scheduler.js";
import { Source } from "../src/sources.js";
import { FlightStore } from "../src/store.js";
import { ErrorLog, Rates } from "../src/support.js";
import { OfflineTransport } from "../src/transport.js";
export const Q = query({
  origin: "BER",
  destination: "CDG",
  depart: "2027-12-21",
});
export const makeOffer = (q = Q, price = 100, source = "ff-sky"): Offer =>
  offer({
    itinerary: {
      query: q,
      outbound: leg({
        origin_airport: "BER",
        destination_airport: "CDG",
        departure: q.depart + "T09:00",
        arrival: q.depart + "T11:00",
        duration_minutes: 120,
        stops: 0,
      }),
      inbound: null,
    },
    source,
    price,
    currency: "EUR",
    price_eur: price,
  });
export async function eventually(
  check: () => boolean,
  message = "condition did not become true",
  timeout = 2000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(5);
  }
}
export class FakeSource extends Source {
  calls = 0;
  handler: (q: Query) => Promise<Offer[]>;
  constructor(name = "ff-sky", handler?: (q: Query) => Promise<Offer[]>) {
    super(name, new OfflineTransport());
    this.handler = handler || (async (q) => [makeOffer(q, 100, name)]);
    Object.defineProperty(this, "minInterval", { value: 0 });
  }
  async search(q: Query): Promise<Offer[]> {
    this.calls++;
    return this.handler(q);
  }
}
export function fixture(memory = true) {
  const directory = mkdtempSync(join(tmpdir(), "flyscan-ts-")),
    transport = new OfflineTransport(),
    store = memory ? new FlightStore(":memory:") : null,
    rates = new Rates(transport, join(directory, "fx.json")),
    errors = new ErrorLog(join(directory, "errors.jsonl")),
    scheduler = new Scheduler(store, transport, rates, errors);
  scheduler.challenges.cookies.path = join(directory, "challenges");
  return {
    directory,
    transport,
    store,
    rates,
    errors,
    scheduler,
    async close() {
      await scheduler.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
