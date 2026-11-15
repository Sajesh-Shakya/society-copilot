"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import {
  matchPurchaseToPerson,
  PERSON_NOT_FOUND,
  PURCHASE_NOT_FOUND,
  PURCHASE_NOT_UNMATCHED,
  type MatchPurchaseResult,
} from "@/lib/identity/match-purchase";
import { suggestPersonsForPurchase, type PersonSuggestion } from "@/lib/identity/suggestions";

// Expected failures come back as { error } values: Next.js strips thrown
// messages from Server Actions in production. Anything unexpected still
// throws and is caught by the client.

const idSchema = z.string().uuid();
const matchInputSchema = z.object({
  purchaseId: idSchema,
  personId: idSchema,
  adoptCid: z.boolean(),
});

const USER_SAFE: Record<string, string> = {
  [PURCHASE_NOT_FOUND]: "That purchase no longer exists.",
  [PURCHASE_NOT_UNMATCHED]: "That purchase has already been matched.",
  [PERSON_NOT_FOUND]: "That person isn't in this club.",
};

export async function matchPurchaseToPersonAction(
  clubSlug: string,
  purchaseId: string,
  personId: string,
  options: { adoptCid: boolean },
): Promise<MatchPurchaseResult | { error: string }> {
  const { clubId, email } = await requireAdmin(clubSlug);
  const parsed = matchInputSchema.safeParse({ purchaseId, personId, adoptCid: options?.adoptCid });
  if (!parsed.success) return { error: "Invalid purchase or person." };
  try {
    return await matchPurchaseToPerson(
      clubId,
      parsed.data.purchaseId,
      parsed.data.personId,
      { adoptCid: parsed.data.adoptCid },
      email,
    );
  } catch (err) {
    const safe = err instanceof Error ? USER_SAFE[err.message] : undefined;
    if (safe) return { error: safe };
    throw err;
  }
}

export async function suggestPersonsAction(
  clubSlug: string,
  purchaseId: string,
): Promise<PersonSuggestion[] | { error: string }> {
  const { clubId } = await requireAdmin(clubSlug);
  const parsed = idSchema.safeParse(purchaseId);
  if (!parsed.success) return { error: "Invalid purchase." };
  try {
    return await suggestPersonsForPurchase(clubId, parsed.data);
  } catch (err) {
    if (err instanceof Error && err.message === PURCHASE_NOT_FOUND) return { error: USER_SAFE[PURCHASE_NOT_FOUND] };
    throw err;
  }
}
