// One-off eActivities credential provisioning -- run manually, not exposed
// via the app. Usage: node scripts/set-eactivities-credentials.ts <club-slug> <api-key> <csp-code>
//
// Requires SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_URL in .env.local.
// Upserts a club_credential row (provider: 'eactivities') for the given
// club -- re-running this for a club that already has a row updates it in
// place (e.g. to rotate a key), rather than erroring on the primary key.

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is not set");

const clubSlug = process.argv[2]?.trim().toLowerCase();
const apiKey = process.argv[3]?.trim();
const cspCode = process.argv[4]?.trim();
if (!clubSlug || !apiKey || !cspCode) {
  console.error("Usage: node scripts/set-eactivities-credentials.ts <club-slug> <api-key> <csp-code>");
  process.exit(1);
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

  const { error: upsertError } = await admin
    .from("club_credential")
    .upsert(
      { club_id: club.id, provider: "eactivities", credentials: { apiKey, cspCode }, updated_at: new Date().toISOString() },
      { onConflict: "club_id,provider" }
    );
  if (upsertError) {
    console.error(`Failed to store eActivities credentials for "${clubSlug}": ${upsertError.message}`);
    process.exit(1);
  }

  console.log(`Stored eActivities credentials for club "${clubSlug}".`);
}

main();
