import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { listAdminClubs } from "@/lib/auth/require-admin";
import { clubPath } from "@/lib/club-path";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const dynamic = "force-dynamic";

export default async function SelectClubPage() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");

  const clubs = await listAdminClubs(user.email);
  if (clubs.length === 0) redirect("/login");
  if (clubs.length === 1) redirect(clubPath(clubs[0].slug, "/sessions"));

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-20">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Choose a club</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your account administers more than one club.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {clubs.map((club) => (
          <Link
            key={club.clubId}
            href={clubPath(club.slug, "/sessions")}
            className="rounded-lg border p-4 hover:bg-muted"
          >
            {club.name}
          </Link>
        ))}
      </div>
      <SignOutButton />
    </div>
  );
}
