import { decideCidEvidence, type CidDecision, type CidSource } from "@/lib/identity/cid-rule";
import {
  conflictDedupKey,
  recordConflict,
  toConflictInsert,
  UNIQUE_VIOLATION,
  type ConflictRow,
  type IdentityOutcome,
  type ScopedClient,
} from "@/lib/identity/conflicts";
import { chunk } from "@/lib/chunk";

const MAX_ATTEMPTS = 3;

type PersonCid = { cid: string | null; cid_source: CidSource | null };
type Result = { decision: CidDecision["kind"]; cidChanged: boolean };

async function loadPerson(scoped: ScopedClient, personId: string): Promise<PersonCid> {
  const { data, error } = await scoped.from("person").select("cid, cid_source").eq("id", personId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`applyCidEvidence: person ${personId} not found in club`);
  return data as unknown as PersonCid;
}

/** Another person in the club who already owns `cid`, if any. */
async function findHolder(scoped: ScopedClient, personId: string, cid: string): Promise<string | null> {
  const { data, error } = await scoped.from("person").select("id").eq("cid", cid).neq("id", personId).limit(1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Adds `col = value` (or `col IS NULL`) so an update only lands if the row is
 * still in the state the decision was based on.
 */
function guard<Q extends { eq(c: string, v: string): Q; is(c: string, v: null): Q }>(
  q: Q,
  col: string,
  value: string | null,
): Q {
  return value === null ? q.is(col, null) : q.eq(col, value);
}

/**
 * Applies one piece of CID evidence to a person using the trust rule
 * (`decideCidEvidence`). Callers must pass an already-normalised CID
 * (`normalizeCid` from lib/utils); no normalisation happens here.
 *
 * Decisions:
 *  - `set`: person had no CID; writes `cid` + `cid_source`.
 *  - `overwrite`: incoming source outranks the stored one; writes `cid` +
 *    `cid_source` and logs a resolved `overwritten` conflict.
 *  - `confirm`: same CID; raises `cid_source` if the incoming source outranks it.
 *  - `flag`: equal-rank clash, or the CID belongs to another person in the
 *    club; nothing written, logs an open `flagged` conflict (with
 *    `other_person_id` whenever a holder exists).
 *  - `ignore`: lower-ranked evidence; nothing written, logs an `ignored` conflict.
 *
 * Writes are conditional on the state that was read. If the person changed in
 * between, the decision is re-run (up to 3 attempts) and then downgraded to a
 * flag. A unique violation on the CID (another person took it) is also a flag.
 * Never throws for a CID clash.
 */
export async function applyCidEvidence(
  scoped: ScopedClient,
  personId: string,
  cid: string,
  source: CidSource,
): Promise<Result> {
  return run(scoped, personId, cid, source);
}

async function run(
  scoped: ScopedClient,
  personId: string,
  cid: string,
  source: CidSource,
  beforeWrite?: (attempt: number) => Promise<void>,
): Promise<Result> {
  let person: PersonCid = { cid: null, cid_source: null };
  let holderId: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    person = await loadPerson(scoped, personId);
    holderId = await findHolder(scoped, personId, cid);
    const decision = decideCidEvidence(
      { cid: person.cid, source: person.cid_source },
      { cid, source },
      holderId ? { personId: holderId } : null,
    );
    const conflictBase = {
      personId,
      existingCid: person.cid,
      existingSource: person.cid_source,
      incomingCid: cid,
      incomingSource: source,
    };

    switch (decision.kind) {
      case "set":
      case "overwrite": {
        await beforeWrite?.(attempt);
        let q = scoped.from("person").update({ cid, cid_source: source }).eq("id", personId);
        q = guard(q, "cid", person.cid);
        q = guard(q, "cid_source", person.cid_source);
        const { data, error } = await q.select("id");
        if (error) {
          if (error.code !== UNIQUE_VIOLATION) throw error;
          // Another person took this CID between our read and write.
          const raceHolder = await findHolder(scoped, personId, cid);
          await recordConflict(scoped, { ...conflictBase, otherPersonId: raceHolder, outcome: "flagged" });
          return { decision: "flag", cidChanged: false };
        }
        if (!data || data.length === 0) continue; // person changed; re-evaluate
        if (decision.kind === "overwrite") {
          await recordConflict(scoped, { ...conflictBase, outcome: "overwritten" });
        }
        return { decision: decision.kind, cidChanged: true };
      }
      case "confirm": {
        if (decision.raiseSourceTo) {
          await beforeWrite?.(attempt);
          let q = scoped
            .from("person")
            .update({ cid_source: decision.raiseSourceTo })
            .eq("id", personId)
            .eq("cid", cid);
          q = guard(q, "cid_source", person.cid_source);
          const { data, error } = await q.select("id");
          if (error) throw error;
          if (!data || data.length === 0) continue;
        }
        return { decision: "confirm", cidChanged: false };
      }
      case "flag": {
        // The rule omits otherPersonId for equal-rank clashes; record any holder anyway.
        await recordConflict(scoped, {
          ...conflictBase,
          otherPersonId: decision.otherPersonId ?? holderId,
          outcome: "flagged",
        });
        return { decision: "flag", cidChanged: false };
      }
      case "ignore": {
        await recordConflict(scoped, { ...conflictBase, outcome: "ignored" });
        return { decision: "ignore", cidChanged: false };
      }
    }
  }

  // The person kept changing under us: leave it for an admin.
  await recordConflict(scoped, {
    personId,
    existingCid: person.cid,
    existingSource: person.cid_source,
    incomingCid: cid,
    incomingSource: source,
    otherPersonId: holderId,
    outcome: "flagged",
  });
  return { decision: "flag", cidChanged: false };
}

/** One planned CID decision, made in memory by a bulk caller (the CSV import). */
export interface CidEvidenceOp {
  personId: string;
  cid: string;
  source: CidSource;
  decision: CidDecision;
  /** The person's CID state the decision was based on; writes are guarded on it. */
  existing: { cid: string | null; source: CidSource | null };
}

const IN_LIST_CHUNK = 100;
const CONFLICT_INSERT_CHUNK = 500;
const WRITE_CONCURRENCY = 10;

function isClaim(op: CidEvidenceOp): boolean {
  return op.decision.kind === "set" || op.decision.kind === "overwrite";
}

function isWrite(op: CidEvidenceOp): boolean {
  return isClaim(op) || (op.decision.kind === "confirm" && op.decision.raiseSourceTo !== null);
}

/**
 * Orders writes so that an update vacating a CID lands before the update that
 * claims it (the unique (club_id, cid) index would otherwise reject the
 * claim). Returns waves: no op in a wave claims a CID that a not-yet-applied
 * op still holds, so a wave's writes are independent of each other. A cycle
 * (not producible by sequential in-memory evaluation) is emitted as a final
 * wave; its collisions downgrade to flags.
 */
function orderVacatesFirst(writes: CidEvidenceOp[]): CidEvidenceOp[][] {
  const waves: CidEvidenceOp[][] = [];
  let pending = writes;
  while (pending.length > 0) {
    const stillHeld = new Set(
      pending.filter((op) => op.decision.kind === "overwrite" && op.existing.cid).map((op) => op.existing.cid),
    );
    const ready = pending.filter((op) => !isClaim(op) || !stillHeld.has(op.cid));
    if (ready.length === 0) {
      waves.push(pending);
      break;
    }
    waves.push(ready);
    const readySet = new Set(ready);
    pending = pending.filter((op) => !readySet.has(op));
  }
  return waves;
}

/** One guarded write; `null` when it landed, else the holder to flag against. */
async function writeOp(
  scoped: ScopedClient,
  op: CidEvidenceOp,
): Promise<null | { otherPersonId: string | null }> {
  const values =
    op.decision.kind === "confirm"
      ? { cid_source: op.decision.raiseSourceTo }
      : { cid: op.cid, cid_source: op.source };
  let q = scoped.from("person").update(values).eq("id", op.personId);
  q = guard(q, "cid", op.existing.cid);
  q = guard(q, "cid_source", op.existing.source);
  const { data, error } = await q.select("id");
  if (error && error.code !== UNIQUE_VIOLATION) throw error;
  // Unique violation (someone holds the CID) or a missed guard (the person
  // changed since the plan was made): rare, so a holder lookup is fine here.
  if (error || !data || data.length === 0) {
    return { otherPersonId: await findHolder(scoped, op.personId, op.cid) };
  }
  return null;
}

/**
 * Bulk variant of applyCidEvidence for decisions already made in memory with
 * `decideCidEvidence` (lib/csv-import/importer.ts). Never aborts on a CID
 * clash:
 *  - set/overwrite/confirm-raise writes are guarded on `existing` and applied
 *    vacate-before-claim (orderVacatesFirst); a unique violation or a missed
 *    guard downgrades that one op to an open `flagged` conflict;
 *  - conflict rows follow recordConflict's semantics (overwritten resolved,
 *    flagged open, ignored resolved; flagged and ignored deduped per
 *    (person, incoming_cid, incoming_source); a flag promotes an earlier
 *    ignored row; an existing flag in any status is left alone), written as
 *    chunked bulk inserts after dropping keys already in the table or
 *    repeated within the batch.
 */
export async function applyCidEvidenceBatch(scoped: ScopedClient, ops: CidEvidenceOp[]): Promise<void> {
  const conflicts: ConflictRow[] = [];
  const base = (op: CidEvidenceOp) => ({
    personId: op.personId,
    existingCid: op.existing.cid,
    existingSource: op.existing.source,
    incomingCid: op.cid,
    incomingSource: op.source,
  });

  for (const wave of orderVacatesFirst(ops.filter(isWrite))) {
    for (const group of chunk(wave, WRITE_CONCURRENCY)) {
      const results = await Promise.all(group.map((op) => writeOp(scoped, op)));
      group.forEach((op, i) => {
        const failed = results[i];
        if (failed) {
          // A missed source raise changes no CID: nothing to flag.
          if (isClaim(op)) conflicts.push({ ...base(op), otherPersonId: failed.otherPersonId, outcome: "flagged" });
        } else if (op.decision.kind === "overwrite") {
          conflicts.push({ ...base(op), outcome: "overwritten" });
        }
      });
    }
  }

  for (const op of ops) {
    if (op.decision.kind === "flag") {
      conflicts.push({ ...base(op), otherPersonId: op.decision.otherPersonId ?? null, outcome: "flagged" });
    } else if (op.decision.kind === "ignore") {
      conflicts.push({ ...base(op), outcome: "ignored" });
    }
  }

  await insertConflicts(scoped, conflicts);
}

async function insertConflicts(scoped: ScopedClient, rows: ConflictRow[]): Promise<void> {
  if (rows.length === 0) return;

  // In-batch dedup of flagged/ignored: first row per key wins, except a flag
  // supersedes an ignore (an ignore must not hide a real conflict).
  const toInsert: ConflictRow[] = rows.filter((r) => r.outcome === "overwritten");
  const deduped = new Map<string, ConflictRow>();
  for (const r of rows) {
    if (r.outcome === "overwritten") continue;
    const k = conflictDedupKey(r);
    const prev = deduped.get(k);
    if (!prev || (prev.outcome === "ignored" && r.outcome === "flagged")) deduped.set(k, r);
  }

  const existing = new Map<string, IdentityOutcome>();
  const personIds = [...new Set([...deduped.values()].map((r) => r.personId))];
  for (const ids of chunk(personIds, IN_LIST_CHUNK)) {
    const { data, error } = await scoped
      .from("person_identity_conflict")
      .select("person_id, incoming_cid, incoming_source, outcome")
      .in("person_id", ids)
      .in("outcome", ["flagged", "ignored"]);
    if (error) throw error;
    for (const e of (data ?? []) as unknown as Array<{
      person_id: string;
      incoming_cid: string;
      incoming_source: string;
      outcome: IdentityOutcome;
    }>) {
      existing.set(
        conflictDedupKey({ personId: e.person_id, incomingCid: e.incoming_cid, incomingSource: e.incoming_source }),
        e.outcome,
      );
    }
  }

  const promotions: ConflictRow[] = [];
  for (const [k, r] of deduped) {
    const prior = existing.get(k);
    if (!prior) toInsert.push(r);
    else if (prior === "ignored" && r.outcome === "flagged") promotions.push(r);
  }

  for (const group of chunk(toInsert, CONFLICT_INSERT_CHUNK)) {
    const { error } = await scoped.from("person_identity_conflict").insert(group.map(toConflictInsert));
    if (!error) continue;
    if (error.code !== UNIQUE_VIOLATION) throw error;
    // A key was written since we read (or the read was truncated): fall back
    // to the per-row path, which resolves each collision the same way.
    for (const r of group) await recordConflict(scoped, r);
  }

  // Rare: recordConflict's insert-then-promote path performs the promotion.
  for (const r of promotions) await recordConflict(scoped, r);
}

/** Test-only seam: runs applyCidEvidence with a hook just before each guarded write. */
export const __testing = { applyCidEvidenceWithHook: run };
