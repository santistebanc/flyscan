import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "flight-favorites-v1";

export function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []);
    } catch { return new Set(); }
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...favorites])); }
    catch { /* Keep favorites usable in memory when storage is unavailable. */ }
  }, [favorites]);

  const toggleFavorite = useCallback((key: string) => setFavorites((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }), []);

  return { favorites, toggleFavorite };
}
