import { useState } from "react";
import type { FlightRow } from "./api";
import { Icon } from "./Icon";

type Motion = "favorite" | "unfavorite";

export function FavoriteButton({ row, favorite, onToggle }: {
  row: FlightRow; favorite: boolean; onToggle: (key: string) => void;
}) {
  // Animate only when the prop changes after mount, so first render and remounts stay still.
  const [seen, setSeen] = useState(favorite);
  const [stored, setMotion] = useState<Motion | null>(null);
  let motion = stored;
  if (seen !== favorite) {
    motion = prefersReducedMotion() ? null : favorite ? "favorite" : "unfavorite";
    setSeen(favorite);
    setMotion(motion);
  }
  return <button type="button" className="favorite-button" aria-pressed={favorite}
    aria-label={`${favorite ? "Remove from" : "Add to"} favorites: ${row.route}, ${row.depart_date}${row.return_date ? ` to ${row.return_date}` : ""}, ${row.departure}`}
    title={favorite ? "Remove from favorites" : "Add to favorites"}
    data-motion={motion ?? undefined}
    onAnimationEnd={() => setMotion(null)}
    onClick={(event) => { event.stopPropagation(); onToggle(row.trip_key); }}>
    <Icon name="star" />
  </button>;
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
