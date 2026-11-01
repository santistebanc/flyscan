/** List: the flights in rows beside the panel. Trip: one trip at a time across the window. */
export type Layout = "list" | "trip";
export const LAYOUT_KEY = "flyscan.layout";
export function normalizeLayout(value: unknown): Layout {
  return value === "trip" ? "trip" : "list";
}

const HINTS: Record<Layout, string> = {
  list: "Every flight in rows, the selected one in the side panel",
  trip: "One trip at a time across the window, with Prev and Next",
};

/** Two buttons, styled as the sort's, since both are one choice of how to look at the same flights. */
export function LayoutToggle({ layout, onChange }: { layout: Layout; onChange: (layout: Layout) => void }) {
  return <div className="sort-options layout-toggle" role="group" aria-label="Layout">
    {(["list", "trip"] as const).map((option) => <span key={option} className="sort-option" data-active={option === layout || undefined}>
      <button type="button" aria-pressed={option === layout} title={HINTS[option]} onClick={() => onChange(option)}>
        {option === "list" ? "List" : "Trip"}
      </button>
    </span>)}
  </div>;
}
