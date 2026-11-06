import * as cheerio from "cheerio";
import { decodeHTML } from "entities";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  addDays,
  leg,
  offer,
  parseDuration,
  segment,
  type Leg,
  type Offer,
  type Progress,
  type Query,
  type Segment,
} from "./models.js";
import {
  HttpResponse,
  ReplayTransport,
  type Cookie,
  type RequestOptions,
  type Session,
  type Transport,
} from "./transport.js";

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}
export class RateLimited extends RetryableError {
  constructor(public retryAfter = 60) {
    super(`rate limited for ${retryAfter}s`);
    this.name = "RateLimited";
  }
}
export class ChallengeRequired extends SourceError {
  constructor(
    public url: string,
    public source: string,
  ) {
    super(`${source} needs a human to clear a challenge: ${url}`);
    this.name = "ChallengeRequired";
  }
}
export interface AttemptContext {
  signal: AbortSignal;
  remaining(): number;
  check(): void;
}
const attemptContext = new AsyncLocalStorage<AttemptContext>();
export const sourceNames = [
  "ff-kayak",
  "ff-sky",
  "ff-kiwi",
  "momondo",
  "jetradar",
];
export const labels: Record<string, string> = {
  "ff-kayak": "Kayak (FlightsFinder)",
  "ff-sky": "Sky (FlightsFinder)",
  "ff-kiwi": "Kiwi (FlightsFinder)",
  momondo: "Momondo",
  jetradar: "Jetradar",
};
export function webMode(): boolean {
  const m = process.env.FLYSCAN_MODE || "desktop";
  if (!["desktop", "web"].includes(m))
    throw new Error("FLYSCAN_MODE must be desktop or web");
  return m === "web";
}
export function allowedSources(): string[] {
  const enabled = process.env.FLYSCAN_ENABLED_SOURCES?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (enabled?.some((s) => !sourceNames.includes(s)))
    throw new Error("unknown configured source(s)");
  return sourceNames.filter(
    (s) =>
      (!webMode() || !["ff-kayak", "momondo"].includes(s)) &&
      (!enabled || enabled.includes(s)),
  );
}
export class Source {
  retries = 2;
  readonly label: string;
  readonly fixedCurrency: string | null;
  readonly maxConcurrency: number;
  readonly minInterval: number;
  jobTimeout = 180;
  get context(): AttemptContext | undefined {
    return attemptContext.getStore();
  }
  runInContext<T>(
    context: AttemptContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return attemptContext.run(context, operation);
  }
  constructor(
    public name: string,
    public transport: Transport,
    public cookies: Cookie[] = [],
    public timeout = 60,
    public onProgress: Progress = () => {},
  ) {
    if (!sourceNames.includes(name)) throw new SourceError("unknown source");
    this.label = labels[name];
    this.fixedCurrency = this.kayak ? "EUR" : null;
    this.maxConcurrency = this.kayak ? 1 : 2;
    this.minInterval = this.kayak ? 2.5 : 0.5;
  }
  get kayak(): boolean {
    return ["ff-kayak", "momondo"].includes(this.name);
  }
  get host(): string {
    return this.name === "momondo"
      ? "www.momondo.ie"
      : "ie-kayak.flightsfinder.com";
  }
  searchURL(q: Query): string {
    if (this.kayak) {
      let legs = `${q.origin}-${q.destination}/${q.depart}/${q.ret || ""}`;
      const minors = [
        ...Array(q.infants).fill("1L"),
        ...Array(q.children).fill("10"),
      ];
      let travellers = `${q.adults}adults`;
      if (minors.length) travellers += "/children-" + minors.join("-");
      const cabin =
        q.cabin === "economy"
          ? ""
          : q.cabin === "premiumeconomy"
            ? "premium"
            : q.cabin;
      return `https://${this.host}/${this.name === "momondo" ? "flight-search" : "flights"}/${legs}/${cabin ? cabin + "/" : ""}${travellers}?sort=price_a`;
    }
    if (this.name === "jetradar")
      return `https://jetradeu.cheapflightsfinder.com/flights/${linkToken(q)}`;
    const kiwi = this.name === "ff-kiwi";
    const cabins = kiwi
      ? { economy: "M", premiumeconomy: "W", business: "C", first: "F" }
      : {
          economy: "Economy",
          premiumeconomy: "PremiumEconomy",
          business: "Business",
          first: "First",
        };
    const fmt = (d: string) => (kiwi ? d.split("-").reverse().join("/") : d);
    const params: Record<string, string> = kiwi
      ? {
          currency: q.currency,
          type: q.ret ? "return" : "oneway",
          cabinclass: cabins[q.cabin],
          originplace: q.origin,
          destinationplace: q.destination,
          outbounddate: fmt(q.depart),
          inbounddate: q.ret ? fmt(q.ret) : "",
          adults: String(q.adults),
          children: String(q.children),
          infants: String(q.infants),
        }
      : {
          originplace: q.origin,
          destinationplace: q.destination,
          outbounddate: q.depart,
          inbounddate: q.ret || "",
          cabinclass: cabins[q.cabin],
          adults: String(q.adults),
          children: String(q.children),
          infants: String(q.infants),
          currency: q.currency,
        };
    return `https://www.flightsfinder.com/portal/${kiwi ? "kiwi" : "sky"}?${new URLSearchParams(params)}`;
  }
  async request(
    session: Session,
    method: string,
    url: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    this.context?.check();
    options = {
      ...options,
      timeout: Math.max(
        0.001,
        Math.min(
          options.timeout || this.timeout,
          this.context?.remaining() ?? Infinity,
        ),
      ),
    };
    let r: HttpResponse;
    try {
      r = await session.request(method, url, options);
    } catch (e) {
      if (["Timeout", "ConnectionError"].includes((e as Error).name))
        throw new RetryableError((e as Error).message);
      throw e;
    }
    this.context?.check();
    if (r.status === 429 || (r.status === 503 && r.headers["retry-after"])) {
      const raw = r.headers["retry-after"] || "60";
      let seconds = Number(raw);
      if (!Number.isFinite(seconds))
        seconds = (Date.parse(raw) - Date.now()) / 1000;
      throw new RateLimited(
        Number.isFinite(seconds) && seconds >= 0 ? seconds : 60,
      );
    }
    if (r.status >= 500 || r.status === 408)
      throw new RetryableError(`HTTP ${r.status}: ${url}`);
    if (r.status >= 400 && !(this.kayak && r.status === 403))
      throw new SourceError(`HTTP ${r.status}: ${url}`);
    return r;
  }
  async pause(seconds: number): Promise<void> {
    this.context?.check();
    if (!(this.transport instanceof ReplayTransport))
      await delay(seconds * 1000, undefined, { signal: this.context?.signal });
    this.context?.check();
  }
  async search(q: Query): Promise<Offer[]> {
    const session = await this.transport.open(this.cookies);
    try {
      return this.kayak
        ? await this.searchKayak(session, q)
        : this.name === "jetradar"
          ? await this.searchTravelpayouts(session, q)
          : await this.searchPortal(session, q);
    } finally {
      await session.close();
    }
  }
  private async searchPortal(session: Session, q: Query): Promise<Offer[]> {
    const pageURL = this.searchURL(q);
    const page = await this.request(session, "GET", pageURL);
    const [endpoint, body] = extractPoll(page.text);
    let offers: Offer[] = [],
      settled = 0,
      last = "";
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      let poll: HttpResponse;
      try {
        poll = await this.request(
          session,
          "POST",
          "https://www.flightsfinder.com" + endpoint,
          {
            data: body,
            headers: { "X-Requested-With": "XMLHttpRequest", Referer: pageURL },
          },
        );
      } catch (e) {
        if (e instanceof RateLimited || this.context?.signal.aborted) throw e;
        if (offers.length && !(e instanceof SourceError)) return offers;
        throw e;
      }
      const parts = poll.text.split("|");
      if (parts.length <= 6)
        throw new SourceError(
          "poll response was not the expected pipe-delimited payload",
        );
      if (parts[6].trim())
        offers = parsePortal(
          parts[6],
          this.name,
          q,
          this.fixedCurrency || q.currency,
        );
      if (parts[0].trim() === "Y") break;
      const heard = parts[1].trim() + ":" + offers.length;
      settled = heard === last ? settled + 1 : 0;
      last = heard;
      if (settled >= 2 && offers.length) break;
      await this.pause(0.8);
    }
    return offers;
  }
  kayakBody(q: Query): any {
    const makeLeg = (origin: string, destination: string, date: string) => ({
      origin: { airports: [origin], locationType: "airports" },
      destination: { airports: [destination], locationType: "airports" },
      date,
      flex: "exact",
      ...(q.cabin !== "economy"
        ? {
            cabinClass:
              q.cabin === "premiumeconomy" ? "premium-economy" : q.cabin,
          }
        : {}),
    });
    return {
      filterParams: {},
      userSearchParams: {
        legs: [
          makeLeg(q.origin, q.destination, q.depart),
          ...(q.ret ? [makeLeg(q.destination, q.origin, q.ret)] : []),
        ],
        passengers: [
          ...Array(q.adults).fill("ADT"),
          ...Array(q.infants).fill("INL"),
          ...Array(q.children).fill("CHD"),
        ],
        passengerDetails: [
          ...Array.from({ length: q.adults }, () => ({ ptc: "ADT" })),
          ...Array.from({ length: q.infants }, () => ({ ptc: "INL" })),
          ...Array.from({ length: q.children }, () => ({
            ptc: "CHD",
            age: 10,
          })),
        ],
        sortMode: "price_a",
      },
      searchMetaData: { pageNumber: 1, searchTypes: [] },
    };
  }
  private challenged(r: HttpResponse): void {
    if (r.status !== 403) return;
    let url = "";
    try {
      url = r.json()?.captchaRedirectUrl || "";
    } catch {}
    if (url) throw new ChallengeRequired(url, this.name);
    throw new SourceError(
      "blocked by the bot check, with no challenge offered",
    );
  }
  private async searchKayak(session: Session, q: Query): Promise<Offer[]> {
    const pageURL = this.searchURL(q),
      pollURL = `https://${this.host}/i/api/search/dynamic/flights/poll`;
    const page = await this.request(session, "GET", pageURL);
    const token = page.text.match(/"formtoken"\s*:\s*"([^"]+)"/);
    if (!token) {
      if (
        page.url.includes("/security/check") ||
        [
          "/security/check",
          "recaptcha",
          "unusual traffic",
          "are you a robot",
        ].some((m) => page.text.toLowerCase().includes(m))
      )
        throw new ChallengeRequired(
          page.url.includes("/security/check")
            ? page.url
            : `https://${this.host}/security/check`,
          this.name,
        );
      throw new SourceError("search page carried no form token");
    }
    if (page.status !== 200)
      throw new SourceError(`search page returned HTTP ${page.status}`);
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: `https://${this.host}`,
      Referer: pageURL,
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF": token[1],
    };
    const body = this.kayakBody(q);
    const first = await this.request(session, "POST", pollURL, {
      json: body,
      headers,
    });
    this.challenged(first);
    const opening = first.json();
    if (!opening.searchId) throw new SourceError("poll returned no search id");
    body.userSearchParams.searchId = opening.searchId;
    body.searchMetaData.skipResultsInSecondPhase = false;
    const collected = new Map<string, Offer>();
    const collect = (p: any) => {
      for (const o of parseKayak(p, q, this.name, this.host))
        if (!collected.has(o.source_id)) collected.set(o.source_id, o);
    };
    let payload: any = {};
    let deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      let poll: HttpResponse;
      try {
        poll = await this.request(session, "POST", pollURL, {
          json: body,
          headers,
        });
      } catch (e) {
        if (e instanceof RateLimited || this.context?.signal.aborted) throw e;
        if (collected.size) return [...collected.values()];
        throw e;
      }
      this.challenged(poll);
      if (poll.status !== 200) break;
      payload = poll.json();
      collect(payload);
      if (String(payload.status).toLowerCase() === "complete") break;
      await this.pause(1.2);
    }
    const pageSize = Number(payload.pageSize || 0),
      expected = Number(payload.filteredCount || 0);
    deadline = Date.now() + 45000;
    if (pageSize)
      for (
        let n = 2;
        n <= 8 && collected.size < expected && Date.now() < deadline;
        n++
      ) {
        await this.pause(0.6);
        body.searchMetaData.pageNumber = n;
        let poll: HttpResponse;
        try {
          poll = await this.request(session, "POST", pollURL, {
            json: body,
            headers,
          });
        } catch (e) {
          if (e instanceof RateLimited || this.context?.signal.aborted) throw e;
          break;
        }
        this.challenged(poll);
        if (poll.status !== 200) break;
        const p = poll.json(),
          before = collected.size;
        collect(p);
        if ((p.results || []).length < pageSize || before === collected.size)
          break;
      }
    return [...collected.values()];
  }
  travelPayload(q: Query): any {
    const directions = [
      {
        origin: q.origin,
        destination: q.destination,
        date: q.depart,
        is_origin_airport: /^[A-Z]{3}$/.test(q.origin),
        is_destination_airport: false,
      },
      ...(q.ret
        ? [
            {
              origin: q.destination,
              destination: q.origin,
              date: q.ret,
              is_origin_airport: false,
              is_destination_airport: false,
            },
          ]
        : []),
    ];
    return {
      citizenship: "DE",
      client_features: { badges: true },
      currency_code: q.currency,
      host: "jetradeu.cheapflightsfinder.com",
      languages: { en: 1 },
      marker: `148729.Z${randomUUID().replaceAll("-", "").slice(0, 24)}-148729`,
      market_code: "DE",
      search_params: {
        directions,
        passengers: {
          adults: q.adults,
          children: q.children,
          infants: q.infants,
        },
        trip_class: {
          economy: "Y",
          premiumeconomy: "W",
          business: "C",
          first: "F",
        }[q.cabin],
      },
    };
  }
  private async searchTravelpayouts(
    session: Session,
    q: Query,
  ): Promise<Offer[]> {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Origin: "https://jetradeu.cheapflightsfinder.com",
      Referer: "https://jetradeu.cheapflightsfinder.com/",
      "accept-language": "en-GB",
      "affiliate-marker": "148729",
      "x-whitelabel-version": "v2",
    };
    const payload = this.travelPayload(q),
      signed = await this.request(
        session,
        "POST",
        "https://api.apistp.com/whitelabels/web/flights/v1/search/sign",
        { json: payload, headers },
      );
    payload.signature = signed.json()?.signature;
    if (!payload.signature)
      throw new SourceError("signing returned no signature");
    const started = await this.request(
      session,
      "POST",
      "https://tickets-api.apistp.com/search/wl/start",
      { json: payload, headers },
    );
    const opening = started.json();
    if (!opening.search_id || !opening.results_url)
      throw new SourceError("search start returned no results endpoint");
    const url = `https://${opening.results_url}/search/wl/results`,
      interval = (opening.polling_interval_ms || 1000) / 1000,
      collected = new Map<string, Offer>(),
      deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const poll = await this.request(session, "POST", url, {
        json: { search_id: opening.search_id },
        headers,
      });
      if (poll.status === 204) {
        await this.pause(interval);
        continue;
      }
      if (poll.status !== 200) break;
      const chunks = poll.json();
      if (!Array.isArray(chunks)) break;
      let finished = false;
      for (const chunk of chunks) {
        if (!chunk || typeof chunk !== "object") continue;
        for (const o of parseTravelpayouts(chunk, q))
          if (!collected.has(o.source_id)) collected.set(o.source_id, o);
        if (chunk.last_result) finished = true;
      }
      if (finished || !chunks.length) break;
      await this.pause(interval);
    }
    return [...collected.values()];
  }
}
export function extractPoll(html: string): [string, Record<string, string>] {
  const m = html.match(
    /\$\.ajax\(\{\s*type:\s*'POST',\s*url:\s*'([^']+)'.*?data:\s*\{(.*?)\}\s*\}\s*\)/s,
  );
  if (!m) throw new SourceError("search page carried no polling block");
  const data = Object.fromEntries(
    [...m[2].matchAll(/'([^']+)'\s*:\s*'([^']*)'/g)].map((m) => [
      m[1],
      decodeHTML(m[2]),
    ]),
  );
  if (!Object.keys(data).length)
    throw new SourceError("polling block carried no parameters");
  return [m[1], data];
}
const totalPrice = (b: any) =>
  b?.fees?.totalPrice?.price != null
    ? b.fees.totalPrice
    : b?.displayPrice || {};
export function parseKayak(
  payload: any,
  q: Query,
  source: string,
  host = source === "momondo" ? "www.momondo.ie" : "ie-kayak.flightsfinder.com",
): Offer[] {
  const offers: Offer[] = [];
  for (const r of payload.results || []) {
    if (r?.type !== "core" || !r.legs?.length) continue;
    const legs: Leg[] = r.legs.map((ref: any) => {
      const detail = payload.legs?.[ref.id] || {},
        segments: Segment[] = [];
      for (const s of ref.segments || []) {
        const raw = payload.segments?.[s.id];
        if (!raw) continue;
        const code = raw.airline || "",
          number = String(raw.flightNumber ?? "");
        if (
          !/^(?=.*[A-Z])[A-Z0-9]{2}$/.test(code.toUpperCase()) ||
          !/^\d+$/.test(number)
        )
          return leg();
        segments.push(
          segment({
            carrier: code,
            carrier_name: payload.airlines?.[code]?.name || "",
            flight_number: code + number,
            origin: raw.origin || "",
            destination: raw.destination || "",
            departure: raw.departure || "",
            arrival: raw.arrival || "",
            duration_minutes: raw.duration ?? null,
          }),
        );
      }
      return leg({
        origin_airport: segments[0]?.origin || "",
        destination_airport: segments.at(-1)?.destination || "",
        departure: detail.departure || segments[0]?.departure || "",
        arrival: detail.arrival || segments.at(-1)?.arrival || "",
        duration_minutes: detail.duration ?? null,
        stops: Math.max(0, segments.length - 1),
        airlines: [
          ...new Set(
            segments.map((s) => s.carrier_name || s.carrier).filter(Boolean),
          ),
        ].join(", "),
        flight_numbers: segments
          .map((s) => s.flight_number)
          .filter(Boolean)
          .join(", "),
        segments,
      });
    });
    if (legs.some((l) => !l.segments.length)) continue;
    const options = (r.bookingOptions || [])
      .filter((b: any) => b && typeof b === "object")
      .sort(
        (a: any, b: any) =>
          (totalPrice(a).price ?? Infinity) - (totalPrice(b).price ?? Infinity),
      );
    const booking = options[0];
    if (!booking) continue;
    const price = totalPrice(booking);
    if (price.price == null) continue;
    let url = booking.bookingUrl?.url || "";
    if (url.startsWith("/")) url = `https://${host}${url}`;
    offers.push(
      offer({
        itinerary: { query: q, outbound: legs[0], inbound: legs[1] || null },
        source,
        price: Number(price.price),
        currency: (price.currency || "EUR").toUpperCase(),
        agent:
          payload.providers?.[booking.providerCode]?.displayName ||
          booking.providerCode ||
          "",
        deeplink: url,
        source_id: String(r.resultId || ""),
      }),
    );
  }
  return offers;
}
export const linkToken = (q: Query) =>
  q.origin +
  q.depart.slice(8, 10) +
  q.depart.slice(5, 7) +
  q.destination +
  (q.ret ? q.ret.slice(8, 10) + q.ret.slice(5, 7) : "") +
  (["business", "first"].includes(q.cabin) ? "b" : "") +
  q.adults +
  q.children +
  q.infants;
function elapsed(a: any, b: any): number | null {
  if (
    typeof a === "boolean" ||
    typeof b === "boolean" ||
    a == null ||
    b == null
  )
    return null;
  const n = Math.floor((Number(b) - Number(a)) / 60);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function parseTravelpayouts(chunk: any, q: Query): Offer[] {
  const offers: Offer[] = [];
  const airline = (code: string) =>
    chunk.airlines?.[code]?.name?.en?.default || "";
  for (const ticket of chunk.tickets || []) {
    if (!ticket || typeof ticket !== "object") continue;
    const proposal = (ticket.proposals || [])
      .filter((p: any) => p && typeof p === "object")
      .sort(
        (a: any, b: any) =>
          (a.price?.value ?? Infinity) - (b.price?.value ?? Infinity),
      )[0];
    if (!proposal || proposal.price?.value == null) continue;
    const legs: Leg[] = [];
    for (const direction of ticket.segments || []) {
      const flights = (direction.flights || [])
        .filter(
          (i: any) =>
            Number.isInteger(i) &&
            i >= 0 &&
            i < (chunk.flight_legs || []).length,
        )
        .map((i: number) => ({ index: i, raw: chunk.flight_legs[i] }));
      if (!flights.length) continue;
      const segments: Segment[] = flights.map(({ index, raw }: any) => {
        const operating = raw.operating_carrier_designator || {},
          designator =
            proposal.flight_terms?.[String(index)]
              ?.marketing_carrier_designator || operating,
          code = designator.carrier || "",
          number = (code + (designator.number ?? "")).trim(),
          flownBy = operating.carrier || "",
          flownAs = (flownBy + (operating.number ?? "")).trim(),
          codeshare = !!flownBy && flownAs !== number;
        return segment({
          carrier: code,
          carrier_name: airline(code),
          flight_number: number,
          operating_carrier: codeshare ? flownBy : "",
          operating_carrier_name: codeshare ? airline(flownBy) : "",
          operating_flight_number: codeshare ? flownAs : "",
          origin: raw.origin || "",
          destination: raw.destination || "",
          departure: (raw.local_departure_date_time || "").replace(" ", "T"),
          arrival: (raw.local_arrival_date_time || "").replace(" ", "T"),
          duration_minutes: elapsed(
            raw.departure_unix_timestamp,
            raw.arrival_unix_timestamp,
          ),
        });
      });
      legs.push(
        leg({
          origin_airport: segments[0].origin,
          destination_airport: segments.at(-1)!.destination,
          departure: segments[0].departure,
          arrival: segments.at(-1)!.arrival,
          duration_minutes: elapsed(
            flights[0].raw.departure_unix_timestamp,
            flights.at(-1)!.raw.arrival_unix_timestamp,
          ),
          stops: Math.max(0, segments.length - 1),
          airlines: [
            ...new Set(
              segments.map((s) => s.carrier_name || s.carrier).filter(Boolean),
            ),
          ].join(", "),
          flight_numbers: segments
            .map((s) => s.flight_number)
            .filter(Boolean)
            .join(", "),
          segments,
        }),
      );
    }
    if (!legs.length) continue;
    const agent = chunk.agents?.[String(proposal.agent_id)] || {},
      id = String(ticket.id || ""),
      token = linkToken(q);
    offers.push(
      offer({
        itinerary: { query: q, outbound: legs[0], inbound: legs[1] || null },
        source: "jetradar",
        price: Number(proposal.price.value),
        currency: (proposal.price.currency_code || q.currency).toUpperCase(),
        agent: agent.label?.en?.default || agent.gate_name || "",
        deeplink: id
          ? `https://jetradeu.cheapflightsfinder.com/?flightSearch=${token}&ticketId=${id}`
          : `https://jetradeu.cheapflightsfinder.com/flights/${token}`,
        source_id: `${ticket.id ?? ""}:${proposal.id ?? ""}`,
      }),
    );
  }
  return offers;
}
export function dateSegments(segments: Segment[], baseDay: string): void {
  let current = baseDay,
    previous = "";
  for (const s of segments) {
    for (const field of ["departure", "arrival"] as const) {
      const v = s[field];
      if (!v) continue;
      if (v.includes("T")) {
        current = v.slice(0, 10);
        previous = v.slice(11, 16);
        continue;
      }
      let days = 0;
      if (field === "departure") {
        if (previous && v < previous) days = 1;
      } else if (previous) {
        if (s.duration_minutes == null) days = v < previous ? 1 : 0;
        else {
          const mins = (c: string) => +c.split(":")[0] * 60 + +c.split(":")[1];
          const gap = mins(v) - mins(previous);
          days = [-1, 0, 1, 2].sort(
            (a, b) =>
              Math.abs(gap + a * 1440 - s.duration_minutes!) -
              Math.abs(gap + b * 1440 - s.duration_minutes!),
          )[0];
        }
      }
      current = addDays(current, days);
      s[field] = `${current}T${v}`;
      previous = v;
    }
  }
}
export function parsePortal(
  markup: string,
  source: string,
  q: Query,
  currency = q.currency,
): Offer[] {
  const $ = cheerio.load(`<div>${markup}</div>`),
    text = (el: any) => $(el).text().replace(/\s+/g, " ").trim(),
    offers: Offer[] = [];
  const dateWords = (s: string) => {
    const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
    if (!m) return "";
    const month =
      [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ].findIndex((v) => v.toLowerCase() === m[2].toLowerCase()) + 1;
    return month
      ? `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`
      : "";
  };
  $("div.list-item").each((index, item) => {
    try {
      const card = $(item);
      let price = Number(card.attr("data-price"));
      if (!card.attr("data-price") || !Number.isFinite(price)) {
        const p = card.find("p.prices").first().text();
        const digits = p.replace(/[^\d.,]/g, "").replaceAll(",", "");
        price = digits ? Number(digits) : NaN;
      } else price /= 100;
      if (!Number.isFinite(price)) return;
      const blocks = card.find("div.stops").toArray();
      if (!blocks.length) return;
      let modalId = "";
      card
        .find("*")
        .addBack()
        .each((_, node) => {
          if (modalId) return;
          for (const attr of [
            "data-target",
            "data-bs-target",
            "href",
            "onclick",
          ]) {
            const m = ($(node).attr(attr) || "").match(/\bmyModal\d+\b/);
            if (m) {
              modalId = m[0];
              break;
            }
          }
        });
      const modal = $(`#${modalId || "myModal" + index}`);
      const panels = modal.find("div._panel").toArray(),
        legs: Leg[] = [];
      blocks.slice(0, 2).forEach((block, i) => {
        const panel = $(panels[i]),
          segments: Segment[] = [];
        panel.find("div._panel_body").each((_, body) => {
          const node = $(body),
            name = text(node.find("div._head small").first()),
            m = name.match(/^(.*?)\s+([A-Z]{3}|[A-Z0-9]{2})\s?(\d{1,4})\s*$/),
            times = node.find("div.c3 p").toArray().map(text),
            places = node.find("div.c4 p").toArray().map(text),
            durations = node.find("div.c1 p").toArray().map(text);
          segments.push(
            segment({
              carrier: m?.[2] || "",
              carrier_name: m?.[1].trim() || name,
              flight_number: m ? m[2] + m[3] : "",
              origin: places[0]?.split(" ")[0] || "",
              destination:
                places.length > 1 ? places.at(-1)!.split(" ")[0] : "",
              departure: times[0] || "",
              arrival: times.length > 1 ? times.at(-1)! : "",
              duration_minutes: parseDuration(durations[0] || ""),
            }),
          );
        });
        const baseDay = i === 0 ? q.depart : q.ret || q.depart;
        dateSegments(segments, baseDay);
        const endpoints = $(block).find("p").toArray();
        const clockAndCode = (el: any) => {
          const spans = $(el).find("span").toArray().map(text),
            m = spans
              .map((s) => s.match(/^(\d{1,2}):(\d{2})(?:\+(\d))?$/))
              .find(Boolean);
          return {
            clock: m ? m[1].padStart(2, "0") + ":" + m[2] : "",
            offset: Number(m?.[3] || 0),
            code: spans.find((s) => /^[A-Z]{3}$/.test(s)) || "",
          };
        };
        const from = clockAndCode(endpoints[0]),
          to = clockAndCode(endpoints.at(-1));
        let clock = from.clock;
        const fallback = card.attr(
          i === 0 ? "data-outboundmins" : "data-returnmins",
        );
        if (!clock && fallback != null && Number.isFinite(Number(fallback)))
          clock =
            String(Math.floor(+fallback / 60)).padStart(2, "0") +
            ":" +
            String(+fallback % 60).padStart(2, "0");
        const spans = $(block).find("div.stop-arrow span").toArray().map(text),
          stop = spans
            .map((s) => s.match(/^(?:(direct|non-?stop)|(\d+)\s*stops?)$/i))
            .find(Boolean),
          arrivalDay = to.offset
            ? baseDay
            : dateWords(text(panel.find("p._summary span").first())) || baseDay;
        legs.push(
          leg({
            origin_airport: from.code,
            destination_airport: to.code,
            departure: clock ? `${baseDay}T${clock}` : "",
            arrival: to.clock
              ? `${addDays(arrivalDay, to.offset)}T${to.clock}`
              : "",
            duration_minutes: parseDuration(spans[0] || ""),
            stops: stop
              ? stop[1]
                ? 0
                : Number(stop[2])
              : segments.length
                ? Math.max(0, segments.length - 1)
                : null,
            airlines:
              i === 0
                ? text(card.find("p.airlines-name").first()) ||
                  text(panel.find("p._ahn").first())
                : text(panel.find("p._ahn").first()),
            flight_numbers: segments
              .map((s) => s.flight_number)
              .filter(Boolean)
              .join(", "),
            segments,
          }),
        );
      });
      offers.push(
        offer({
          itinerary: { query: q, outbound: legs[0], inbound: legs[1] || null },
          source,
          price,
          currency,
          agent: text(modal.find("div._similar > div > p").first()),
          deeplink: card.find("a.modal_responsive").first().attr("href") || "",
          source_id: card.attr("data-best") || "",
        }),
      );
    } catch {
      /* A malformed card must not discard the remaining results. */
    }
  });
  return offers;
}
