/**
 * Keeps the Upcoming list quiet: every non-series session is kept, and at most
 * `perSeries` sessions of each series (the first ones in input order). Input
 * order is preserved; the dropped sessions are returned per series, in input order.
 */
export function limitUpcomingPerSeries<T extends { id: string; seriesId: string | null }>(
  sessions: T[],
  perSeries: number
): { shown: T[]; hiddenBySeries: Map<string, T[]> } {
  const keptCount = new Map<string, number>();
  const hiddenBySeries = new Map<string, T[]>();
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
      const hidden = hiddenBySeries.get(session.seriesId);
      if (hidden) hidden.push(session);
      else hiddenBySeries.set(session.seriesId, [session]);
    }
  }

  return { shown, hiddenBySeries };
}
