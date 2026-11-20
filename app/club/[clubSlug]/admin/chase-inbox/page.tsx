import Link from "next/link";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { redirect } from "next/navigation";
import { createClubScopedClient } from "@/lib/supabase/club-scoped";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApprovalActions } from "@/components/chase/approval-actions";
import { AutoSendControls, type StandingPerson } from "@/components/chase/auto-send-controls";
import { clubPath } from "@/lib/club-path";

export const dynamic = "force-dynamic";

export default async function ChaseInboxPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  let clubId: string;
  try {
    ({ clubId } = await requireAdmin(clubSlug));
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const scoped = createClubScopedClient(clubId);
  const { data: chaseEmails } = await scoped
    .from("chase_email")
    .select("id, person_id, sequence_number, status, subject, body, note, created_at")
    .in("status", ["pending_approval", "approved", "failed"])
    .order("created_at", { ascending: true });

  const chaseEmailRows = (chaseEmails ?? []) as unknown as {
    id: string;
    person_id: string;
    sequence_number: number;
    status: string;
    subject: string;
    body: string;
    note: string | null;
    created_at: string;
  }[];

  const personIds = [...new Set(chaseEmailRows.map((c) => c.person_id))];
  const { data: people } =
    personIds.length > 0
      ? await scoped.from("person").select("id, full_name, email, chase_auto_approved_at").in("id", personIds)
      : { data: [] };
  const personRows = (people ?? []) as unknown as {
    id: string;
    full_name: string;
    email: string;
    chase_auto_approved_at: string | null;
  }[];
  const peopleById = new Map(personRows.map((p) => [p.id, p]));

  const [{ data: clubRow }, { data: standing }] = await Promise.all([
    createAdminClient().from("club").select("chase_auto_send_paused").eq("id", clubId).single(),
    scoped
      .from("person")
      .select("id, full_name, email, chase_auto_approved_at")
      .not("chase_auto_approved_at", "is", null)
      .order("full_name"),
  ]);
  const standingPeople: StandingPerson[] = (
    (standing ?? []) as unknown as { id: string; full_name: string; email: string; chase_auto_approved_at: string }[]
  ).map((p) => ({ id: p.id, fullName: p.full_name, email: p.email, since: p.chase_auto_approved_at }));

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:py-10">
      <Link href={clubPath(clubSlug, "/sessions")} className="text-sm text-muted-foreground underline">
        ← All sessions
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Chase Email Approval Inbox</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Drafts awaiting approval, and approved drafts awaiting send.
      </p>

      <AutoSendControls
        clubSlug={clubSlug}
        paused={clubRow?.chase_auto_send_paused ?? false}
        globalEnabled={process.env.CHASE_AUTO_SEND_REPEATS === "true"}
        people={standingPeople}
      />

      <div className="mt-8 space-y-4">
        {chaseEmailRows.length > 0 ? (
          chaseEmailRows.map((c) => {
            const person = peopleById.get(c.person_id);
            return (
              <div key={c.id} className="rounded-lg border p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold break-words">
                      {person?.full_name ?? "Unknown"} ({person?.email ?? "unknown"})
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Reminder #{c.sequence_number} -- {c.status}
                    </p>
                  </div>
                  <ApprovalActions
                    clubSlug={clubSlug}
                    chaseEmailId={c.id}
                    status={c.status}
                    personHasStandingApproval={Boolean(person?.chase_auto_approved_at)}
                  />
                </div>
                <div className="mt-3 text-sm">
                  <p className="font-medium">{c.subject}</p>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c.body}</p>
                  {c.status === "failed" && c.note && (
                    <p className="mt-2 text-sm text-destructive">Send failed: {c.note}</p>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <p className="text-sm text-muted-foreground">Nothing awaiting approval or send.</p>
        )}
      </div>
    </div>
  );
}
