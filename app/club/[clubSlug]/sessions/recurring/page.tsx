import Link from "next/link";
import { redirect } from "next/navigation";
import { clubPath } from "@/lib/club-path";
import { RecurringSessionForm } from "@/components/attendance/recurring-session-form";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";

export default async function RecurringSessionPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const { clubSlug } = await params;
  try {
    await requireAdmin(clubSlug);
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Link href={clubPath(clubSlug, "/sessions")} className="text-sm text-muted-foreground underline">
        ← All sessions
      </Link>
      <div className="mt-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New recurring series</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a session every week, from the first date until the repeat-until date.
          </p>
        </div>
        <SignOutButton />
      </div>
      <div className="mt-8">
        <RecurringSessionForm clubSlug={clubSlug} />
      </div>
    </div>
  );
}
