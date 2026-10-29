import type { FlightRow } from "./api";
import { Icon } from "./Icon";

/**
 * A price's state as a small icon, explained on hover: amber pencil when the
 * price shown is the person's correction, blue refresh when a newer source
 * quote has set their correction aside.
 */
export interface PriceMarkProps { kind: "corrected" | "requoted"; note: string }
const ICONS = { corrected: "edit", requoted: "retry" } as const;

/** The marks for a flight's headline price: its cheapest offer's. */
export function priceMarks(row: FlightRow, money: (eur: number | null | undefined) => string): PriceMarkProps[] {
  const best = row.best;
  if (!best) return [];
  const seller = best.agent || best.source;
  if (best.manual_price) return [{ kind: "corrected",
    note: `Your corrected price. ${seller} quoted ${money(best.original_price_base)}.` }];
  if (best.stale_price_base !== undefined) return [{ kind: "requoted",
    note: `${seller} quoted this after you corrected it to ${money(best.stale_price_base)}. Reapply it from the seller's price button.` }];
  return [];
}

export function PriceMark({ kind, note }: PriceMarkProps) {
  return <span className="price-mark" data-kind={kind} role="img" aria-label={note} title={note}><Icon name={ICONS[kind]} /></span>;
}
