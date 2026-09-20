import { createAdminClient } from '@/lib/supabase/admin';
import { RawPurchaseRow, PurchaseRecord, IngestionResult, IngestionError, isStudentMemberType } from './types';
import { matchOrQueue } from './matcher';
import { z } from 'zod';

// Minimal shape validation for an incoming row. purchasedAt arrives as a
// real Date (parsed upstream by the Pluto/XLSX adapters), not a string.
const rawPurchaseRowSchema = z.object({
  externalId: z.string().min(1, 'externalId is required'),
  personName: z.string().min(1, 'personName is required'),
  personEmail: z.string().optional(),
  personCid: z.string().optional(),
  memberType: z.string(),
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
  let matched: Map<string, import('./types').MatchResult>;
  try {
    ({ matched } = await matchOrQueue(validRows));
  } catch (error) {
    // A transport-level throw would otherwise abort the whole batch with no
    // partial result. Degrade to "nothing matched" — every row still gets
    // inserted as unmatched rather than the admin seeing a bare failure.
    matched = new Map();
    console.warn('matchOrQueue threw; treating all rows as unmatched for this batch:', error);
  }

  // Step 3: Resolve each row's product, auto-creating a bare `kind: 'other'`
  // row when no product of that name exists yet. Known Phase-4-only
  // shortcut: real product curation (correct kind/covers_sessions for term
  // and annual passes) is deferred to the debt-calculation phase.
  const productMap = new Map<string, string>();
  const uniqueProductNames = [...new Set(validRows.map((row) => row.productName))];

  for (const productName of uniqueProductNames) {
    try {
      const { data: upserted, error: upsertError } = await admin
        .from('product')
        .upsert({ name: productName, kind: 'other' }, { onConflict: 'name', ignoreDuplicates: true })
        .select('id')
        .maybeSingle();

      if (upsertError) {
        console.warn(`Product upsert failed for "${productName}":`, upsertError.message);
        continue;
      }

      if (upserted) {
        productMap.set(productName, upserted.id);
        continue;
      }

      // ignoreDuplicates means an existing row returns no data from the
      // upsert itself — fetch it explicitly. Safe to use maybeSingle() here
      // because product.name is now unique.
      const { data: existing, error: lookupError } = await admin
        .from('product')
        .select('id')
        .eq('name', productName)
        .maybeSingle();

      if (!lookupError && existing) {
        productMap.set(productName, existing.id);
      } else if (lookupError) {
        console.warn(`Product lookup failed for "${productName}":`, lookupError.message);
      }
    } catch (error) {
      // A transport-level throw here would otherwise abort the whole batch.
      console.warn(`Product resolution threw for "${productName}":`, error);
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

    // MP-5: is_student derivation — see isStudentMemberType in types.ts for
    // the exact matching rule (shared with the identity matcher).
    const isStudent = isStudentMemberType(row.memberType);

    purchases.push({
      personId: matchResult?.personId ?? null,
      productId,
      source: row.source,
      sourceRowId: row.externalId,
      rawMemberType: row.memberType,
      rawPersonName: row.personName,
      rawEmail: row.personEmail ?? null,
      rawCid: row.personCid ?? null,
      isStudent,
      matchStatus: matchResult?.matchStatus ?? 'unmatched',
      purchasedAt: row.purchasedAt,
    });
  }

  // MP-5 / design.md: is_student reflects the *most recent* purchase by
  // date, not simply the last row processed. Determine, per matched person,
  // which purchase in this batch is their latest by purchasedAt — only that
  // one's is_student value gets applied below.
  const latestByPerson = new Map<string, (typeof purchases)[number]>();
  for (const purchase of purchases) {
    if (!purchase.personId) continue;
    const current = latestByPerson.get(purchase.personId);
    if (!current || purchase.purchasedAt > current.purchasedAt) {
      latestByPerson.set(purchase.personId, purchase);
    }
  }

  // Step 5: Insert idempotently. UNIQUE(source, source_row_id) makes a
  // repeat ingest (re-uploaded file, re-run poll) a duplicate, not an error.
  // On a fresh (non-duplicate) insert for a matched row, also sync the
  // derived is_student onto the person record -- design.md documents
  // person.is_student as "derived from Member Type at last known
  // purchase/signup". A duplicate does NOT re-trigger this, so re-running
  // the same ingest has no additional side effects.
  let inserted = 0;
  let duplicates = 0;

  for (const purchase of purchases) {
    try {
      const { error } = await admin.from('purchase').insert({
        person_id: purchase.personId,
        product_id: purchase.productId,
        source: purchase.source,
        source_row_id: purchase.sourceRowId,
        raw_member_type: purchase.rawMemberType,
        raw_person_name: purchase.rawPersonName,
        raw_email: purchase.rawEmail,
        raw_cid: purchase.rawCid,
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

        if (purchase.personId && latestByPerson.get(purchase.personId) === purchase) {
          const { error: updateError } = await admin
            .from('person')
            .update({ is_student: purchase.isStudent })
            .eq('id', purchase.personId);

          if (updateError) {
            errors.push({
              rowId: purchase.sourceRowId,
              reason: `Purchase inserted, but failed to update person.is_student: ${updateError.message}`,
              rawRow: rows.find((r) => r.externalId === purchase.sourceRowId)!,
            });
          }
        }
      }
    } catch (error) {
      // A transport-level throw for this one row shouldn't abort every
      // remaining row in the batch.
      errors.push({
        rowId: purchase.sourceRowId,
        reason: error instanceof Error ? error.message : 'Unexpected error during insert',
        rawRow: rows.find((r) => r.externalId === purchase.sourceRowId)!,
      });
    }
  }

  return { inserted, duplicates, errors };
}

export async function applyWaivers(_personId: string, _purchaseId: string): Promise<void> {
  // (Phase 5 scope — not this task; stub for interface completeness)
  throw new Error('Not implemented');
}
