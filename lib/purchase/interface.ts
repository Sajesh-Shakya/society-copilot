import { createAdminClient } from '@/lib/supabase/admin';
import { createClubScopedClient } from '@/lib/supabase/club-scoped';
import { RawPurchaseRow, PurchaseRecord, IngestionResult, IngestionError, isStudentMemberType } from './types';
import { matchOrQueue } from './matcher';
import { findExistingSourceRowIds } from './existing';
import { loadPersonIndex, matchAgainstIndex } from './person-index';
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

const INSERT_CHUNK_SIZE = 200;
const FOLLOW_UP_CONCURRENCY = 5;

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

export async function ingestPurchases(
  allRows: RawPurchaseRow[],
  clubId: string,
  options: { skipExistingCheck?: boolean } = {}
): Promise<IngestionResult> {
  const scoped = createClubScopedClient(clubId);
  const errors: IngestionError[] = [];
  let duplicates = 0;
  const rowKey = (source: string, externalId: string) => `${source}\u0000${externalId}`;
  const rawRowByKey = new Map<string, RawPurchaseRow>();
  for (const row of allRows) {
    const key = rowKey(row.source, row.externalId);
    if (!rawRowByKey.has(key)) rawRowByKey.set(key, row);
  }
  const rawRowFor = (source: string, externalId: string) => rawRowByKey.get(rowKey(source, externalId))!;

  // Step 1: Validate each row with Zod. Invalid rows are reported as errors
  // and excluded from every later step.
  const validRows: RawPurchaseRow[] = [];
  const seenInBatch = new Set<string>();
  for (const row of allRows) {
    const parsed = rawPurchaseRowSchema.safeParse(row);
    if (parsed.success) {
      // A repeat of the same (source, externalId) inside one call is a
      // duplicate. Dropping it here also keeps a chunked upsert from hitting
      // Postgres' "ON CONFLICT DO UPDATE command cannot affect row a second
      // time" error.
      const key = rowKey(row.source, row.externalId);
      if (seenInBatch.has(key)) {
        duplicates++;
        continue;
      }
      seenInBatch.add(key);
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

  // Step 1b: Drop rows already ingested (unless the caller knows the batch is
  // fresh). Not caught on purpose: if this lookup fails, failing loudly beats
  // silently re-ingesting everything.
  let newRows = validRows;
  if (!options.skipExistingCheck && validRows.length > 0) {
    const idsBySource = new Map<RawPurchaseRow['source'], string[]>();
    for (const row of validRows) {
      const ids = idsBySource.get(row.source) ?? [];
      ids.push(row.externalId);
      idsBySource.set(row.source, ids);
    }
    const existingBySource = new Map<string, Set<string>>();
    for (const [source, ids] of idsBySource) {
      existingBySource.set(source, await findExistingSourceRowIds(clubId, source, ids));
    }
    newRows = validRows.filter((row) => !existingBySource.get(row.source)!.has(row.externalId));
    duplicates += validRows.length - newRows.length;
  }

  if (newRows.length === 0) {
    return { inserted: 0, duplicates, errors };
  }

  // Step 2: Match rows to people (or queue for manual review). matchOrQueue
  // only populates `matched` for rows it actually matched; anything else
  // (including everything in its `unmatched` list) falls through to the
  // 'unmatched' default below.
  let matched: Map<string, import('./types').MatchResult>;
  try {
    ({ matched } = await matchOrQueue(validRows, clubId));
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
    ...new Set(newRows.filter((row) => !row.productId && row.productName).map((row) => row.productName!)),
  ];

  for (const productName of uniqueProductNames) {
    try {
      const { data: upserted, error: upsertError } = await scoped
        .from('product')
        .upsert({ name: productName, kind: 'other' }, { onConflict: 'club_id,name', ignoreDuplicates: true })
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
      // upsert itself — fetch it explicitly. product.name is now unique only
      // per club_id (not globally); createClubScopedClient's select()
      // already filters to this club, so another club's same-named product
      // can't collide with this lookup.
      const { data: existing, error: lookupError } = await scoped
        .from('product')
        .select('id')
        .eq('name', productName)
        .maybeSingle();

      if (!lookupError && existing) {
        const typedExisting = existing as unknown as { id: string };
        productMap.set(productName, typedExisting.id);
      } else if (lookupError) {
        console.warn(`Product lookup failed for "${productName}":`, lookupError.message);
      }
    } catch (error) {
      // A transport-level throw here would otherwise abort the whole batch.
      console.warn(`Product resolution threw for "${productName}":`, error);
    }
  }

  // Snapshot each product's current price onto the purchases created now, so
  // a later price edit never changes past revenue.
  const priceByProductId = new Map<string, number | null>();
  const resolvedProductIds = [
    ...new Set(
      newRows
        .map((row) => row.productId ?? (row.productName ? productMap.get(row.productName) : undefined))
        .filter((id): id is string => Boolean(id))
    ),
  ];
  if (resolvedProductIds.length > 0) {
    const { data: priced, error: priceError } = await scoped
      .from('product')
      .select('id, price_pence')
      .in('id', resolvedProductIds);
    if (priceError) {
      console.warn('Product price lookup failed; purchases will be unpriced:', priceError.message);
    } else {
      for (const p of (priced ?? []) as unknown as { id: string; price_pence: number | null }[]) {
        priceByProductId.set(p.id, p.price_pence ?? null);
      }
    }
  }

  // Step 4: Build purchase records, deriving is_student and match status.
  const purchases: (PurchaseRecord & { sourceRowId: string })[] = [];

  for (const row of newRows) {
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
      pricePence: priceByProductId.get(productId) ?? null,
    });
  }

  // MP-5 / design.md: is_student reflects the *most recent* purchase by
  // date, not simply the last row processed. Determine, per matched person,
  // which purchase in this batch is their latest by purchasedAt — only that
  // one's is_student value gets applied below.
  // Rows skipped as already ingested still compete for "latest": an older new
  // row must not override a newer, already-applied purchase. Their entry has
  // purchase: null, so nothing is applied if one of them wins.
  const latestByPerson = new Map<string, { purchasedAt: Date; purchase: (typeof purchases)[number] | null }>();
  const builtByKey = new Map(purchases.map((p) => [rowKey(p.source, p.sourceRowId), p]));
  const newKeys = new Set(newRows.map((r) => rowKey(r.source, r.externalId)));
  for (const row of validRows) {
    const key = rowKey(row.source, row.externalId);
    const purchase = builtByKey.get(key) ?? null;
    if (purchase === null && newKeys.has(key)) continue; // failed product resolution
    const personId = purchase ? purchase.personId : (matched.get(row.externalId)?.personId ?? null);
    if (!personId) continue;
    const current = latestByPerson.get(personId);
    if (!current || row.purchasedAt > current.purchasedAt) {
      latestByPerson.set(personId, { purchasedAt: row.purchasedAt, purchase });
    }
  }

  // Step 5: Insert in chunks, ignoring conflicts. UNIQUE(club_id, source,
  // source_row_id) makes a repeat ingest a no-op: with ignoreDuplicates the
  // upsert returns only the rows it actually inserted, so everything absent
  // from the result is a duplicate (e.g. one inserted by a concurrent run
  // after the existence check above).
  //
  // is_student sync and waivers run only for newly inserted rows, so
  // re-running the same ingest has no additional side effects. design.md
  // documents person.is_student as "derived from Member Type at last known
  // purchase/signup".
  type PurchaseWithRow = (typeof purchases)[number];
  let inserted = 0;
  type InsertedPurchase = { purchase: PurchaseWithRow; id: string };

  const toDbRow = (purchase: PurchaseWithRow) => ({
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
    price_pence: purchase.pricePence,
  });

  // Fallback when a whole chunk errors: one row at a time, so only the
  // offending rows end up in `errors`.
  const insertOneByOne = async (chunk: PurchaseWithRow[], sink: InsertedPurchase[]) => {
    for (const purchase of chunk) {
      try {
        const { data, error } = await scoped.from('purchase').insert(toDbRow(purchase)).select('id').single();
        if (error) {
          if (error.code === '23505') {
            duplicates++;
          } else {
            errors.push({
              rowId: purchase.sourceRowId,
              reason: error.message,
              rawRow: rawRowFor(purchase.source, purchase.sourceRowId),
            });
          }
        } else if (data) {
          sink.push({ purchase, id: data.id });
        }
      } catch (error) {
        // A transport-level throw for this one row shouldn't abort every
        // remaining row in the batch.
        errors.push({
          rowId: purchase.sourceRowId,
          reason: error instanceof Error ? error.message : 'Unexpected error during insert',
          rawRow: rawRowFor(purchase.source, purchase.sourceRowId),
        });
      }
    }
  };

  // Follow-ups for newly inserted rows only. A person's is_student is set
  // from their latest purchase over ALL validated rows (latestByPerson, built
  // up front), and only if that purchase was itself newly inserted.
  const runFollowUps = async ({ purchase, id }: InsertedPurchase) => {
    if (!purchase.personId) return;
    const rawRow = rawRowFor(purchase.source, purchase.sourceRowId);

    if (latestByPerson.get(purchase.personId)?.purchase === purchase) {
      try {
        const { error: updateError } = await scoped
          .from('person')
          .update({ is_student: purchase.isStudent })
          .eq('id', purchase.personId);
        if (updateError) {
          errors.push({
            rowId: purchase.sourceRowId,
            reason: `Purchase inserted, but failed to update person.is_student: ${updateError.message}`,
            rawRow,
          });
        }
      } catch (updateThrow) {
        errors.push({
          rowId: purchase.sourceRowId,
          reason: `Purchase inserted, but failed to update person.is_student: ${
            updateThrow instanceof Error ? updateThrow.message : 'unknown error'
          }`,
          rawRow,
        });
      }
    }

    try {
      await applyWaivers(purchase.personId, id);
    } catch (waiverError) {
      errors.push({
        rowId: purchase.sourceRowId,
        reason: `Purchase inserted, but waiver assignment failed: ${
          waiverError instanceof Error ? waiverError.message : 'unknown error'
        }`,
        rawRow,
      });
    }
  };

  // Follow-ups run right after their own chunk, so a timeout loses at most the
  // in-flight chunk's. One person's purchases run strictly in input order
  // (apply_purchase_waiver races if two calls for the same person overlap);
  // different people run up to FOLLOW_UP_CONCURRENCY lanes at once.
  const runChunkFollowUps = async (chunkInserted: InsertedPurchase[]) => {
    const byPerson = new Map<string, InsertedPurchase[]>();
    for (const item of chunkInserted) {
      if (!item.purchase.personId) continue;
      const list = byPerson.get(item.purchase.personId) ?? [];
      list.push(item);
      byPerson.set(item.purchase.personId, list);
    }
    await runWithConcurrency([...byPerson.values()], FOLLOW_UP_CONCURRENCY, async (list) => {
      for (const item of list) await runFollowUps(item);
    });
  };

  for (let i = 0; i < purchases.length; i += INSERT_CHUNK_SIZE) {
    const chunk = purchases.slice(i, i + INSERT_CHUNK_SIZE);
    const chunkInserted: InsertedPurchase[] = [];
    let returned: { id: string; source: string; source_row_id: string }[] | null = null;
    try {
      const { data, error } = await scoped
        .from('purchase')
        .upsert(chunk.map(toDbRow), { onConflict: 'club_id,source,source_row_id', ignoreDuplicates: true })
        .select('id, source, source_row_id');
      if (error) {
        console.warn('purchase chunk upsert failed; retrying row-by-row', error.message);
      } else {
        returned = (data ?? []) as unknown as { id: string; source: string; source_row_id: string }[];
      }
    } catch (upsertThrow) {
      console.warn(
        'purchase chunk upsert failed; retrying row-by-row',
        upsertThrow instanceof Error ? upsertThrow.message : upsertThrow
      );
    }

    if (!returned) {
      await insertOneByOne(chunk, chunkInserted);
    } else {
      const idByKey = new Map(returned.map((r) => [rowKey(r.source, r.source_row_id), r.id]));
      for (const purchase of chunk) {
        const id = idByKey.get(rowKey(purchase.source, purchase.sourceRowId));
        if (id) chunkInserted.push({ purchase, id });
        else duplicates++;
      }
    }
    inserted += chunkInserted.length;
    await runChunkFollowUps(chunkInserted);
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

/**
 * Re-checks every purchase already matched to this person for leftover
 * waiving capacity, against whatever is CURRENTLY outstanding.
 *
 * applyWaivers only ever runs once, at the moment a purchase is ingested
 * -- it waives whatever debt already exists at that instant. If someone
 * buys a pass before the relevant attendance is actually ticked (the
 * roster row is inserted at CSV-import time with attended: false, and
 * doesn't count as debt until an admin ticks it, often hours or days
 * later), there was nothing to waive yet, and nothing ever re-checks
 * later. The purchase just sits there having "already been used" for
 * nothing. See docs/PROJECT_STATUS.md's "stored credit" gap -- this
 * closes it by re-running applyWaivers for every one of the person's
 * purchases whenever NEW debt might have just appeared for them (see
 * call sites in lib/attendance/actions.ts: toggleAttendance,
 * addExistingPersonToSession, createWalkIn).
 *
 * Safe to call liberally: apply_purchase_waiver only ever touches rows
 * with waived_by_purchase_id is null, up to each purchase's own cap, so
 * re-running it when there's nothing new to waive is a no-op.
 *
 * One round trip, not one per purchase: the per-purchase loop runs
 * inside reapply_waivers_for_person (Postgres), not here -- looping in
 * TypeScript and calling apply_purchase_waiver's RPC once per purchase
 * would mean N network round trips for a person with N purchases.
 */
export async function reapplyWaiversForPerson(personId: string): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('reapply_waivers_for_person', {
    target_person_id: personId,
  });
  if (error) {
    throw new Error(`Failed to reapply waivers for person ${personId}: ${error.message}`);
  }
  return data ?? 0;
}

export interface ReapplySweepResult {
  peopleChecked: number;
  totalWaived: number;
}

/**
 * Safety-net sweep, NOT the primary fix: reapplyWaiversForPerson is
 * already called at every point in this codebase that can create new
 * debt (toggleAttendance, addExistingPersonToSession, createWalkIn,
 * syncSessionAttendance), so this exists to catch whatever a future code
 * path -- or a bug in one of the existing ones -- might miss, not to
 * carry the main load. Deliberately NOT a standalone timer/cron (e.g.
 * "N hours after a session" or "N hours after the last tick"): neither
 * maps to an actual signal of new debt, both would just delay catching
 * the same thing the targeted hooks already catch instantly, and picking
 * a threshold is guesswork a real trigger doesn't need.
 *
 * Scoped to active_debt_cycle (the view already used for chase-email
 * generation) rather than every person in the system -- only people who
 * currently show outstanding debt are worth re-checking at all, which
 * keeps this cheap regardless of total person/purchase table size. Meant
 * to be called from the existing weekly chase-email cron
 * (app/api/cron/chase-emails/route.ts), immediately before
 * generateChaseEmails, so anything it catches is resolved before it
 * could result in an undeserved chase email -- not as a new standalone
 * schedule.
 *
 * One round trip for the entire sweep: both the per-person and
 * per-purchase loops run inside reapply_waivers_for_everyone_with_debt
 * (Postgres), not here -- looping over debtors in TypeScript and calling
 * reapplyWaiversForPerson's RPC once per person would mean one round
 * trip per debtor.
 */
export async function reapplyWaiversForEveryoneWithDebt(clubId: string): Promise<ReapplySweepResult> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('reapply_waivers_for_everyone_with_debt', { target_club_id: clubId });
  if (error) {
    throw new Error(`Failed to run the waiver re-check sweep: ${error.message}`);
  }

  const rows = (data ?? []) as { person_id: string; waived: number }[];
  const totalWaived = rows.reduce((sum, row) => sum + row.waived, 0);
  return { peopleChecked: rows.length, totalWaived };
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
export async function rematchUnmatchedPurchases(clubId: string): Promise<RematchResult> {
  const scoped = createClubScopedClient(clubId);

  const { data: unmatched, error } = await scoped
    .from('purchase')
    .select('id, raw_person_name, raw_cid, raw_email, raw_member_type, purchased_at')
    .eq('match_status', 'unmatched');
  if (error) throw error;
  // createClubScopedClient's select() loses type inference under tsc --
  // same workaround as lib/attendance/sync.ts, queries.ts, and this file's
  // own ingestPurchases/product lookups.
  const typedUnmatched = unmatched as unknown as {
    id: string;
    raw_person_name: string;
    raw_cid: string | null;
    raw_email: string | null;
    raw_member_type: string | null;
    purchased_at: string;
  }[];

  let matched = 0;
  let stillUnmatched = 0;

  if ((typedUnmatched ?? []).length === 0) return { matched, stillUnmatched };
  const index = await loadPersonIndex(clubId);

  for (const p of typedUnmatched ?? []) {
    const row: RawPurchaseRow = {
      externalId: p.id,
      personName: p.raw_person_name,
      personEmail: p.raw_email ?? undefined,
      personCid: p.raw_cid ?? undefined,
      memberType: p.raw_member_type ?? '',
      productId: 'unused', // matching doesn't read product
      purchasedAt: new Date(p.purchased_at),
      source: 'xlsx_upload',
    };

    const result = matchAgainstIndex(row, index);
    if (result.matchStatus === 'unmatched') {
      stillUnmatched++;
      continue;
    }

    // Guarded on match_status so a concurrent manual match (or another
    // rematch) that landed after the select above is never overwritten.
    const { data: updated, error: updateError } = await scoped
      .from('purchase')
      .update({ person_id: result.personId, match_status: result.matchStatus })
      .eq('id', p.id)
      .eq('match_status', 'unmatched')
      .select('id');
    if (updateError) throw updateError;
    if (!updated || updated.length === 0) continue; // matched by someone else meanwhile

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
export async function listRecentUploads(clubId: string, limit = 5): Promise<UploadBatch[]> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from('purchase_upload')
    .select('id, product_id, filename, row_count, uploaded_by, created_at, product:product_id(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  // createClubScopedClient's select() loses type inference under tsc --
  // same workaround as lib/attendance/sync.ts, queries.ts, and this file's
  // own ingestPurchases/product lookups.
  const typedData = data as unknown as {
    id: string;
    product_id: string;
    filename: string | null;
    row_count: number;
    uploaded_by: string | null;
    created_at: string;
    product: { name: string } | { name: string }[] | null;
  }[];

  return (typedData ?? []).map((u) => {
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
  clubId: string,
  uploadId: string,
  newProductId: string
): Promise<{ purchasesUpdated: number; rewaived: number }> {
  const scoped = createClubScopedClient(clubId);

  // The new product must belong to this club too -- scoped select returns
  // null for a cross-club id, same mechanism as every other guard in this
  // sweep.
  const { data: product, error: productError } = await scoped
    .from('product')
    .select('id')
    .eq('id', newProductId)
    .maybeSingle();
  if (productError) throw productError;
  if (!product) throw new Error(`Product ${newProductId} does not belong to this club.`);

  const { data: rawPurchases, error } = await scoped
    .from('purchase')
    .select('id, person_id')
    .eq('upload_id', uploadId);
  if (error) throw error;
  // createClubScopedClient's select() loses type inference under tsc --
  // same workaround as lib/attendance/sync.ts, queries.ts, and this file's
  // own ingestPurchases/product lookups.
  const purchases = rawPurchases as unknown as { id: string; person_id: string | null }[] | null;
  if (!purchases || purchases.length === 0) {
    return { purchasesUpdated: 0, rewaived: 0 };
  }

  const purchaseIds = purchases.map((p) => p.id);

  const { error: unwaiveError } = await scoped
    .from('attendance_record')
    .update({ waived_by_purchase_id: null })
    .in('waived_by_purchase_id', purchaseIds);
  if (unwaiveError) throw unwaiveError;

  const { error: updatePurchasesError } = await scoped
    .from('purchase')
    .update({ product_id: newProductId })
    .eq('upload_id', uploadId);
  if (updatePurchasesError) throw updatePurchasesError;

  const { error: updateUploadError } = await scoped
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
export async function undoUpload(clubId: string, uploadId: string): Promise<{ deletedPurchases: number }> {
  const scoped = createClubScopedClient(clubId);

  const { data: purchases, error } = await scoped.from('purchase').select('id').eq('upload_id', uploadId);
  if (error) throw error;
  // createClubScopedClient's select() loses type inference under tsc --
  // same workaround as lib/attendance/sync.ts, queries.ts, and this file's
  // own ingestPurchases/product lookups.
  const typedPurchases = purchases as unknown as { id: string }[] | null;
  const purchaseIds = (typedPurchases ?? []).map((p) => p.id);

  if (purchaseIds.length > 0) {
    const { error: unwaiveError } = await scoped
      .from('attendance_record')
      .update({ waived_by_purchase_id: null })
      .in('waived_by_purchase_id', purchaseIds);
    if (unwaiveError) throw unwaiveError;

    const { error: deleteError } = await scoped.from('purchase').delete().in('id', purchaseIds);
    if (deleteError) throw deleteError;
  }

  const { error: deleteUploadError } = await scoped.from('purchase_upload').delete().eq('id', uploadId);
  if (deleteUploadError) throw deleteUploadError;

  return { deletedPurchases: purchaseIds.length };
}
