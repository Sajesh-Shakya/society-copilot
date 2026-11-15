import { decideCidEvidence, type CidDecision, type CidSource } from "@/lib/identity/cid-rule";
import { recordConflict, UNIQUE_VIOLATION, type ScopedClient } from "@/lib/identity/conflicts";

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

/** Test-only seam: runs applyCidEvidence with a hook just before each guarded write. */
export const __testing = { applyCidEvidenceWithHook: run };
