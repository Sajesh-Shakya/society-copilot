import { RawPurchaseRow, IngestionResult } from './types';

export async function ingestPurchases(rows: RawPurchaseRow[]): Promise<IngestionResult> {
  // 1. Validate each row with Zod
  // 2. Derive is_student from raw memberType
  // 3. Match each row to a person (or queue for manual review)
  // 4. Build purchase records
  // 5. Upsert via INSERT ... ON CONFLICT (source, source_row_id) DO NOTHING
  // 6. Return counts
  throw new Error('Not implemented');
}

export async function applyWaivers(personId: string, purchaseId: string): Promise<void> {
  // (Phase 5 scope — not this task; stub for interface completeness)
  throw new Error('Not implemented');
}
