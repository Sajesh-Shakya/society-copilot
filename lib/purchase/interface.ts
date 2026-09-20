import { createAdminClient } from '@/lib/supabase/admin';
import { RawPurchaseRow, PurchaseRecord, IngestionResult, IngestionError } from './types';
import { matchOrQueue } from './matcher';
import { z } from 'zod';

// Minimal shape validation for an incoming row. purchasedAt arrives as a
// real Date (parsed upstream by the Pluto/XLSX adapters), not a string.
const rawPurchaseRowSchema = z.object({
  externalId: z.string().min(1, 'externalId is required'),
  personName: z.string().min(1, 'personName is required'),
  personEmail: z.string().optional(),
  personCid: z.string().optional(),
  memberType: z.string().min(1, 'memberType is required'),
  productName: z.string().min(1, 'productName is required'),
  purchasedAt: z.date({ message: 'purchasedAt must be a valid Date' }),
  source: z.enum(['pluto_api', 'xlsx_upload']),
});

export async function ingestPurchases(rows: RawPurchaseRow[]): Promise<IngestionResult> {
  const admin = createAdminClient();
  const errors: IngestionError[] = [];

  // Step 1: Validate each row with Zod. Invalid rows are reported as errors
  // and excluded from every later step.
  const validRows: RawPurchaseRow[] = [];
  for (const row of rows) {
    const parsed = rawPurchaseRowSchema.safeParse(row);
    if (parsed.success) {
      validRows.push(row);
    } else {
      errors.push({
        rowId: row.externalId,
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
        rawRow: row,
      });
    }
  }

  if (validRows.length === 0) {
    return { inserted: 0, duplicates: 0, errors };
  }

  // Step 2: Match rows to people (or queue for manual review). matchOrQueue
  // only populates `matched` for rows it actually matched; anything else
  // (including everything in its `unmatched` list) falls through to the
  // 'unmatched' default below.
  const { matched } = await matchOrQueue(validRows);

  // Step 3: Resolve each row's product, auto-creating a bare `kind: 'other'`
  // row when no product of that name exists yet. Known Phase-4-only
  // shortcut: real product curation (correct kind/covers_sessions for term
  // and annual passes) is deferred to the debt-calculation phase.
  const productMap = new Map<string, string>();
  const uniqueProductNames = [...new Set(validRows.map((row) => row.productName))];

  for (const productName of uniqueProductNames) {
    const { data: existing, error: lookupError } = await admin
      .from('product')
      .select('id')
      .eq('name', productName)
      .maybeSingle();

    if (lookupError) {
      // Leave unresolved; every row referencing this product becomes an
      // error in Step 4 rather than silently being dropped.
      continue;
    }

    if (existing) {
      productMap.set(productName, existing.id);
      continue;
    }

    const { data: created, error: createError } = await admin
      .from('product')
      .insert({ name: productName, kind: 'other' })
      .select('id')
      .single();

    if (!createError && created) {
      productMap.set(productName, created.id);
    }
  }

  // Step 4: Build purchase records, deriving is_student and match status.
  const purchases: (PurchaseRecord & { sourceRowId: string })[] = [];

  for (const row of validRows) {
    const productId = productMap.get(row.productName);
    if (!productId) {
      errors.push({
        rowId: row.externalId,
        reason: `Could not resolve or create product "${row.productName}"`,
        rawRow: row,
      });
      continue;
    }

    const matchResult = matched.get(row.externalId);

    // MP-5: is_student = true ONLY on an exact "Student" match; every other
    // observed or future value (Public, Associate, Staff, unrecognized)
    // defaults to false. Deliberately case-sensitive, exact string equality
    // -- not a substring or case-insensitive match.
    const isStudent = row.memberType === 'Student';

    purchases.push({
      personId: matchResult?.personId ?? null,
      productId,
      source: row.source,
      sourceRowId: row.externalId,
      rawMemberType: row.memberType,
      isStudent,
      matchStatus: matchResult?.matchStatus ?? 'unmatched',
      purchasedAt: row.purchasedAt,
    });
  }

  // Step 5: Insert idempotently. UNIQUE(source, source_row_id) makes a
  // repeat ingest (re-uploaded file, re-run poll) a duplicate, not an error.
  let inserted = 0;
  let duplicates = 0;

  for (const purchase of purchases) {
    const { error } = await admin.from('purchase').insert({
      person_id: purchase.personId,
      product_id: purchase.productId,
      source: purchase.source,
      source_row_id: purchase.sourceRowId,
      raw_member_type: purchase.rawMemberType,
      match_status: purchase.matchStatus,
      purchased_at: purchase.purchasedAt.toISOString(),
    });

    if (error) {
      if (error.code === '23505') {
        // UNIQUE(source, source_row_id) violation -- already ingested.
        duplicates++;
      } else {
        errors.push({
          rowId: purchase.sourceRowId,
          reason: error.message,
          rawRow: rows.find((r) => r.externalId === purchase.sourceRowId)!,
        });
      }
    } else {
      inserted++;
    }
  }

  return { inserted, duplicates, errors };
}

export async function applyWaivers(personId: string, purchaseId: string): Promise<void> {
  // (Phase 5 scope — not this task; stub for interface completeness)
  throw new Error('Not implemented');
}
