/** Logical scrape progress, independent of how many attempts or listeners it has. */
import type { SearchEvent } from "./api";

export interface LiveState {
  phase: "fetching" | "waiting" | "done" | "failed" | "challenge" | "skipped";
  count: number;
  startedAt: number | null;
  elapsed: number | null;
  error: string;
  ageHours: number | null;
}

interface ScrapeProgress extends LiveState {
  source: string;
  attempt: number;
  scrapeId: number | null;
}

export interface SearchProgress {
  total: number;
  lastSeq: number;
  scrapes: Record<string, ScrapeProgress>;
  sources: Record<string, LiveState>;
  counts: { total: number; done: number; failed: number; running: number };
}

export const emptyProgress = (): SearchProgress => ({
  total: 0, lastSeq: 0, scrapes: {}, sources: {},
  counts: { total: 0, done: 0, failed: 0, running: 0 },
});

const blank = (): LiveState => ({
  phase: "waiting", count: 0, startedAt: null, elapsed: null, error: "", ageHours: null,
});

export function reduceProgress(previous: SearchProgress, event: SearchEvent, now = Date.now()): SearchProgress {
  if (event.seq <= previous.lastSeq) return previous;
  if (event.event === "start") {
    return { ...emptyProgress(), total: event.jobs, lastSeq: event.seq,
      counts: { total: event.jobs, done: 0, failed: 0, running: 0 },
      sources: Object.fromEntries(event.sources.map((source) => [source, blank()])),
    };
  }
  if (event.event === "done") {
    const scrapes = Object.fromEntries(Object.entries(previous.scrapes).map(([key, scrape]) => [key,
      scrape.phase === "fetching" || scrape.phase === "waiting"
        ? { ...scrape, phase: "failed" as const, startedAt: null, error: scrape.error || "search ended" }
        : scrape,
    ]));
    return derive({ ...previous, scrapes, lastSeq: event.seq });
  }
  if (!["source_start", "source_retry", "source_done", "challenge_required"].includes(event.event)) return previous;
  if (!("source" in event) || !("day" in event)) return previous;
  const key = `${event.source}|${event.day}|${event.ret ?? ""}`;
  const old = previous.scrapes[key];
  const attempt = event.attempt ?? 0;
  if (old && old.scrapeId === event.scrape_id && attempt < old.attempt) return previous;
  let scrape: ScrapeProgress = {
    ...blank(), ...old, source: event.source, attempt, scrapeId: event.scrape_id ?? null,
  };
  if (event.event === "source_start") {
    scrape = { ...scrape, phase: "fetching", startedAt: now, error: "" };
  } else if (event.event === "source_retry") {
    scrape = { ...scrape, phase: "waiting", startedAt: null, error: event.message };
  } else if (event.event === "challenge_required") {
    scrape = { ...scrape, phase: "challenge", startedAt: null, error: "needs you to confirm you are human" };
  } else if (event.event === "source_done") {
    scrape = { ...scrape, phase: event.error ? "failed" : event.origin === "cache" ? "skipped" : "done",
      count: event.count, startedAt: null, elapsed: event.origin === "cache" ? null : event.elapsed,
      error: event.error, ageHours: event.age_hours,
    };
  }
  return derive({ ...previous, lastSeq: event.seq, scrapes: { ...previous.scrapes, [key]: scrape } });
}

function derive(state: SearchProgress): SearchProgress {
  const scrapes = Object.values(state.scrapes);
  const terminal = (scrape: ScrapeProgress) => ["done", "failed", "skipped"].includes(scrape.phase);
  const sources = { ...state.sources };
  for (const source of new Set(scrapes.map((scrape) => scrape.source))) {
    const jobs = scrapes.filter((scrape) => scrape.source === source);
    const shown = jobs.find((job) => job.phase === "fetching")
      ?? jobs.find((job) => job.phase === "challenge")
      ?? jobs.find((job) => job.phase === "waiting")
      ?? jobs.find((job) => job.phase === "failed") ?? jobs[jobs.length - 1];
    if (shown) sources[source] = { ...shown, count: jobs.reduce((sum, job) => sum + job.count, 0) };
  }
  return { ...state, sources, counts: {
    total: state.total, done: scrapes.filter(terminal).length,
    failed: scrapes.filter((job) => job.phase === "failed").length,
    running: scrapes.filter((job) => job.phase === "fetching").length,
  } };
}
