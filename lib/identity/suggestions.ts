import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { escapeIlikePattern, normalizeCid } from "@/lib/utils";
import { decideCidEvidence, type CidSource } from "@/lib/identity/cid-rule";
import { PURCHASE_NOT_FOUND } from "@/lib/identity/match-purchase";

export type CidEffect = "set" | "overwrite" | "flag" | "ignore" | "confirm" | "none";

export interface PersonSuggestion {
  personId: string;
  fullName: string;
  email: string;
  cid: string | null;
  cidSource: CidSource | null;
  cidEffect: CidEffect;
}

type PersonRow = { id: string; full_name: string; email: string; cid: string | null; cid_source: CidSource | null };

const PERSON_COLUMNS = "id, full_name, email, cid, cid_source";

/**
 * Likely people for an unmatched purchase, for the manual-match panel:
 * exact (case-insensitive) email matches first, then a full-name match only
 * when exactly one person in the club has that name. `cidEffect` previews
 * what adopting the purchase's CID would do (display only; the write path
 * re-decides with fresh data).
 */
export async function suggestPersonsForPurchase(clubId: string, purchaseId: string): Promise<PersonSuggestion[]> {
  const scoped = createClubScopedClient(clubId);

  const { data: purchaseData, error: purchaseError } = await scoped
    .from("purchase")
    .select("raw_person_name, raw_email, raw_cid")
    .eq("id", purchaseId)
    .maybeSingle();
  if (purchaseError) throw purchaseError;
  const purchase = purchaseData as unknown as {
    raw_person_name: string | null;
    raw_email: string | null;
    raw_cid: string | null;
  } | null;
  if (!purchase) throw new Error(PURCHASE_NOT_FOUND);

  const candidates: PersonRow[] = [];
  const email = purchase.raw_email?.trim();
  if (email) {
    const { data, error } = await scoped
      .from("person")
      .select(PERSON_COLUMNS)
      .ilike("email", escapeIlikePattern(email))
      .order("full_name")
      .limit(5);
    if (error) throw error;
    candidates.push(...((data ?? []) as unknown as PersonRow[]));
  }

  const name = purchase.raw_person_name?.trim().replace(/\s+/g, " ");
  if (name) {
    const { data, error } = await scoped
      .from("person")
      .select(PERSON_COLUMNS)
      .ilike("full_name", escapeIlikePattern(name))
      .limit(2);
    if (error) throw error;
    const byName = (data ?? []) as unknown as PersonRow[];
    if (byName.length === 1 && !candidates.some((c) => c.id === byName[0].id)) candidates.push(byName[0]);
  }

  const rawCid = purchase.raw_cid?.trim();
  const cid = rawCid ? normalizeCid(rawCid) : null;
  let holderId: string | null = null;
  if (cid && candidates.length > 0) {
    const { data, error } = await scoped.from("person").select("id").eq("cid", cid).limit(1);
    if (error) throw error;
    holderId = ((data ?? []) as unknown as Array<{ id: string }>)[0]?.id ?? null;
  }

  return candidates.map((p) => ({
    personId: p.id,
    fullName: p.full_name,
    email: p.email,
    cid: p.cid,
    cidSource: p.cid_source,
    cidEffect: cid
      ? decideCidEvidence(
          { cid: p.cid, source: p.cid_source },
          { cid, source: "purchase" },
          holderId && holderId !== p.id ? { personId: holderId } : null,
        ).kind
      : "none",
  }));
}
