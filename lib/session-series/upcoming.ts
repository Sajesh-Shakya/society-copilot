/**
 * Keeps the Upcoming list quiet: every non-series session is kept, and at most
 * `perSeries` sessions of each series (the first ones in input order). Input
 * order is preserved; the dropped sessions are counted per series.
 */
export function limitUpcomingPerSeries<T extends { id: string; seriesId: string | null }>(
  sessions: T[],
  perSeries: number
): { shown: T[]; hiddenCountBySeries: Map<string, number> } {
  const keptCount = new Map<string, number>();
  const hiddenCountBySeries = new Map<string, number>();
  const shown: T[] = [];

  for (const session of sessions) {
    if (session.seriesId === null) {
      shown.push(session);
      continue;
    }
    const kept = keptCount.get(session.seriesId) ?? 0;
    if (kept < perSeries) {
      keptCount.set(session.seriesId, kept + 1);
      shown.push(session);
    } else {
      hiddenCountBySeries.set(
        session.seriesId,
        (hiddenCountBySeries.get(session.seriesId) ?? 0) + 1
      );
    }
  }

  return { shown, hiddenCountBySeries };
}
