export type CidSource = "sso" | "purchase" | "walk_in";

export const CID_SOURCE_RANK: Record<CidSource, number> = {
  sso: 3,
  purchase: 2,
  walk_in: 1,
};

export function outranks(a: CidSource, b: CidSource): boolean {
  return CID_SOURCE_RANK[a] > CID_SOURCE_RANK[b];
}

export type CidDecision =
  | { kind: "set" }
  | { kind: "confirm"; raiseSourceTo: CidSource | null }
  | { kind: "overwrite" }
  | { kind: "flag"; otherPersonId?: string }
  | { kind: "ignore" };

/**
 * Pure trust rule for CID evidence. `holder` is another person who already
 * owns `incoming.cid`; it turns a would-be set/overwrite into a flag.
 */
export function decideCidEvidence(
  existing: { cid: string | null; source: CidSource | null },
  incoming: { cid: string; source: CidSource },
  holder?: { personId: string } | null,
): CidDecision {
  const withHolder = (): CidDecision =>
    holder ? { kind: "flag", otherPersonId: holder.personId } : { kind: "set" };

  if (existing.cid === null) return withHolder();

  // An existing CID with no recorded source predates tracking: treat as sso.
  const existingSource: CidSource = existing.source ?? "sso";

  if (existing.cid === incoming.cid) {
    return {
      kind: "confirm",
      raiseSourceTo: outranks(incoming.source, existingSource)
        ? incoming.source
        : null,
    };
  }

  if (outranks(incoming.source, existingSource)) {
    return holder
      ? { kind: "flag", otherPersonId: holder.personId }
      : { kind: "overwrite" };
  }
  if (incoming.source === existingSource) return { kind: "flag" };
  return { kind: "ignore" };
}
