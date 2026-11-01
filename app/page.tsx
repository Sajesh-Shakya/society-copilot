import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { listAdminClubs } from "@/lib/auth/require-admin";
import { clubPath } from "@/lib/club-path";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) redirect("/login");

  const clubs = await listAdminClubs(user.email);
  if (clubs.length === 0) redirect("/login");
  if (clubs.length === 1) redirect(clubPath(clubs[0].slug, "/sessions"));
  redirect("/select-club");
}
