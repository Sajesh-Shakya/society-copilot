import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

/**
 * Server-only privileged client (SUPABASE_SECRET_KEY -> Postgres role
 * `service_role`, has BYPASSRLS). Every table this feature created
 * (person, session, purchase, attendance_record, sync_cursor, chase_email)
 * has RLS enabled with no anon/authenticated write policy (attendance_record
 * grants anon read-only, for Realtime — see the task-1.5 migration), so any
 * server-side read/write for this feature goes through this client, never
 * lib/supabase/server.ts's cookie-based publishable-key client.
 *
 * NEVER import this file from a Client Component or expose it to the
 * browser — SUPABASE_SECRET_KEY has no NEXT_PUBLIC_ prefix specifically so
 * it's never bundled client-side; keep it that way.
 */
export function createAdminClient() {
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  if (!secretKey) throw new Error("SUPABASE_SECRET_KEY is not set");

  return createSupabaseClient(supabaseUrl, secretKey, {
    auth: { persistSession: false },
  });
}
