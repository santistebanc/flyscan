import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { App } from "./api.js";
import { capture, digestOffers } from "./capture.js";
import { parseDate, query } from "./models.js";
import { Scheduler } from "./scheduler.js";
import { parseParams } from "./searches.js";
import { Source, allowedSources, labels, webMode } from "./sources.js";
import { FlightStore } from "./store.js";
import { ErrorLog, Places, Rates, readJSON, type Data } from "./support.js";
import {
  OfflineTransport,
  PythonTransport,
  ReplayTransport,
  type Transport,
} from "./transport.js";

const commands = [
  "serve",
  "scrape",
  "query",
  "places",
  "sources",
  "rates",
  "capture",
  "replay",
  "unblock",
  "prune",
  "cache",
  "errors",
];
function argumentsFor(argv: string[]): {
  command: string;
  values: Data;
  positionals: string[];
} {
  const command = commands.includes(argv[0]) ? argv.shift()! : "serve";
  // Preserve --sources a b and --sources a,b used by the original CLI.
  const expanded: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sources") {
      const names: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-"))
        names.push(argv[++i]);
      expanded.push("--sources", names.join(","));
    } else expanded.push(argv[i]);
  }
  const booleans = [
    "debug",
    "refresh",
    "summary",
    "status",
    "forget",
    "purge",
    "quiet",
    "verbose",
    "json",
    "clear",
    "trim",
    "help",
    "offline",
  ];
  const strings = [
    "host",
    "port",
    "db",
    "workers",
    "exit-with-parent",
    "origin",
    "destination",
    "start",
    "end",
    "max-stops",
    "sources",
    "top",
    "base-currency",
    "currency",
    "timeout",
    "retries",
    "cache-hours",
    "return",
    "ret",
    "ret-end",
    "adults",
    "children",
    "infants",
    "cabin",
    "prefer",
    "output",
    "out",
    "keep",
    "url",
    "wait",
    "before",
    "older-than",
    "restore",
    "limit",
    "where",
  ];
  const { values, positionals } = parseArgs({
    args: expanded,
    allowPositionals: true,
    options: Object.fromEntries([
      ...booleans.map((k) => [
        k,
        {
          type: "boolean" as const,
          ...(k === "quiet"
            ? { short: "q" }
            : k === "verbose"
              ? { short: "v" }
              : k === "help"
                ? { short: "h" }
                : {}),
        },
      ]),
      ...strings.map((k) => [k, { type: "string" as const }]),
    ]),
  });
  return {
    command,
    values: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k.replaceAll("-", "_"), v]),
    ),
    positionals,
  };
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, values: v, positionals: pos } = argumentsFor([...argv]);
  if (v.help) {
    console.log(
      "Flyscan: " +
        commands.join(", ") +
        "\nUse --offline to prohibit network access.\nserve [--host 127.0.0.1] [--port 5000] [--db flights.db] [--workers 12]\nscrape ORIGIN DESTINATION START [END] [--sources NAME,...] [--return DATE]\ncapture SOURCE ORIGIN DESTINATION START --out DIRECTORY\nreplay DIRECTORY",
    );
    return;
  }
  const backendRoot = resolve(dirname(process.argv[1]), "..");
  const bundledTransport = resolve(
    backendRoot,
    "flyscan-transport" + (process.platform === "win32" ? ".exe" : ""),
  );
  if (!process.env.FLYSCAN_TRANSPORT && existsSync(bundledTransport))
    process.env.FLYSCAN_TRANSPORT = bundledTransport;
  if (
    !process.env.FLYSCAN_FRONTEND &&
    existsSync(resolve(backendRoot, "frontend/index.html"))
  )
    process.env.FLYSCAN_FRONTEND = resolve(backendRoot, "frontend");
  process.env.FLYSCAN_TRANSPORT_SCRIPT ??= resolve(
    backendRoot,
    "../flyscan/transport.py",
  );
  if (!process.env.FLYSCAN_PYTHON) {
    const interpreter = resolve(
      backendRoot,
      "../.venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    if (existsSync(interpreter)) process.env.FLYSCAN_PYTHON = interpreter;
  }
  if (v.offline) process.env.FLYSCAN_OFFLINE = "1";
  if (process.env.FLYSCAN_DATA_DIR) {
    mkdirSync(process.env.FLYSCAN_DATA_DIR, { recursive: true });
    process.chdir(process.env.FLYSCAN_DATA_DIR);
  }
  const transport: Transport =
      process.env.FLYSCAN_OFFLINE === "1"
        ? new OfflineTransport()
        : new PythonTransport(),
    rates = new Rates(transport),
    places = new Places(transport),
    errors = new ErrorLog();
  const db = v.db === undefined ? "flights.db" : v.db;
  if (command === "sources") {
    console.table(
      allowedSources().map((name) => ({ name, label: labels[name] })),
    );
    return;
  }
  if (command === "replay") {
    if (!pos[0]) throw new Error("a recording directory is required");
    const replay = new ReplayTransport(resolve(pos[0])),
      q = query(replay.index.query),
      offers = await new Source(replay.index.source, replay).search(q);
    if (
      replay.index.expect?.offers !== undefined &&
      (offers.length !== replay.index.expect.offers ||
        (replay.index.expect.digest &&
          digestOffers(offers) !== replay.index.expect.digest))
    )
      throw new Error("recording outcome differs from its expectation");
    console.log(
      JSON.stringify(
        { source: replay.index.source, offers: offers.length, results: offers },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "places") {
    try {
      console.log(JSON.stringify(await places.search(pos.join(" ")), null, 2));
    } finally {
      await transport.close();
    }
    return;
  }
  if (command === "rates") {
    try {
      console.log(
        JSON.stringify(
          await rates.get(v.base_currency || "EUR", !!v.refresh),
          null,
          2,
        ),
      );
    } finally {
      await transport.close();
    }
    return;
  }
  if (command === "errors") {
    console.log(
      JSON.stringify(
        v.clear
          ? { cleared: errors.clear() }
          : v.json
            ? errors.recent(Number(v.limit || 10), v.where)
            : errors.summary(),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "capture") {
    if (pos.length < 4 || !v.out)
      throw new Error(
        "capture needs SOURCE ORIGIN DESTINATION START --out DIRECTORY",
      );
    const sourceName = pos[0];
    if (!allowedSources().includes(sourceName))
      throw new Error("unknown or disabled source");
    try {
      const origin = await places.resolve(pos[1]),
        destination = await places.resolve(pos[2]);
      const q = query({
        origin: origin.code,
        destination: destination.code,
        depart: parseDate(pos[3]),
        ret: v.ret ? parseDate(v.ret) : null,
        adults: Number(v.adults || 1),
        children: Number(v.children || 0),
        infants: Number(v.infants || 0),
        cabin: v.cabin || "economy",
        currency: v.currency || "EUR",
      });
      const recording = await capture(
        sourceName,
        q,
        transport,
        resolve(v.out),
        !!v.trim,
        Number(v.keep || 3),
      );
      console.log(
        JSON.stringify({
          source: sourceName,
          ...recording.expect,
          directory: resolve(v.out),
        }),
      );
      if (recording.expect.error) process.exitCode = 1;
    } finally {
      await transport.close();
    }
    return;
  }
  const store = db ? new FlightStore(db) : null,
    scheduler = new Scheduler(
      store,
      transport,
      rates,
      errors,
      Number(v.workers || (webMode() ? 4 : 12)),
      webMode() ? 128 : 10000,
    ),
    app = new App(
      scheduler,
      places,
      process.env.FLYSCAN_FRONTEND || resolve(backendRoot, "../desktop/dist"),
    );
  if (command === "serve") {
    if (v.restore) {
      const snapshot = readJSON(v.restore);
      scheduler.restore(snapshot.query_jobs, snapshot.captured_at);
    }
    const server = app.createServer(),
      port = Number(v.port || process.env.PORT || (webMode() ? 8080 : 5000)),
      host = v.host || (webMode() ? "0.0.0.0" : "127.0.0.1");
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      await app.close();
      throw new Error("invalid port");
    }
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        done();
      });
    }).catch(async (error) => {
      await app.close();
      throw error;
    });
    console.log(
      `Flyscan UI -> http://${host}:${(server.address() as any).port}`,
    );
    let stopping = false;
    const stop = async (force = false) => {
      if (stopping) {
        if (force) await transport.close(true);
        return;
      }
      stopping = true;
      server.close();
      server.closeAllConnections();
      await app.close(force);
      if (parentTimer) clearInterval(parentTimer);
      process.exitCode = 0;
    };
    const parents = [Number(v.exit_with_parent || 0)].filter((n) => n > 0),
      parentTimer = parents.length
        ? setInterval(() => {
            for (const pid of parents)
              try {
                process.kill(pid, 0);
              } catch {
                void stop(true);
              }
          }, 500)
        : null;
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    return;
  }
  try {
    if (command === "query") {
      if (!store) throw new Error("a database is required");
      const filters = {
        ...v,
        limit: Number(v.top || 25),
        max_stops: v.max_stops === undefined ? undefined : Number(v.max_stops),
        sources: v.sources?.split(","),
      };
      const rows = v.summary ? store.sourceSummary() : store.cheapest(filters);
      const table = await rates.get(v.base_currency || "EUR");
      const shown = v.summary
        ? rows.map((r) => ({
            ...r,
            cheapest: table.convert(r.cheapest, "EUR"),
            average: table.convert(r.average, "EUR"),
          }))
        : rows.map((r) => ({
            price: table.convert(r.price_base, "EUR"),
            currency: table.base,
            route: r.origin + "-" + r.destination,
            departure: r.departure_time,
            duration: r.duration_minutes,
            stops: r.stops,
            airlines: r.airlines,
            source: r.source,
          }));
      if (v.json) console.log(JSON.stringify(shown, null, 2));
      else console.table(shown);
    } else if (command === "prune") {
      if (!store) throw new Error("a database is required");
      console.log(JSON.stringify(store.purge(v.before)));
    } else if (command === "cache") {
      if (!store) throw new Error("a database is required");
      console.log(
        JSON.stringify(
          { stats: store.stats(), fetches: store.fetchSummary() },
          null,
          2,
        ),
      );
    } else if (command === "unblock") {
      const source = pos[0] || "ff-kayak";
      if (!allowedSources().includes(source))
        throw new Error("unknown or disabled source");
      if (v.status)
        console.log(
          JSON.stringify(scheduler.challenges.cookies.status(), null, 2),
        );
      else if (v.forget) {
        scheduler.challenges.cookies.clear(source);
        console.log("Stored cookies removed.");
      } else
        console.log(
          JSON.stringify(
            await scheduler.challenges.recover(
              source,
              v.url,
              Number(v.wait || 300),
            ),
            null,
            2,
          ),
        );
    } else if (command === "scrape") {
      if (pos.length < 3)
        throw new Error("scrape needs ORIGIN DESTINATION START [END]");
      const params = parseParams(
          {
            ...v,
            origin: pos[0],
            destination: pos[1],
            start: pos[2],
            end: pos[3],
            ret: v.return || v.ret,
            sources: v.sources?.split(","),
          },
          scheduler,
        ),
        { job } = app.searches.start({ ...params, output: v.output });
      const timer = setInterval(() => {}, 1000);
      try {
        await new Promise<void>((done) => {
          const unsubscribe = job.log.subscribe(0, (event) => {
            if (event === null) {
              done();
              return;
            }
            if (
              !v.quiet &&
              ["source_done", "challenge_required", "error"].includes(
                event.event,
              )
            )
              console.error(JSON.stringify(event));
          });
        });
        const table = await rates.get(v.base_currency || "EUR"),
          rows = job
            .results()
            .flatMap((d) => d.rows)
            .sort(
              (a, b) =>
                (a.best.price_base ?? Infinity) -
                (b.best.price_base ?? Infinity),
            )
            .slice(0, Number(v.top || 25));
        const shown = rows.map((r) => ({
          price: table.convert(r.best.price_base, "EUR"),
          currency: table.base,
          route: r.route,
          departure: r.departure,
          duration: r.duration,
          stops: r.stops,
          airlines: r.airlines,
          source: r.best.source,
          spread: r.spread,
        }));
        if (v.json) console.log(JSON.stringify(rows, null, 2));
        else console.table(shown);
        if (job.status === "failed") process.exitCode = 1;
      } finally {
        clearInterval(timer);
      }
    }
  } finally {
    await app.close();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
