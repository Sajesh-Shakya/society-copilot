import { redirect } from "next/navigation";
import { getSignedInEmail } from "@/lib/auth/session";
import { clubPath } from "@/lib/club-path";

export default async function ClubIndexPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const email = await getSignedInEmail();
  if (!email) redirect("/login");

  const { clubSlug } = await params;
  redirect(clubPath(clubSlug, "/sessions"));
}
