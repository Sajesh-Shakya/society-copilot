// Lightweight, dependency-free fuzzy match for filtering/highlighting an
// already-loaded roster client-side — not the same thing as
// search_person_by_name (the server-side pg_trgm search used by AddAttendee
// to find people to add). This just needs to tolerate a small typo while
// scanning names already on screen. An exact substring match always counts;
// otherwise falls back to edit distance against the name's individual words
// so "Smith" still matches "Smtih".
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export function fuzzyMatches(query: string, target: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const name = target.toLowerCase();
  if (name.includes(q)) return true;

  const maxDistance = q.length <= 4 ? 1 : 2;
  return name.split(/\s+/).some((word) => {
    if (word.includes(q) || q.includes(word)) return true;
    return levenshtein(q, word) <= maxDistance;
  });
}
