import type { FlightRow } from "./api";
import { Icon } from "./Icon";

export function FavoriteButton({ row, favorite, onToggle }: {
  row: FlightRow; favorite: boolean; onToggle: (key: string) => void;
}) {
  return <button type="button" className="favorite-button" aria-pressed={favorite}
    aria-label={`${favorite ? "Remove from" : "Add to"} favorites: ${row.route}, ${row.depart_date}${row.return_date ? ` to ${row.return_date}` : ""}, ${row.departure}`}
    title={favorite ? "Remove from favorites" : "Add to favorites"}
    onClick={(event) => { event.stopPropagation(); onToggle(row.trip_key); }}>
    <Icon name="star" />
  </button>;
}
