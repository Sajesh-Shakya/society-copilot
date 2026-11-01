// One-off admin account provisioning -- run manually, not exposed via the
// app. Usage: node scripts/create-admin.ts <email> <club-slug>
//
// Requires SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL in .env.local.
// Generates a strong random password for a NEW auth user (email_confirm:
// true, no confirmation email). If the auth user already exists, this is
// now a normal case -- it just adds the admin(email, club_id) row for the
// new club and prints no new password. Also upserts admin_allowlist, kept
// alongside admin as a rollback path for this release.

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is not set");

const email = process.argv[2]?.trim().toLowerCase();
const clubSlug = process.argv[3]?.trim().toLowerCase();
if (!email || !email.includes("@") || !clubSlug) {
  console.error("Usage: node scripts/create-admin.ts <email> <club-slug>");
  process.exit(1);
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

async function main() {
  const admin = createClient(supabaseUrl!, secretKey!, {
    auth: { persistSession: false },
  });

  const { data: club, error: clubError } = await admin
    .from("club")
    .select("id")
    .eq("slug", clubSlug!)
    .maybeSingle();
  if (clubError) {
    console.error(`Failed to look up club "${clubSlug}": ${clubError.message}`);
    process.exit(1);
  }
  if (!club) {
    console.error(`Unknown club slug: "${clubSlug}"`);
    process.exit(1);
  }

  const password = generatePassword();
  const { error: createError } = await admin.auth.admin.createUser({
    email: email!,
    password,
    email_confirm: true,
  });

  if (createError && createError.code !== "email_exists") {
    console.error(`Failed to create auth user for ${email}: ${createError.message}`);
    process.exit(1);
  }

  const { error: adminError } = await admin
    .from("admin")
    .upsert({ email: email!, club_id: club.id }, { onConflict: "email,club_id" });
  if (adminError) {
    console.error(`Auth user ready, but failed to add ${email} to admin for ${clubSlug}: ${adminError.message}`);
    process.exit(1);
  }

  const { error: allowlistError } = await admin
    .from("admin_allowlist")
    .upsert({ email: email! }, { onConflict: "email" });
  if (allowlistError) {
    console.error(`Added to admin, but failed to add ${email} to admin_allowlist: ${allowlistError.message}`);
    process.exit(1);
  }

  if (createError?.code === "email_exists") {
    console.log(`${email} already has an account -- added access to club "${clubSlug}". No new password.`);
  } else {
    console.log(`Created admin account for ${email}, club "${clubSlug}".`);
    console.log(`Password: ${password}`);
    console.log("Share this out-of-band (in person, group chat) -- never by email. It will not be shown again.");
  }
}

main();
