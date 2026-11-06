import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { now, type Offer, type Query, tripKey } from "./models.js";
import { Source } from "./sources.js";
import { atomicJSON, type Data } from "./support.js";
import { type Cookie, ReplayTransport, type Transport } from "./transport.js";
export function digestOffers(offers: Offer[]): string {
  const rows = offers
    .map((o) => {
      const parts = [
        o.price.toFixed(2),
        o.currency,
        o.agent || "",
        tripKey(o.itinerary),
      ];
      for (const l of [o.itinerary.outbound, o.itinerary.inbound]) {
        if (!l) continue;
        parts.push(
          `${l.origin_airport}>${l.destination_airport}`,
          `${l.departure}/${l.arrival}`,
        );
        for (const s of l.segments)
          parts.push(
            `${s.carrier}:${s.flight_number}:${s.origin}>${s.destination}:${s.departure}/${s.arrival}`,
          );
      }
      return parts.join("|");
    })
    .sort();
  return (
    "sha256:" +
    createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 32)
  );
}
export function trimPayload(body: Buffer, keep = 3): Buffer {
  const parts = body.toString("utf8").split("|");
  if (parts.length <= 6) return body;
  const $ = cheerio.load(`<div>${parts[6]}</div>`);
  const kept = $("div.list-item")
    .toArray()
    .slice(0, keep)
    .map((node, index) => {
      let id = "";
      $(node)
        .find("*")
        .addBack()
        .each((_, el) => {
          if (id) return;
          for (const attr of [
            "data-target",
            "data-bs-target",
            "href",
            "onclick",
          ]) {
            const match = ($(el).attr(attr) || "").match(/\bmyModal\d+\b/);
            if (match) {
              id = match[0];
              break;
            }
          }
        });
      const modal = $(`#${id || "myModal" + index}`);
      return ($.html(node) + (modal.length ? $.html(modal) : "")).replace(
        /myModal\d+/g,
        "myModal" + index,
      );
    });
  parts[6] = kept.join("");
  if (/^\d+$/.test(parts[1].trim()))
    parts[1] = String(Math.min(Number(parts[1]), kept.length));
  return Buffer.from(parts.join("|"));
}
export async function capture(
  source: string,
  q: Query,
  transport: Transport,
  directory: string,
  trim = false,
  keep = 3,
): Promise<Data> {
  mkdirSync(directory, { recursive: true });
  const exchanges: Data[] = [];
  const recording: Data = {
    source,
    recorded_at: now(),
    query: q,
    expect: {},
    exchanges,
  };
  const recorder: Transport = {
    open: async (cookies?: Cookie[], impersonate?: string) => {
      const inner = await transport.open(cookies, impersonate);
      return {
        request: async (method, url, options = {}) => {
          const response = await inner.request(method, url, options),
            body = `${String(exchanges.length + 1).padStart(3, "0")}.body`,
            cap = 2 * 1024 * 1024;
          let bytes = response.body;
          if (
            trim &&
            bytes.length >= 200000 &&
            ["ff-sky", "ff-kiwi"].includes(source)
          )
            bytes = trimPayload(bytes, keep);
          writeFileSync(join(directory, body), bytes.subarray(0, cap));
          exchanges.push({
            method,
            url,
            request_headers: options.headers || {},
            request_body:
              options.json || options.data
                ? JSON.stringify(options.json || options.data)
                : null,
            status: response.status,
            response_url: response.url,
            response_headers: response.headers,
            body,
            truncated: bytes.length > cap,
            bytes: bytes.length,
          });
          return response;
        },
        close: () => inner.close(),
      };
    },
    close: () => transport.close(),
  };
  try {
    const offers = await new Source(source, recorder).search(q);
    recording.expect = { offers: offers.length, digest: digestOffers(offers) };
  } catch (e) {
    recording.expect = {
      offers: 0,
      digest: digestOffers([]),
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  } finally {
    atomicJSON(join(directory, "index.json"), recording);
  }
  // The saved, potentially trimmed bytes are authoritative for the replay expectation.
  if (trim) {
    const player = new ReplayTransport(directory);
    try {
      const offers = await new Source(source, player).search(q);
      recording.expect = {
        offers: offers.length,
        digest: digestOffers(offers),
      };
    } catch (e) {
      recording.expect = {
        offers: 0,
        digest: digestOffers([]),
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      };
    }
    atomicJSON(join(directory, "index.json"), recording);
  }
  return recording;
}
