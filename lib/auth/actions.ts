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
  if (error) {
    return { error: "Invalid email or password." };
  }

  const clubs = await listAdminClubs(parsed.data.email.toLowerCase());
  if (clubs.length === 0) {
    await supabase.auth.signOut();
    return { error: "This account isn't an admin of any club." };
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
