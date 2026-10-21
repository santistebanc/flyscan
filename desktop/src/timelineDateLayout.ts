export const TIMELINE_DATE_ROW_HEIGHT = 18;
const GAP = 4;

/** Keep date labels inside the plot and give colliding labels separate rows. */
export function layoutTimelineDates(width: number, labels: { at: number; width: number }[]) {
  const rightEdges: number[] = [];
  const positions = labels.map((label) => {
    const labelWidth = Math.min(width, label.width);
    const left = Math.max(0, Math.min(width - labelWidth, label.at - labelWidth / 2));
    let row = rightEdges.findIndex((right) => left >= right + GAP);
    if (row < 0) row = rightEdges.length;
    rightEdges[row] = left + labelWidth;
    return { left, top: row * TIMELINE_DATE_ROW_HEIGHT };
  });
  return { positions, height: Math.max(1, rightEdges.length) * TIMELINE_DATE_ROW_HEIGHT };
}
