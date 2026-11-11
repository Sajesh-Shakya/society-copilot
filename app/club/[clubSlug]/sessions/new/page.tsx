import Link from "next/link";
import { redirect } from "next/navigation";
import { clubPath } from "@/lib/club-path";
import { EactivitiesProvider } from "@/lib/eactivities/provider";
import { getEactivitiesCredentials } from "@/lib/eactivities/credentials";
import { EactivitiesNotConfiguredError } from "@/lib/eactivities/types";
import { SessionPicker } from "@/components/attendance/session-picker";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";

// This calls the real eActivities API server-side on every request — must
// never be statically prerendered (that would bake in whatever the API
// returned at build time, or fail the build if it's unreachable then).
export const dynamic = "force-dynamic";

export default async function NewSessionPage({
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

  let events: Awaited<ReturnType<EactivitiesProvider["getEvents"]>>;
  try {
    const provider = new EactivitiesProvider(await getEactivitiesCredentials(clubId));
    events = await provider.getEvents();
  } catch (error) {
    if (error instanceof EactivitiesNotConfiguredError) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-10">
          <Link href={clubPath(clubSlug, "/sessions")} className="text-sm text-muted-foreground underline">
            ← All sessions
          </Link>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">New session</h1>
          <p className="mt-4 text-sm text-muted-foreground">
            eActivities isn&apos;t available for this club yet — use CSV import instead.
          </p>
        </div>
      );
    }
    throw error;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Link href={clubPath(clubSlug, "/sessions")} className="text-sm text-muted-foreground underline">
        ← All sessions
      </Link>
      <div className="mt-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New session</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick the What&apos;s On event, then which of its signups is the attendance
            roster — eActivities doesn&apos;t flag which one, if any, that is.
          </p>
        </div>
        <SignOutButton />
      </div>
      <div className="mt-8">
        <SessionPicker
          events={events.map((e) => ({
            id: e.ID,
            title: e.Title,
            startsAt: e.EventStart,
          }))}
          clubSlug={clubSlug}
        />
      </div>
    </div>
  );
}
