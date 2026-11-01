import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { clubPath } from "@/lib/club-path";

export default async function ClubIndexPage({
  params,
}: {
  params: Promise<{ clubSlug: string }>;
}) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { clubSlug } = await params;
  redirect(clubPath(clubSlug, "/sessions"));
}
