"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { listAdminClubs } from "@/lib/auth/require-admin";
import { clubPath } from "@/lib/club-path";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, "Password is required"),
});

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
  // Same generic message for a wrong password AND a valid login with no
  // admin access -- a distinct message for the latter would let an
  // attacker confirm a guessed password is correct for a real account
  // even without admin access (a credential-validation oracle), exactly
  // what signInWithPassword's own uniform error already avoids for the
  // email-doesn't-exist case.
  const INVALID_CREDENTIALS = "Invalid email or password.";
  if (error) {
    return { error: INVALID_CREDENTIALS };
  }

  const clubs = await listAdminClubs(parsed.data.email.toLowerCase());
  if (clubs.length === 0) {
    await supabase.auth.signOut();
    return { error: INVALID_CREDENTIALS };
  }
  if (clubs.length === 1) {
    redirect(clubPath(clubs[0].slug, "/sessions"));
  }
  redirect("/select-club");
}

export async function signOut(): Promise<never> {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
