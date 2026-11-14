import { createClubScopedClient } from "@/lib/supabase/club-scoped";

// PostgREST `.in()` filters travel in the URL, so keep each chunk small.
const CHUNK_SIZE = 100;
const MAX_IN_FLIGHT = 5;

/**
 * Returns which of the given source_row_ids already exist in `purchase` for
 * this club + source, so callers can skip rows that were ingested before.
 */
export async function findExistingSourceRowIds(
  clubId: string,
  source: "pluto_api" | "xlsx_upload",
  ids: string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  if (ids.length === 0) return found;

  const db = createClubScopedClient(clubId);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) chunks.push(ids.slice(i, i + CHUNK_SIZE));

  for (let i = 0; i < chunks.length; i += MAX_IN_FLIGHT) {
    const results = await Promise.all(
      chunks.slice(i, i + MAX_IN_FLIGHT).map(async (chunk) => {
        const { data, error } = await db
          .from("purchase")
          .select("source_row_id")
          .eq("source", source)
          .in("source_row_id", chunk);
        if (error) throw new Error(`findExistingSourceRowIds failed: ${error.message}`);
        return (data ?? []) as unknown as { source_row_id: string }[];
      })
    );
    for (const rows of results) for (const row of rows) found.add(row.source_row_id);
  }
  return found;
}
