"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

/**
 * Password-based sign-in. Accounts are created out-of-band (see
 * scripts/create-admin.ts) — there is no self-service signup, so anyone with
 * a valid Supabase Auth account here is already a known admin. No separate
 * admin_allowlist check is needed at sign-in time: supabase.auth.signInWithPassword
 * already returns a uniform "Invalid login credentials" error whether the
 * email doesn't exist or the password is wrong (no enumeration oracle), and
 * requireAdmin() re-checks admin_allowlist on every subsequent request
 * regardless — see lib/auth/require-admin.ts.
 */
export async function signIn(rawEmail: string, rawPassword: string): Promise<{ error?: string }> {
  const parsed = credentialsSchema.safeParse({ email: rawEmail, password: rawPassword });
  if (!parsed.success) {
    return { error: "Enter a valid email and password." };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email.toLowerCase(),
    password: parsed.data.password,
  });
  if (error) {
    return { error: "Invalid email or password." };
  }

  redirect("/sessions");
}

export async function signOut(): Promise<never> {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
