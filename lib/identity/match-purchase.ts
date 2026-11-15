import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { normalizeCid } from "@/lib/utils";
import { isStudentMemberType } from "@/lib/purchase/types";
import { reapplyWaiversForPerson } from "@/lib/purchase/interface";
import { applyCidEvidence } from "@/lib/identity/apply-cid-evidence";
import type { CidDecision } from "@/lib/identity/cid-rule";

export const PURCHASE_NOT_FOUND = "Purchase not found";
export const PURCHASE_NOT_UNMATCHED = "Purchase is not unmatched";
export const PERSON_NOT_FOUND = "Person not found";

/**
 * `warnings` is present only when the match was saved but a follow-up step
 * (is_student sync, waiver recheck, CID adoption) failed.
 */
export type MatchPurchaseResult = {
  matched: true;
  cid: { decision: CidDecision["kind"] | "none" };
  warnings?: string[];
};

type HookPoint = "afterMatch";
let testHook: ((point: HookPoint) => Promise<void>) | null = null;

/** No-op in production; tests inject failures at named points via __testing.setHook. */
async function hook(point: HookPoint): Promise<void> {
  if (testHook) await testHook(point);
}

type PurchaseForMatch = {
  id: string;
  match_status: string;
  raw_cid: string | null;
  raw_member_type: string | null;
  purchased_at: string;
};

/**
 * The logic behind matchPurchaseToPersonAction (lib/identity/actions.ts),
 * which calls requireAdmin() and then this. Kept outside the "use server" file
 * so integration tests can call it directly.
 *
 * Hand-matches an `unmatched` purchase to a person in the same club: sets
 * `person_id`, `match_status = 'manual_matched'` and the audit columns, syncs
 * `person.is_student` (if this is the person's latest purchase, same rule as
 * ingest), re-runs waivers, and, when `adoptCid` is set and the purchase has
 * a CID, offers that CID to the trust rule as `purchase` evidence. A
 * flag/ignore decision leaves the person's CID alone; the match still stands.
 * If any of those follow-up steps throws once the match is saved, the error
 * is logged and the result still reports `matched` with `warnings`.
 *
 * Throws PURCHASE_NOT_FOUND / PERSON_NOT_FOUND when either row is missing from
 * the club, and PURCHASE_NOT_UNMATCHED when the purchase is (or, by the time
 * of the write, has become) matched.
 */
export async function matchPurchaseToPerson(
  clubId: string,
  purchaseId: string,
  personId: string,
  options: { adoptCid: boolean },
  matchedBy: string,
): Promise<MatchPurchaseResult> {
  const scoped = createClubScopedClient(clubId);

  const { data: purchaseData, error: purchaseError } = await scoped
    .from("purchase")
    .select("id, match_status, raw_cid, raw_member_type, purchased_at")
    .eq("id", purchaseId)
    .maybeSingle();
  if (purchaseError) throw purchaseError;
  const purchase = purchaseData as unknown as PurchaseForMatch | null;
  if (!purchase) throw new Error(PURCHASE_NOT_FOUND);
  if (purchase.match_status !== "unmatched") throw new Error(PURCHASE_NOT_UNMATCHED);

  const { data: personData, error: personError } = await scoped
    .from("person")
    .select("id")
    .eq("id", personId)
    .maybeSingle();
  if (personError) throw personError;
  if (!personData) throw new Error(PERSON_NOT_FOUND);

  // Guarded on match_status so a concurrent rematch or second admin can't be
  // overwritten.
  const { data: updated, error: updateError } = await scoped
    .from("purchase")
    .update({
      person_id: personId,
      match_status: "manual_matched",
      manual_matched_by: matchedBy,
      manual_matched_at: new Date().toISOString(),
    })
    .eq("id", purchaseId)
    .eq("match_status", "unmatched")
    .select("id");
  if (updateError) throw updateError;
  if (!updated || updated.length === 0) throw new Error(PURCHASE_NOT_UNMATCHED);

  // The match is saved from here on: a failure in the follow-up steps must not
  // read as "match failed". It is logged (ids only) and returned as a warning.
  let decision: MatchPurchaseResult["cid"]["decision"] = "none";
  let step: "is_student update" | "waiver recheck" | "CID adoption" = "is_student update";
  try {
    await hook("afterMatch");

    // person.is_student follows the person's most recent purchase (ingest's rule).
    if (purchase.raw_member_type !== null) {
      const { data: newer, error: newerError } = await scoped
        .from("purchase")
        .select("id")
        .eq("person_id", personId)
        .gt("purchased_at", purchase.purchased_at)
        .limit(1);
      if (newerError) throw newerError;
      if (!newer || newer.length === 0) {
        const { error } = await scoped
          .from("person")
          .update({ is_student: isStudentMemberType(purchase.raw_member_type) })
          .eq("id", personId);
        if (error) throw error;
      }
    }

    step = "waiver recheck";
    await reapplyWaiversForPerson(personId);

    step = "CID adoption";
    const rawCid = purchase.raw_cid?.trim();
    if (options.adoptCid && rawCid) {
      ({ decision } = await applyCidEvidence(scoped, personId, normalizeCid(rawCid), "purchase"));
    }
  } catch (err) {
    console.error("identity match: follow-up after match failed", { clubId, purchaseId, personId, step }, err);
    return {
      matched: true,
      cid: { decision },
      warnings: [
        `Matched, but the ${step} failed. The match is saved; this person's student status, waivers or CID may be out of date.`,
      ],
    };
  }

  return { matched: true, cid: { decision } };
}

/** Test-only seam: inject a failure at a named point. Unset (null) in production. */
export const __testing = {
  setHook(fn: ((point: HookPoint) => Promise<void>) | null): void {
    testHook = fn;
  },
};
