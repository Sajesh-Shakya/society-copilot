import { PendingLink } from '@/components/nav/pending-link';
import { requireAdmin, UnauthorizedError } from '@/lib/auth/require-admin';
import { redirect } from 'next/navigation';
import { clubPath } from '@/lib/club-path';
import {
  listIncompleteNames,
  listOpenConflicts,
  listRecentOverwrites,
  listSameNameGroups,
  loadClubPeople,
} from '@/lib/identity/review-queries';
import { ConflictList } from '@/components/identity/conflict-list';
import { SameNameGroups } from '@/components/identity/same-name-groups';

export const dynamic = 'force-dynamic';

export default async function PeopleReviewPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  let clubId: string;
  try {
    ({ clubId } = await requireAdmin(clubSlug));
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect('/login');
    throw error;
  }

  // One paged person load feeds both the same-name groups and the one-word names.
  const peoplePromise = loadClubPeople(clubId);
  const [conflicts, overwrites, groups, incomplete] = await Promise.all([
    listOpenConflicts(clubId),
    listRecentOverwrites(clubId, 30),
    peoplePromise.then((people) => listSameNameGroups(clubId, people)),
    peoplePromise.then((people) => listIncompleteNames(clubId, people)),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <PendingLink href={clubPath(clubSlug, '/sessions')} className="text-sm text-muted-foreground underline">
        ← All sessions
      </PendingLink>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">People review</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        CID conflicts that need a decision, people who may be duplicates, and names that look incomplete.
      </p>

      <section className="mt-8">
        <h2 className="font-semibold">Open CID conflicts ({conflicts.length})</h2>
        <div className="mt-3">
          <ConflictList clubSlug={clubSlug} conflicts={conflicts} />
        </div>
      </section>

      <section className="mt-8">
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-semibold">Recent changes ({overwrites.length})</summary>
          {overwrites.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No CIDs have been overwritten.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {overwrites.map((o) => (
                <li key={o.id} className="text-sm" data-testid="recent-change">
                  <span className="font-medium">{o.personName}</span>
                  {': CID '}
                  {o.previousCid ?? 'none'}
                  {o.previousSource ? ` (${o.previousSource})` : ''}
                  {o.otherPersonName ? (
                    <> taken by {o.otherPersonName} ({o.newSource} evidence)</>
                  ) : (
                    <>
                      {' → '}
                      {o.newCid} ({o.newSource})
                    </>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {' · '}
                    {new Date(o.createdAt).toLocaleString()}
                    {o.by ? ` · by ${o.by}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold">Same-name groups ({groups.length})</h2>
        <p className="text-sm text-muted-foreground">
          People with the same full name. If they are one person, pick which record to keep and merge the rest into it; if not, mark them as different.
        </p>
        <div className="mt-3">
          <SameNameGroups clubSlug={clubSlug} groups={groups} />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold">Names that look incomplete ({incomplete.length})</h2>
        <p className="text-sm text-muted-foreground">People whose full name is a single word.</p>
        {incomplete.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1">
            {incomplete.map((p) => (
              <li key={p.id} className="text-sm" data-testid="incomplete-name">
                <span className="font-medium">{p.fullName}</span>
                <span className="text-xs text-muted-foreground">
                  {' · '}
                  {p.email ?? 'No email'}
                  {' · CID '}
                  {p.cid ?? 'none'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
