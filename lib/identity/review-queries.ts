import { createHash } from "node:crypto";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { fetchAllPages } from "@/lib/purchase/person-index";
import { chunk } from "@/lib/chunk";
import { outranks, type CidSource } from "@/lib/identity/cid-rule";
import type { ScopedClient } from "@/lib/identity/conflicts";

// Read side of the people-review page. Server-only (node:crypto).

const IN_LIST_CHUNK = 100;

export type PersonRow = {
  id: string;
  full_name: string;
  email: string | null;
  cid: string | null;
  cid_source: CidSource | null;
};

type ConflictRow = {
  id: string;
  person_id: string;
  existing_cid: string | null;
  existing_source: CidSource | null;
  incoming_cid: string;
  incoming_source: CidSource;
  other_person_id: string | null;
  created_at: string;
  resolved_by: string | null;
};

export interface OpenConflict {
  id: string;
  personId: string;
  personName: string;
  personEmail: string | null;
  /** The person's CID now (may differ from the CID at the time of the flag). */
  currentCid: string | null;
  currentSource: CidSource | null;
  incomingCid: string;
  incomingSource: CidSource;
  otherPersonId: string | null;
  otherPersonName: string | null;
  otherPersonSource: CidSource | null;
  createdAt: string;
  /** No one else in the club holds the incoming CID. */
  canUseIncoming: boolean;
  /** The named other person still holds it and the incoming source outranks theirs. */
  canTake: boolean;
}

export interface RecentOverwrite {
  id: string;
  personId: string;
  personName: string;
  previousCid: string | null;
  previousSource: CidSource | null;
  newCid: string;
  newSource: CidSource;
  otherPersonName: string | null;
  createdAt: string;
  by: string | null;
}

export interface SameNamePerson {
  id: string;
  fullName: string;
  email: string | null;
  cid: string | null;
  cidSource: CidSource | null;
  attendanceCount: number;
  purchaseCount: number;
}

export interface SameNameGroup {
  nameKey: string;
  membersHash: string;
  people: SameNamePerson[];
}

export interface IncompleteName {
  id: string;
  fullName: string;
  email: string | null;
  cid: string | null;
}

/** Trimmed, case-folded full name (the same-name grouping key). */
export function nameKeyOf(fullName: string): string {
  return fullName.trim().toLowerCase();
}

/** sha1 hex of the sorted member ids, so a dismissal stops applying when the group changes. */
export function membersHashOf(ids: string[]): string {
  return createHash("sha1").update([...ids].sort().join(",")).digest("hex");
}

/** Open CID conflicts in the club: one head/count query (the sessions-page badge). */
export async function countOpenConflicts(clubId: string): Promise<number> {
  const scoped = createClubScopedClient(clubId);
  const { count, error } = await scoped
    .from("person_identity_conflict")
    .select("id", { count: "exact", head: true })
    .eq("outcome", "flagged")
    .eq("status", "open");
  if (error) throw new Error(`Failed to count open conflicts: ${error.message}`);
  return count ?? 0;
}

async function loadPeopleByIds(scoped: ScopedClient, ids: string[]): Promise<Map<string, PersonRow>> {
  const byId = new Map<string, PersonRow>();
  for (const group of chunk([...new Set(ids)], IN_LIST_CHUNK)) {
    const { data, error } = await scoped
      .from("person")
      .select("id, full_name, email, cid, cid_source")
      .in("id", group);
    if (error) throw new Error(`Failed to load people: ${error.message}`);
    for (const p of (data ?? []) as unknown as PersonRow[]) byId.set(p.id, p);
  }
  return byId;
}

/** Holders (person id by CID) of the given CIDs in the club. */
async function loadCidHolders(scoped: ScopedClient, cids: string[]): Promise<Map<string, string>> {
  const holders = new Map<string, string>();
  for (const group of chunk([...new Set(cids)], IN_LIST_CHUNK)) {
    const { data, error } = await scoped.from("person").select("id, cid").in("cid", group);
    if (error) throw new Error(`Failed to load CID holders: ${error.message}`);
    for (const p of (data ?? []) as unknown as Array<{ id: string; cid: string }>) holders.set(p.cid, p.id);
  }
  return holders;
}

const CONFLICT_COLUMNS =
  "id, person_id, existing_cid, existing_source, incoming_cid, incoming_source, other_person_id, created_at, resolved_by";

/** Open flagged conflicts, newest first, with the people involved and which actions are allowed. */
export async function listOpenConflicts(clubId: string): Promise<OpenConflict[]> {
  const scoped = createClubScopedClient(clubId);
  const conflicts = await fetchAllPages<ConflictRow>(async (from, to) => {
    const { data, error } = await scoped
      .from("person_identity_conflict")
      .select(CONFLICT_COLUMNS)
      .eq("outcome", "flagged")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, to);
    if (error) throw new Error(`Failed to load conflicts: ${error.message}`);
    return (data ?? []) as unknown as ConflictRow[];
  });
  if (conflicts.length === 0) return [];

  const [people, holders] = await Promise.all([
    loadPeopleByIds(
      scoped,
      conflicts.flatMap((c) => (c.other_person_id ? [c.person_id, c.other_person_id] : [c.person_id])),
    ),
    loadCidHolders(
      scoped,
      conflicts.map((c) => c.incoming_cid),
    ),
  ]);

  return conflicts.map((c) => {
    const person = people.get(c.person_id);
    const other = c.other_person_id ? people.get(c.other_person_id) : undefined;
    const holderId = holders.get(c.incoming_cid);
    const free = !holderId || holderId === c.person_id;
    const canTake =
      !!other && other.cid === c.incoming_cid && outranks(c.incoming_source, other.cid_source ?? "sso");
    return {
      id: c.id,
      personId: c.person_id,
      personName: person?.full_name ?? "Unknown person",
      personEmail: person?.email ?? null,
      currentCid: person?.cid ?? null,
      currentSource: person?.cid_source ?? null,
      incomingCid: c.incoming_cid,
      incomingSource: c.incoming_source,
      otherPersonId: c.other_person_id,
      otherPersonName: other?.full_name ?? null,
      otherPersonSource: other?.cid_source ?? null,
      createdAt: c.created_at,
      canUseIncoming: free,
      canTake,
    };
  });
}

/** The last `limit` `overwritten` conflicts (automatic overwrites and CIDs taken from a holder). */
export async function listRecentOverwrites(clubId: string, limit = 30): Promise<RecentOverwrite[]> {
  const scoped = createClubScopedClient(clubId);
  const { data, error } = await scoped
    .from("person_identity_conflict")
    .select(CONFLICT_COLUMNS)
    .eq("outcome", "overwritten")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load recent changes: ${error.message}`);
  const rows = (data ?? []) as unknown as ConflictRow[];
  const people = await loadPeopleByIds(
    scoped,
    rows.flatMap((r) => (r.other_person_id ? [r.person_id, r.other_person_id] : [r.person_id])),
  );
  return rows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    personName: people.get(r.person_id)?.full_name ?? "Unknown person",
    previousCid: r.existing_cid,
    previousSource: r.existing_source,
    newCid: r.incoming_cid,
    newSource: r.incoming_source,
    otherPersonName: r.other_person_id ? (people.get(r.other_person_id)?.full_name ?? null) : null,
    createdAt: r.created_at,
    by: r.resolved_by,
  }));
}

/** Every person in the club (paged past PostgREST's 1000-row cap). Pass to the list functions to share one load. */
export async function loadClubPeople(clubId: string): Promise<PersonRow[]> {
  const scoped = createClubScopedClient(clubId);
  return fetchAllPages<PersonRow>(async (from, to) => {
    const { data, error } = await scoped
      .from("person")
      .select("id, full_name, email, cid, cid_source")
      .order("id")
      .range(from, to);
    if (error) throw new Error(`Failed to load people: ${error.message}`);
    return (data ?? []) as unknown as PersonRow[];
  });
}

/** person_id -> row count in `table`, via chunked, paged `.in()` reads (no per-person queries). */
async function countByPerson(
  scoped: ScopedClient,
  table: "attendance_record" | "purchase",
  personIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const group of chunk(personIds, IN_LIST_CHUNK)) {
    const rows = await fetchAllPages<{ person_id: string }>(async (from, to) => {
      const { data, error } = await scoped
        .from(table)
        .select("id, person_id")
        .in("person_id", group)
        .order("id")
        .range(from, to);
      if (error) throw new Error(`Failed to count ${table}: ${error.message}`);
      return (data ?? []) as unknown as Array<{ person_id: string }>;
    });
    for (const r of rows) counts.set(r.person_id, (counts.get(r.person_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Groups of 2+ people whose trimmed, case-folded full names match, minus
 * groups dismissed with the same (name_key, members_hash). Each person comes
 * with attendance and purchase counts.
 */
export async function listSameNameGroups(clubId: string, people?: PersonRow[]): Promise<SameNameGroup[]> {
  const scoped = createClubScopedClient(clubId);
  const all = people ?? (await loadClubPeople(clubId));

  const byKey = new Map<string, PersonRow[]>();
  for (const p of all) {
    const key = nameKeyOf(p.full_name ?? "");
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(p);
    else byKey.set(key, [p]);
  }

  const candidates = [...byKey.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([nameKey, members]) => ({ nameKey, membersHash: membersHashOf(members.map((m) => m.id)), members }));
  if (candidates.length === 0) return [];

  const dismissed = new Set<string>();
  const dismissals = await fetchAllPages<{ name_key: string; members_hash: string }>(async (from, to) => {
    const { data, error } = await scoped
      .from("person_duplicate_dismissal")
      .select("id, name_key, members_hash")
      .order("id")
      .range(from, to);
    if (error) throw new Error(`Failed to load dismissals: ${error.message}`);
    return (data ?? []) as unknown as Array<{ name_key: string; members_hash: string }>;
  });
  for (const d of dismissals) dismissed.add(`${d.name_key}\u0000${d.members_hash}`);

  const groups = candidates.filter((g) => !dismissed.has(`${g.nameKey}\u0000${g.membersHash}`));
  if (groups.length === 0) return [];

  const ids = groups.flatMap((g) => g.members.map((m) => m.id));
  const [attendance, purchases] = await Promise.all([
    countByPerson(scoped, "attendance_record", ids),
    countByPerson(scoped, "purchase", ids),
  ]);

  return groups
    .map((g) => ({
      nameKey: g.nameKey,
      membersHash: g.membersHash,
      people: g.members.map((m) => ({
        id: m.id,
        fullName: m.full_name,
        email: m.email,
        cid: m.cid,
        cidSource: m.cid_source,
        attendanceCount: attendance.get(m.id) ?? 0,
        purchaseCount: purchases.get(m.id) ?? 0,
      })),
    }))
    .sort((a, b) => a.nameKey.localeCompare(b.nameKey));
}

/** People whose full name is a single word (likely a first name only). */
export async function listIncompleteNames(clubId: string, people?: PersonRow[]): Promise<IncompleteName[]> {
  const all = people ?? (await loadClubPeople(clubId));
  return all
    .filter((p) => {
      const name = (p.full_name ?? "").trim();
      return name.length > 0 && !/\s/.test(name);
    })
    .map((p) => ({ id: p.id, fullName: p.full_name.trim(), email: p.email, cid: p.cid }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
