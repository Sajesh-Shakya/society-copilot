import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { ApprovalActions } from "@/components/chase/approval-actions";

export const dynamic = "force-dynamic";

export default async function ChaseInboxPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const admin = createAdminClient();
  const { data: chaseEmails } = await admin
    .from("chase_email")
    .select("id, person_id, sequence_number, status, subject, body, created_at")
    .in("status", ["pending_approval", "approved"])
    .order("created_at", { ascending: true });

  const personIds = [...new Set((chaseEmails ?? []).map((c) => c.person_id))];
  const { data: people } =
    personIds.length > 0
      ? await admin.from("person").select("id, full_name, email").in("id", personIds)
      : { data: [] };
  const peopleById = new Map((people ?? []).map((p) => [p.id, p]));

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Chase Email Approval Inbox</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Drafts awaiting approval, and approved drafts awaiting send.
      </p>

      <div className="mt-8 space-y-4">
        {chaseEmails && chaseEmails.length > 0 ? (
          chaseEmails.map((c) => {
            const person = peopleById.get(c.person_id);
            return (
              <div key={c.id} className="rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">
                      {person?.full_name ?? "Unknown"} ({person?.email ?? "unknown"})
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Reminder #{c.sequence_number} -- {c.status}
                    </p>
                  </div>
                  <ApprovalActions chaseEmailId={c.id} status={c.status} />
                </div>
                <div className="mt-3 text-sm">
                  <p className="font-medium">{c.subject}</p>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{c.body}</p>
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
