import Link from "next/link";
import { redirect } from "next/navigation";
import { EactivitiesProvider } from "@/lib/eactivities/provider";
import { SessionPicker } from "@/components/attendance/session-picker";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";

// This calls the real eActivities API server-side on every request — must
// never be statically prerendered (that would bake in whatever the API
// returned at build time, or fail the build if it's unreachable then).
export const dynamic = "force-dynamic";

export default async function NewSessionPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const provider = new EactivitiesProvider();
  const events = await provider.getEvents();

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/sessions" className="text-sm text-muted-foreground underline">
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
        />
      </div>
    </div>
  );
}
