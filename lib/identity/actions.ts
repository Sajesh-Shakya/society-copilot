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
import {
  CID_TAKEN,
  CONFLICT_NOT_FOUND,
  CONFLICT_NOT_OPEN,
  dismissSameNameGroup,
  HOLDER_CHANGED,
  HOLDER_NOT_OUTRANKED,
  keepCurrent,
  NO_OTHER_PERSON,
  PARTIAL_CID_MOVE,
  PERSON_CHANGED,
  takeCidFromHolder,
  // Aliased: the brief's name trips react-hooks/rules-of-hooks (it isn't a hook).
  useIncoming as applyIncomingCid,
} from "@/lib/identity/resolve";

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
  [CONFLICT_NOT_FOUND]: "That conflict no longer exists.",
  [CONFLICT_NOT_OPEN]: "That conflict has already been dealt with.",
  [CID_TAKEN]: "That CID is now held by someone else.",
  [NO_OTHER_PERSON]: "No one else holds that CID.",
  [HOLDER_NOT_OUTRANKED]: "The other person's CID is just as trusted, so it can't be taken. Keep current instead.",
  [HOLDER_CHANGED]: "The other person no longer holds that CID. Reload and try again.",
  [PERSON_CHANGED]: "This person's CID changed since the conflict was recorded. Reload and try again.",
  [PARTIAL_CID_MOVE]:
    "The CID move was only partly applied. Check both people's CIDs; the change is listed under Recent changes.",
};

function userSafe(err: unknown): string | undefined {
  return err instanceof Error ? USER_SAFE[err.message] : undefined;
}

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
    // A saved match whose follow-up steps failed comes back as a success
    // carrying `warnings`; it is passed through unchanged for the client.
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

const resolveInputSchema = z.object({
  conflictId: idSchema,
  resolution: z.enum(["keep_current", "use_incoming"]),
});

/** "Keep current" (dismiss) or "Use incoming" on an open CID conflict. */
export async function resolveConflictAction(
  clubSlug: string,
  conflictId: string,
  resolution: "keep_current" | "use_incoming",
): Promise<{ ok: true } | { error: string }> {
  const { clubId, email } = await requireAdmin(clubSlug);
  const parsed = resolveInputSchema.safeParse({ conflictId, resolution });
  if (!parsed.success) return { error: "Invalid conflict." };
  try {
    if (parsed.data.resolution === "keep_current") await keepCurrent(clubId, parsed.data.conflictId, email);
    else await applyIncomingCid(clubId, parsed.data.conflictId, email);
    return { ok: true };
  } catch (err) {
    const safe = userSafe(err);
    if (safe) return { error: safe };
    throw err;
  }
}

/** "Take this CID from the other person" on an open CID conflict. */
export async function takeCidFromOtherPersonAction(
  clubSlug: string,
  conflictId: string,
): Promise<{ ok: true } | { error: string }> {
  const { clubId, email } = await requireAdmin(clubSlug);
  const parsed = idSchema.safeParse(conflictId);
  if (!parsed.success) return { error: "Invalid conflict." };
  try {
    await takeCidFromHolder(clubId, parsed.data, email);
    return { ok: true };
  } catch (err) {
    const safe = userSafe(err);
    if (safe) return { error: safe };
    throw err;
  }
}

const dismissInputSchema = z.object({
  nameKey: z.string().min(1).max(500),
  membersHash: z.string().regex(/^[0-9a-f]{40}$/),
});

/** "Not the same person" on a same-name group. */
export async function dismissSameNameGroupAction(
  clubSlug: string,
  nameKey: string,
  membersHash: string,
): Promise<{ ok: true } | { error: string }> {
  const { clubId, email } = await requireAdmin(clubSlug);
  const parsed = dismissInputSchema.safeParse({ nameKey, membersHash });
  if (!parsed.success) return { error: "Invalid group." };
  await dismissSameNameGroup(clubId, parsed.data.nameKey, parsed.data.membersHash, email);
  return { ok: true };
}
