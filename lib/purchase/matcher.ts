import { createAdminClient } from '@/lib/supabase/admin';
import { RawPurchaseRow, MatchResult, isStudentMemberType } from './types';

export async function matchPersonRecord(row: RawPurchaseRow): Promise<MatchResult> {
  const admin = createAdminClient();

  // Rule 1: If row has CID, look for exact CID match
  if (row.personCid) {
    const { data } = await admin
      .from('person')
      .select('id')
      .eq('cid', row.personCid)
      .maybeSingle();

    if (data) {
      return { personId: data.id, matchStatus: 'cid_matched' };
    }
  }

  // Rule 2: If is_student = true and CID didn't match, stop here (no email fallback for students)
  if (row.personCid && isStudentMemberType(row.memberType)) {
    return { matchStatus: 'unmatched' };
  }

  // Rule 3: For non-students (or students with no CID), try email match.
  // person.email is stored verbatim (not normalized) elsewhere in this
  // codebase, so match case-insensitively rather than assuming lowercase.
  if (row.personEmail) {
    const { data } = await admin
      .from('person')
      .select('id')
      .ilike('email', row.personEmail)
      .maybeSingle();

    if (data) {
      return { personId: data.id, matchStatus: 'email_matched' };
    }
  }

  // Rule 4: No match found
  return { matchStatus: 'unmatched' };
}

export async function matchOrQueue(
  rows: RawPurchaseRow[]
): Promise<{ matched: Map<string, MatchResult>; unmatched: RawPurchaseRow[] }> {
  const matched = new Map<string, MatchResult>();
  const unmatched: RawPurchaseRow[] = [];

  for (const row of rows) {
    const result = await matchPersonRecord(row);
    if (result.matchStatus === 'unmatched') {
      unmatched.push(row);
    } else {
      matched.set(row.externalId, result);
    }
  }

  return { matched, unmatched };
}
