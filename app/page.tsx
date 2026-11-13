import { redirect } from "next/navigation";
import { getSignedInEmail } from "@/lib/auth/session";
import { listAdminClubs } from "@/lib/auth/require-admin";
import { clubPath } from "@/lib/club-path";

export const dynamic = "force-dynamic";

export default async function Home() {
  const email = await getSignedInEmail();
  if (!email) redirect("/login");

  const clubs = await listAdminClubs(email);
  if (clubs.length === 0) redirect("/login");
  if (clubs.length === 1) redirect(clubPath(clubs[0].slug, "/sessions"));
  redirect("/select-club");
}
