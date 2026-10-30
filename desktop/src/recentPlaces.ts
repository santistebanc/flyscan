/**
 * Recently picked airports/cities for the From/To suggestions.
 *
 * Empty query → most recent. Otherwise match by IATA prefix or substring in
 * the saved label, same idea as flyscan's recentAirports.
 */

const STORAGE_KEY = "flyscan:recent-places";
const MAX_RECENTS = 12;

export interface RecentPlace {
  code: string;
  label: string;
  usedAt: number;
}

function safeParse(raw: string | null): RecentPlace[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .map((row): RecentPlace | null => {
        if (!row || typeof row !== "object") return null;
        const r = row as Record<string, unknown>;
        const code = typeof r.code === "string" ? r.code.trim().toUpperCase() : "";
        const label = typeof r.label === "string" ? r.label.trim() : "";
        const usedAt = typeof r.usedAt === "number" ? r.usedAt : 0;
        if (!/^[A-Z]{3}$/.test(code)) return null;
        return { code, label, usedAt };
      })
      .filter((x): x is RecentPlace => Boolean(x));
  } catch {
    return [];
  }
}

export function readRecentPlaces(): RecentPlace[] {
  if (typeof localStorage === "undefined") return [];
  return safeParse(localStorage.getItem(STORAGE_KEY)).sort((a, b) => b.usedAt - a.usedAt);
}

export function rememberPlace(code: string, label?: string): void {
  if (typeof localStorage === "undefined") return;
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) return;
  const prevAll = readRecentPlaces();
  const existing = prevAll.find((x) => x.code === c);
  const lbl = (label?.trim() || existing?.label || "").slice(0, 200);
  const prev = prevAll.filter((x) => x.code !== c);
  const next = [{ code: c, label: lbl, usedAt: Date.now() }, ...prev].slice(0, MAX_RECENTS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

/** Empty term → most recent; otherwise prefix / substring match. */
export function filterRecentPlaces(recents: RecentPlace[], termRaw: string): RecentPlace[] {
  const term = termRaw.trim().toUpperCase();
  if (term.length === 0) return recents.slice(0, 8);
  return recents
    .filter((r) => {
      if (term.length <= 3 && r.code.startsWith(term)) return true;
      const hay = `${r.code} ${r.label}`.toUpperCase();
      return hay.includes(term);
    })
    .slice(0, 8);
}

export function placeLabel(name: string, country: string): string {
  const bits = [name.trim()].filter(Boolean);
  if (country.trim()) bits.push(country.trim());
  return bits.join(", ");
}
