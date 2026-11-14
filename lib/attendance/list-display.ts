/**
 * Splits an already-ordered list into the first `visibleCount` items to show
 * and the remainder to fold behind a drop-down. Keeps input order and does
 * not mutate the input.
 */
export function splitSessionsForDisplay<T>(
  items: T[],
  visibleCount: number,
): { shown: T[]; folded: T[] } {
  const n = Math.max(0, visibleCount);
  return { shown: items.slice(0, n), folded: items.slice(n) };
}
