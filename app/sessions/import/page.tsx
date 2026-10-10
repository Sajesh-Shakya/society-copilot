import Link from "next/link";
import { redirect } from "next/navigation";
import { CsvImporter } from "@/components/attendance/csv-importer";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { requireAdmin, UnauthorizedError } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";

export default async function ImportSessionPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Link href="/sessions" className="text-sm text-muted-foreground underline">
        ← All sessions
      </Link>
      <div className="mt-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New session (CSV import)</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fail-safe for when eActivities&apos; whatson/signups API is down — upload
            the attendee roster exported from eActivities&apos; own dashboard instead.
          </p>
        </div>
        <SignOutButton />
      </div>
      <div className="mt-8">
        <CsvImporter />
      </div>
    </div>
  );
}
