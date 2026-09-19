"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const emailSchema = z.string().email();

const GENERIC_MESSAGE = "If that email is authorized, a sign-in link has been sent.";

/**
 * Always returns GENERIC_MESSAGE regardless of whether the email is on
 * admin_allowlist — this must never reveal allowlist membership. Only calls
 * signInWithOtp (which sends the actual email) when it matches.
 */
export async function requestMagicLink(rawEmail: string): Promise<{ message: string }> {
  const email = emailSchema.parse(rawEmail).toLowerCase();

  const admin = createAdminClient();
  const { data } = await admin
    .from("admin_allowlist")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (!data) {
    return { message: GENERIC_MESSAGE };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
    },
  });
  if (error) throw error;

  return { message: GENERIC_MESSAGE };
}

export async function signOut() {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
