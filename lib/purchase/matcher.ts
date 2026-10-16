import { createAdminClient } from '@/lib/supabase/admin';
import { RawPurchaseRow, MatchResult, isStudentMemberType } from './types';
import { escapeIlikePattern, normalizeCid } from '@/lib/utils';

export async function matchPersonRecord(row: RawPurchaseRow): Promise<MatchResult> {
  const admin = createAdminClient();

  // Rule 1: If row has CID, look for exact CID match (normalized -- see
  // normalizeCid's doc comment on why a numeric-typed Excel cell can lose
  // the real CID's leading zero).
  if (row.personCid) {
    const { data } = await admin
      .from('person')
      .select('id')
      .eq('cid', normalizeCid(row.personCid))
      .maybeSingle();

    if (data) {
      return { personId: data.id, matchStatus: 'cid_matched' };
    }
  }

  // Rule 2: If is_student = true and CID didn't match, stop here --
  // no email or name fallback for students. A student's CID is the one
  // identifier this codebase actually trusts; falling back to a weaker
  // signal (email, or a same-name coincidence) risks misattributing a
  // real payment, so this is left unmatched for manual review instead.
  if (row.personCid && isStudentMemberType(row.memberType)) {
    return { matchStatus: 'unmatched' };
  }

  // Rule 3: For non-students (or students with no CID), try email match.
  // person.email is stored verbatim (not normalized) elsewhere in this
  // codebase, so match case-insensitively rather than assuming lowercase.
  // Wildcard-escaped -- see lib/utils.ts's escapeIlikePattern -- so e.g.
  // "j_smith@gmail.com" can't wrongly match an existing "j.smith@gmail.com".
  if (row.personEmail) {
    const { data } = await admin
      .from('person')
      .select('id')
      .ilike('email', escapeIlikePattern(row.personEmail))
      .maybeSingle();

    if (data) {
      return { personId: data.id, matchStatus: 'email_matched' };
    }
  }

  // Rule 4 (last resort): neither CID nor email matched or was available
  // -- real exports from this union have no email column at all, and an
  // external/non-member buyer has no CID either, so name is sometimes the
  // only thing to go on. Only auto-matches when the name is unambiguous
  // (exactly one person has it); two people can share a full name, and a
  // wrong auto-match here would misattribute a real payment, so an
  // ambiguous name is left unmatched for manual review rather than
  // guessed. Deliberately not reached for a CID-bearing student who
  // failed Rule 1 (Rule 2 already stopped) -- same reasoning as the email
  // fallback those are denied.
  if (row.personName) {
    const { data } = await admin
      .from('person')
      .select('id')
      .ilike('full_name', escapeIlikePattern(row.personName.trim()));

    if (data && data.length === 1) {
      return { personId: data[0].id, matchStatus: 'name_matched' };
    }
  }

  // Rule 5: No match found
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
