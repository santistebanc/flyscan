import { localClockSpans, type JourneyTiming, type TimelineScale } from "./flightTimeline";

const TICK_GAP = 24, LABEL_GAP = 88;
const tickSteps = [15, 30, 60, 120, 180, 360, 720, 1440];
const labelSteps = [60, 120, 180, 360, 720, 1440];
function interval(minimum: number, choices: number[]) {
  let step = choices.find((candidate) => candidate >= minimum) ?? 1440;
  while (step < minimum) step *= 2;
  return step;
}
const clockMinute = (wall: number) => ((wall % 1440) + 1440) % 1440;
const importance = (wall: number) => wall % 720 === 0 ? 4 : wall % 360 === 0 ? 3 : wall % 180 === 0 ? 2 : 1;
export interface HourTick { at: number; label: string | null }

/** Dense small ticks, sparse checkpoint labels; local clocks can advance or reverse
 * across flights while their positions continue to use true elapsed durations.
 */
export function timelineHourTicks(scale: Pick<TimelineScale, "min" | "max">, width: number, timing?: JourneyTiming): HourTick[] {
  const span = scale.max - scale.min;
  if (!Number.isFinite(scale.min) || !Number.isFinite(scale.max) || span <= 0 || !Number.isFinite(width) || width < 40) return [];
  const clocks = timing ? localClockSpans(timing, scale) : [{ from: scale.min, to: scale.max, start: scale.min, end: scale.max }];
  // Choose once from the whole plot. Timezone changes affect checkpoint
  // positions, never the local-clock interval within an individual segment.
  const step = interval(span * TICK_GAP / width, tickSteps);
  const labelStep = interval(Math.max(step * 2, span * LABEL_GAP / width), labelSteps);
  const candidates: (HourTick & { priority: number; x: number })[] = [];
  for (const clock of clocks) {
    const start = Math.max(scale.min, clock.start), end = Math.min(scale.max, clock.end);
    if (end <= start || clock.from === clock.to) continue;
    const wallAt = (at: number) => clock.from + (at - clock.start) / (clock.end - clock.start) * (clock.to - clock.from);
    const from = wallAt(start), to = wallAt(end);
    for (let wall = Math.ceil(Math.min(from, to) / step) * step; wall <= Math.max(from, to); wall += step) {
      const at = clock.start + (wall - clock.from) / (clock.to - clock.from) * (clock.end - clock.start);
      const minutes = clockMinute(wall);
      const label = wall % labelStep === 0 ? `${String(Math.floor(minutes / 60)).padStart(2, "0")}:00` : null;
      candidates.push({ at, label, x: (at - scale.min) / span * width, priority: label ? importance(wall) : 0 });
    }
  }
  // Deduplicate coincident segment boundaries without dropping compressed
  // in-flight ticks. Only labels may be omitted when their text would overlap.
  candidates.sort((a, b) => b.priority - a.priority || a.at - b.at);
  const ticks: typeof candidates = [], labels: number[] = [];
  for (const tick of candidates) {
    if (ticks.some((other) => Math.abs(other.x - tick.x) < .01)) continue;
    const center = Math.max(15, Math.min(width - 15, tick.x));
    if (tick.label && labels.some((x) => Math.abs(x - center) < LABEL_GAP)) tick.label = null;
    if (tick.label) labels.push(center);
    ticks.push(tick);
  }
  return ticks.sort((a, b) => a.at - b.at).map(({ at, label }) => ({ at, label }));
}
