import Link from "next/link";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";
import { redirect } from "next/navigation";
import { listRecentSessions } from "@/lib/attendance/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const dynamic = "force-dynamic";

export default async function SessionsIndexPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const sessions = await listRecentSessions();
  const todaySessions = sessions.filter((s) => s.isToday);
  const otherSessions = sessions.filter((s) => !s.isToday);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a session to take attendance, or create a new one.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/sessions/new">New session</Link>
          </Button>
          <SignOutButton />
        </div>
      </div>

      {todaySessions.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-muted-foreground">Today</h2>
          <div className="mt-2 flex flex-col gap-2">
            {todaySessions.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {todaySessions.length > 0 ? "Other recent sessions" : "Recent sessions"}
        </h2>
        <div className="mt-2 flex flex-col gap-2">
          {otherSessions.length > 0 ? (
            otherSessions.map((s) => <SessionRow key={s.id} session={s} />)
          ) : (
            <p className="text-sm text-muted-foreground">No other sessions in the last 30 days.</p>
          )}
        </div>
      </div>

      {sessions.length === 0 && (
        <p className="mt-8 text-sm text-muted-foreground">
          No sessions yet — create one to get started.
        </p>
      )}
    </div>
  );
}

function SessionRow({
  session,
}: {
  session: { id: string; title: string; startsAt: string; attendeeCount: number };
}) {
  return (
    <Link
      href={`/sessions/${session.id}`}
      className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted"
    >
      <div>
        <p className="font-medium">{session.title}</p>
        <p className="text-xs text-muted-foreground">{new Date(session.startsAt).toLocaleString()}</p>
      </div>
      <Badge variant="secondary">{session.attendeeCount} attendee{session.attendeeCount === 1 ? "" : "s"}</Badge>
    </Link>
  );
}
