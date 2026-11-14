import { createClubScopedClient } from '@/lib/supabase/club-scoped';
import { normalizeCid } from '@/lib/utils';
import { RawPurchaseRow, MatchResult, isStudentMemberType } from './types';

export interface PersonIndex {
  byCid: Map<string, string>;
  byEmail: Map<string, string>;
  byName: Map<string, string[]>;
  cidById: Map<string, string | null>;
  // Keys shared by 2+ people. Removed from byCid/byEmail so they never match,
  // mirroring the old maybeSingle() error path (error ignored -> no match).
  ambiguousCids: Set<string>;
  ambiguousEmails: Set<string>;
}

export interface PersonIndexRow {
  id: string;
  cid: string | null;
  email: string | null;
  full_name: string;
}

function addUnique(
  map: Map<string, string>,
  ambiguous: Set<string>,
  key: string,
  id: string
): void {
  if (ambiguous.has(key)) return;
  if (map.has(key)) {
    map.delete(key);
    ambiguous.add(key);
  } else {
    map.set(key, id);
  }
}

export function buildPersonIndex(people: PersonIndexRow[]): PersonIndex {
  const index: PersonIndex = {
    byCid: new Map(),
    byEmail: new Map(),
    byName: new Map(),
    cidById: new Map(),
    ambiguousCids: new Set(),
    ambiguousEmails: new Set(),
  };
  for (const p of people) {
    index.cidById.set(p.id, p.cid);
    if (p.cid) addUnique(index.byCid, index.ambiguousCids, p.cid, p.id);
    if (p.email) addUnique(index.byEmail, index.ambiguousEmails, p.email.toLowerCase(), p.id);
    const nameKey = p.full_name.trim().toLowerCase();
    if (nameKey) {
      const ids = index.byName.get(nameKey);
      if (ids) ids.push(p.id);
      else index.byName.set(nameKey, [p.id]);
    }
  }
  return index;
}

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize = 1000
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

export async function loadPersonIndex(clubId: string): Promise<PersonIndex> {
  const scoped = createClubScopedClient(clubId);
  const rows = await fetchAllPages<PersonIndexRow>(async (from, to) => {
    const { data, error } = await scoped
      .from('person')
      .select('id, cid, email, full_name')
      .order('id')
      .range(from, to);
    if (error) throw new Error(`Failed to load people: ${error.message}`);
    return (data ?? []) as unknown as PersonIndexRow[];
  });
  return buildPersonIndex(rows);
}

// Same rules as matchPersonRecord (lib/purchase/matcher.ts), against memory.
export function matchAgainstIndex(row: RawPurchaseRow, index: PersonIndex): MatchResult {
  if (row.personCid) {
    const id = index.byCid.get(normalizeCid(row.personCid));
    if (id) return { personId: id, matchStatus: 'cid_matched' };
  }

  // Students with a CID that didn't match stop here (no email/name fallback).
  if (row.personCid && isStudentMemberType(row.memberType)) {
    return { matchStatus: 'unmatched' };
  }

  if (row.personEmail) {
    const id = index.byEmail.get(row.personEmail.toLowerCase());
    if (id) return { personId: id, matchStatus: 'email_matched' };
  }

  if (row.personName) {
    const ids = index.byName.get(row.personName.trim().toLowerCase());
    if (ids && ids.length === 1) return { personId: ids[0], matchStatus: 'name_matched' };
  }

  return { matchStatus: 'unmatched' };
}
