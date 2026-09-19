import { notFound, redirect } from "next/navigation";
import { getSessionWithAttendance } from "@/lib/attendance/queries";
import { AttendanceScreen } from "@/components/attendance/attendance-screen";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";

// Attendance data changes constantly (ticks, syncs) — must never be
// statically prerendered/cached.
export const dynamic = "force-dynamic";

export default async function SessionAttendancePage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  const { sessionId } = await params;
  const session = await getSessionWithAttendance(sessionId);
  if (!session) notFound();

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <AttendanceScreen session={session} />
    </div>
  );
}
