import { decideCidEvidence, type CidDecision, type CidSource } from "@/lib/identity/cid-rule";
import { recordConflict, type ScopedClient } from "@/lib/identity/conflicts";

const UNIQUE_VIOLATION = "23505";

type PersonCid = { cid: string | null; cid_source: CidSource | null };

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
 * Applies one piece of CID evidence to a person using the trust rule:
 * writes the CID/source when the rule allows it and logs every conflict.
 * Never throws on a CID clash with another person; that becomes a flag.
 */
export async function applyCidEvidence(
  scoped: ScopedClient,
  personId: string,
  cid: string,
  source: CidSource,
): Promise<{ decision: CidDecision["kind"]; cidChanged: boolean }> {
  const person = await loadPerson(scoped, personId);
  const holderId = await findHolder(scoped, personId, cid);
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
      const { error } = await scoped.from("person").update({ cid, cid_source: source }).eq("id", personId);
      if (error) {
        if (error.code !== UNIQUE_VIOLATION) throw error;
        // Lost a race: someone else took this CID between our read and write.
        const raceHolder = await findHolder(scoped, personId, cid);
        await recordConflict(scoped, { ...conflictBase, otherPersonId: raceHolder, outcome: "flagged" });
        return { decision: "flag", cidChanged: false };
      }
      if (decision.kind === "overwrite") {
        await recordConflict(scoped, { ...conflictBase, outcome: "overwritten" });
      }
      return { decision: decision.kind, cidChanged: true };
    }
    case "confirm": {
      if (decision.raiseSourceTo) {
        const { error } = await scoped
          .from("person")
          .update({ cid_source: decision.raiseSourceTo })
          .eq("id", personId);
        if (error) throw error;
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
