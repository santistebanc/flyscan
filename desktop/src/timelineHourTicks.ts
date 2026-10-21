import type { TimelineScale } from "./flightTimeline";

/** Rounded hours on the departure-clock reference, independent of viewer timezone. */
export function timelineHourTicks(scale: Pick<TimelineScale, "min" | "max">, width: number) {
  const span = scale.max - scale.min;
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(width) || width < 40) return [];
  // Leave room for a five-character clock label and comfortable separation.
  const minimumStep = span * 64 / width;
  const steps = [60, 120, 180, 360, 720, 1440];
  let step = steps.find((candidate) => candidate >= minimumStep) ?? 1440;
  while (step < minimumStep) step *= 2;
  const ticks: { at: number; label: string }[] = [];
  for (let at = Math.ceil(scale.min / step) * step; at <= scale.max; at += step) {
    const clockMinute = ((at % 1440) + 1440) % 1440;
    ticks.push({ at, label: `${String(Math.floor(clockMinute / 60)).padStart(2, "0")}:00` });
  }
  return ticks;
}
