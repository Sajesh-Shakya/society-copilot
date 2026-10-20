import { createAdminClient } from '@/lib/supabase/admin';
import { RawPurchaseRow, PurchaseRecord, IngestionResult, IngestionError, isStudentMemberType } from './types';
import { matchOrQueue, matchPersonRecord } from './matcher';
import { z } from 'zod';

// Minimal shape validation for an incoming row. purchasedAt arrives as a
// real Date (parsed upstream by the Pluto/XLSX adapters), not a string.
// Either productId (the XLSX path -- an admin-selected product applied to
// every row, since real exports have no product column) or productName
// (the Pluto API path, if a future adapter reports one per row) must be
// present; Step 3 below resolves whichever one is.
const rawPurchaseRowSchema = z
  .object({
    externalId: z.string().min(1, 'externalId is required'),
    personName: z.string().min(1, 'personName is required'),
    personEmail: z.string().optional(),
    personCid: z.string().optional(),
    memberType: z.string(),
    productId: z.string().optional(),
    productName: z.string().optional(),
    uploadId: z.string().optional(),
    purchasedAt: z.date({ message: 'purchasedAt must be a valid Date' }),
    source: z.enum(['pluto_api', 'xlsx_upload']),
  })
  .refine((row) => Boolean(row.productId || row.productName), {
    message: 'either productId or productName is required',
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

  // Step 3: Resolve each row's product. A row with an explicit productId
  // (the XLSX path -- an admin picked a real, already-curated product
  // before uploading) uses it directly, no lookup needed. Only a row
  // relying on productName (the Pluto API path) goes through the
  // by-name upsert, auto-creating a bare `kind: 'other'` row if none
  // exists yet for that name.
  const productMap = new Map<string, string>();
  const uniqueProductNames = [
    ...new Set(validRows.filter((row) => !row.productId && row.productName).map((row) => row.productName!)),
  ];

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
    const productId = row.productId ?? productMap.get(row.productName!);
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
      uploadId: row.uploadId ?? null,
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
      const { data: insertedPurchase, error } = await admin
        .from('purchase')
        .insert({
          person_id: purchase.personId,
          product_id: purchase.productId,
          upload_id: purchase.uploadId,
          source: purchase.source,
          source_row_id: purchase.sourceRowId,
          raw_member_type: purchase.rawMemberType,
          raw_person_name: purchase.rawPersonName,
          raw_email: purchase.rawEmail,
          raw_cid: purchase.rawCid,
          match_status: purchase.matchStatus,
          purchased_at: purchase.purchasedAt.toISOString(),
        })
        .select('id')
        .single();

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

        if (purchase.personId && insertedPurchase) {
          try {
            await applyWaivers(purchase.personId, insertedPurchase.id);
          } catch (waiverError) {
            errors.push({
              rowId: purchase.sourceRowId,
              reason: `Purchase inserted, but waiver assignment failed: ${
                waiverError instanceof Error ? waiverError.message : 'unknown error'
              }`,
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

// MP-3: waive as much of personId's currently-outstanding debt as this
// purchase covers. See apply_purchase_waiver in
// supabase/migrations/20260920130000_add_purchase_waiver_function.sql for
// the exact per-product-kind rule. Returns the number of attendance rows
// waived (0 if the product's kind doesn't waive anything yet, e.g. the
// Phase-4 ingestion shortcut's auto-created 'other' products).
export async function applyWaivers(personId: string, purchaseId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('apply_purchase_waiver', {
    target_purchase_id: purchaseId,
  });

  if (error) {
    throw new Error(
      `Failed to apply waiver for purchase ${purchaseId} (person ${personId}): ${error.message}`
    );
  }

  return data ?? 0;
}

export interface RematchResult {
  matched: number;
  stillUnmatched: number;
}

/**
 * Re-runs matching for every currently-unmatched purchase and applies any
 * waiver it unlocks. Matching only ever ran once, at upload time -- if the
 * buyer's person record (or their person.cid) didn't exist yet at that
 * exact moment (e.g. the purchase was logged before they ever attended a
 * session, or their CID was only recorded moments later via the walk-in
 * form), the row stays unmatched forever unless something re-checks it.
 * Exposed as an admin action (lib/purchase/actions.ts) so this is a button
 * on the purchases page rather than a one-off script every time it
 * recurs.
 */
export async function rematchUnmatchedPurchases(): Promise<RematchResult> {
  const admin = createAdminClient();

  const { data: unmatched, error } = await admin
    .from('purchase')
    .select('id, raw_person_name, raw_cid, raw_email, raw_member_type, purchased_at')
    .eq('match_status', 'unmatched');
  if (error) throw error;

  let matched = 0;
  let stillUnmatched = 0;

  for (const p of unmatched ?? []) {
    const row: RawPurchaseRow = {
      externalId: p.id,
      personName: p.raw_person_name,
      personEmail: p.raw_email ?? undefined,
      personCid: p.raw_cid ?? undefined,
      memberType: p.raw_member_type ?? '',
      productId: 'unused', // matchPersonRecord doesn't read product
      purchasedAt: new Date(p.purchased_at),
      source: 'xlsx_upload',
    };

    const result = await matchPersonRecord(row);
    if (result.matchStatus === 'unmatched') {
      stillUnmatched++;
      continue;
    }

    const { error: updateError } = await admin
      .from('purchase')
      .update({ person_id: result.personId, match_status: result.matchStatus })
      .eq('id', p.id);
    if (updateError) throw updateError;

    await applyWaivers(result.personId!, p.id);
    matched++;
  }

  return { matched, stillUnmatched };
}

export interface UploadBatch {
  id: string;
  productId: string;
  productName: string;
  filename: string | null;
  rowCount: number;
  uploadedBy: string | null;
  createdAt: string;
}

/**
 * The last N XLSX upload batches (newest first), for the "recent uploads"
 * list that lets an admin correct or undo an accidental wrong-product
 * upload. See changeUploadProduct/undoUpload below.
 */
export async function listRecentUploads(limit = 5): Promise<UploadBatch[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('purchase_upload')
    .select('id, product_id, filename, row_count, uploaded_by, created_at, product:product_id(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((u) => {
    // supabase-js types a to-one FK select as an array; always exactly
    // one row since product_id is not-null with a FK.
    const product = Array.isArray(u.product) ? u.product[0] : u.product;
    return {
      id: u.id,
      productId: u.product_id,
      productName: product?.name ?? 'Unknown product',
      filename: u.filename,
      rowCount: u.row_count,
      uploadedBy: u.uploaded_by,
      createdAt: u.created_at,
    };
  });
}

/**
 * Corrects an accidental wrong-product upload after the fact: re-points
 * every purchase in the batch at the new product, and re-applies waivers
 * under the new product's rules. Un-waives first -- the old product may
 * have waived a different count or a different set of sessions than the
 * new one will (e.g. a 10-session batch pass wrongly uploaded as a
 * single-session pass would have only waived 1 session; correcting it
 * should let the other 9 waive too, which can't happen while they're
 * still marked waived by the same purchase under the stale rule).
 */
export async function changeUploadProduct(
  uploadId: string,
  newProductId: string
): Promise<{ purchasesUpdated: number; rewaived: number }> {
  const admin = createAdminClient();

  const { data: purchases, error } = await admin
    .from('purchase')
    .select('id, person_id')
    .eq('upload_id', uploadId);
  if (error) throw error;
  if (!purchases || purchases.length === 0) {
    return { purchasesUpdated: 0, rewaived: 0 };
  }

  const purchaseIds = purchases.map((p) => p.id);

  const { error: unwaiveError } = await admin
    .from('attendance_record')
    .update({ waived_by_purchase_id: null })
    .in('waived_by_purchase_id', purchaseIds);
  if (unwaiveError) throw unwaiveError;

  const { error: updatePurchasesError } = await admin
    .from('purchase')
    .update({ product_id: newProductId })
    .eq('upload_id', uploadId);
  if (updatePurchasesError) throw updatePurchasesError;

  const { error: updateUploadError } = await admin
    .from('purchase_upload')
    .update({ product_id: newProductId })
    .eq('id', uploadId);
  if (updateUploadError) throw updateUploadError;

  let rewaived = 0;
  for (const p of purchases) {
    if (!p.person_id) continue;
    rewaived += await applyWaivers(p.person_id, p.id);
  }

  return { purchasesUpdated: purchaseIds.length, rewaived };
}

/**
 * Fully reverses an upload: un-waives anything it waived, deletes every
 * purchase row it created, then deletes the batch itself. For "I uploaded
 * completely the wrong file" rather than "right file, wrong product" (use
 * changeUploadProduct for that instead, which is non-destructive).
 */
export async function undoUpload(uploadId: string): Promise<{ deletedPurchases: number }> {
  const admin = createAdminClient();

  const { data: purchases, error } = await admin.from('purchase').select('id').eq('upload_id', uploadId);
  if (error) throw error;
  const purchaseIds = (purchases ?? []).map((p) => p.id);

  if (purchaseIds.length > 0) {
    const { error: unwaiveError } = await admin
      .from('attendance_record')
      .update({ waived_by_purchase_id: null })
      .in('waived_by_purchase_id', purchaseIds);
    if (unwaiveError) throw unwaiveError;

    const { error: deleteError } = await admin.from('purchase').delete().in('id', purchaseIds);
    if (deleteError) throw deleteError;
  }

  const { error: deleteUploadError } = await admin.from('purchase_upload').delete().eq('id', uploadId);
  if (deleteUploadError) throw deleteUploadError;

  return { deletedPurchases: purchaseIds.length };
}
