import { RawPurchaseRow, MatchResult } from './types';
import { loadPersonIndex, matchAgainstIndex } from './person-index';

// Loads the club's people once for the whole batch and matches every row in
// memory (rules live in matchAgainstIndex, lib/purchase/person-index.ts).
export async function matchOrQueue(
  rows: RawPurchaseRow[],
  clubId: string
): Promise<{ matched: Map<string, MatchResult>; unmatched: RawPurchaseRow[] }> {
  const matched = new Map<string, MatchResult>();
  const unmatched: RawPurchaseRow[] = [];

  if (rows.length === 0) return { matched, unmatched };

  const index = await loadPersonIndex(clubId);
  for (const row of rows) {
    const result = matchAgainstIndex(row, index);
    if (result.matchStatus === 'unmatched') {
      unmatched.push(row);
    } else {
      matched.set(row.externalId, result);
    }
  }

  return { matched, unmatched };
}
