// One-off admin account provisioning — run manually, not exposed via the app
// (no self-service signup, per docs/superpowers/specs/2026-09-19-admin-auth-design.md
// and the 2026-09-22 switch to password auth: this project's admin list is
// small and fixed, so accounts are created out-of-band by someone who already
// has SUPABASE_SECRET_KEY, not through a public registration flow).
//
// Usage:
//   node scripts/create-admin.ts someone@ic.ac.uk
//
// Requires SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL in .env.local (or
// the environment). Generates a strong random password, creates the
// Supabase Auth user with email_confirm: true (no confirmation email — the
// whole point is avoiding a dependency on Imperial's mail deliverability),
// and adds the email to admin_allowlist if it isn't already there. Prints
// the password once — share it out-of-band (in person, group chat), never
// by email. If the account already exists, use the Supabase dashboard
// (Authentication -> Users -> reset password) instead of this script.

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is not set");

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/create-admin.ts <email>");
  process.exit(1);
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url"); // 24 chars, ~144 bits
}

async function main() {
  const admin = createClient(supabaseUrl!, secretKey!, {
    auth: { persistSession: false },
  });

  const password = generatePassword();

  const { error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // no confirmation email
  });

  if (createError) {
    console.error(`Failed to create auth user for ${email}: ${createError.message}`);
    console.error(
      "If this account already exists, use the Supabase dashboard " +
        "(Authentication -> Users -> reset password) instead of this script."
    );
    process.exit(1);
  }

  const { error: allowlistError } = await admin
    .from("admin_allowlist")
    .upsert({ email }, { onConflict: "email" });

  if (allowlistError) {
    console.error(`Auth user created, but failed to add ${email} to admin_allowlist: ${allowlistError.message}`);
    console.error("Add it manually via the Supabase dashboard/SQL before they can sign in.");
    process.exit(1);
  }

  console.log(`Created admin account for ${email}.`);
  console.log(`Password: ${password}`);
  console.log("Share this out-of-band (in person, group chat) — never by email. It will not be shown again.");
}

main();
