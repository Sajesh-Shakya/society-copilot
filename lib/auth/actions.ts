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
  const startedAt = Date.now();
  const MIN_DURATION_MS = 400; // floor so the non-match path can't be trivially distinguished by response time

  const admin = createAdminClient();
  const { data, error: lookupError } = await admin
    .from("admin_allowlist")
    .select("email")
    .eq("email", email)
    .maybeSingle();
  if (lookupError) {
    console.error("admin_allowlist lookup failed:", lookupError);
  }

  if (data) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
      },
    });
    if (error) {
      // Never let this reach the caller — an error only reachable on the
      // allowlisted path (e.g. Supabase's OTP rate limit) would otherwise be
      // a deterministic oracle for allowlist membership. Log server-side only.
      console.error("signInWithOtp failed:", error);
    }
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_DURATION_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_DURATION_MS - elapsed));
  }

  return { message: GENERIC_MESSAGE };
}

export async function signOut(): Promise<never> {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
