"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const emailSchema = z.string().email();
const otpCodeSchema = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");

const GENERIC_MESSAGE = "If that email is authorized, a sign-in code has been sent.";

/**
 * Always returns GENERIC_MESSAGE regardless of whether the email is on
 * admin_allowlist — this must never reveal allowlist membership. Only calls
 * signInWithOtp (which sends the actual email) when it matches.
 *
 * No emailRedirectTo: the sign-in code arrives as a 6-digit number the user
 * types in, not a link, so email security scanners (e.g. Microsoft Safe
 * Links) that pre-fetch URLs in incoming mail can't consume it before the
 * user does. See lib/auth/actions.ts history for the magic-link version this
 * replaced.
 */
export async function requestOtpCode(rawEmail: string): Promise<{ message: string }> {
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
    const { error } = await supabase.auth.signInWithOtp({ email });
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

export async function verifyOtpCode(rawEmail: string, rawCode: string): Promise<{ error?: string }> {
  const email = emailSchema.parse(rawEmail).toLowerCase();
  const parsedCode = otpCodeSchema.safeParse(rawCode);
  if (!parsedCode.success) {
    return { error: parsedCode.error.issues[0].message };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.verifyOtp({
    email,
    token: parsedCode.data,
    type: "email",
  });
  if (error) {
    return { error: "That code is incorrect or has expired." };
  }

  redirect("/sessions");
}

export async function signOut(): Promise<never> {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
