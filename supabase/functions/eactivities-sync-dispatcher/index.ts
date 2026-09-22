// Edge Function: dispatches per-session eActivities syncs (AC-7, task 2.3).
// Invoked by pg_cron (see supabase/migrations for the cron.schedule call),
// NOT by an end user and not via Vercel Cron — see design.md's Scheduling
// Architecture Decision. Queries `session` directly (fast, no network hop)
// then calls out to the Next.js app's CRON_SECRET-protected route for the
// actual sync, so the eActivities/upsert logic lives in exactly one place.
//
// verify_jwt is OFF for this function (see deploy call) because this
// project uses the new sb_publishable_/sb_secret_ key system, which isn't
// JWT-based — Supabase's built-in verify_jwt only understands legacy
// anon/service_role JWTs and would reject every call made with the new
// keys. Auth here is custom instead: the caller must present this
// project's own secret key on the `apikey` header (checked below), exactly
// as Supabase's own pg_net + Edge Function docs recommend for this key
// system ("Database Webhooks and pg_net" — send the secret key on `apikey`,
// not `Authorization: Bearer`).

import { createClient } from "jsr:@supabase/supabase-js@2";

const SYNC_WINDOW_START_MIN = 50; // minutes before session.starts_at
const SYNC_WINDOW_END_MIN = 70;
const RESYNC_GUARD_MIN = 45; // don't re-trigger a session synced more recently than this

Deno.serve(async (req: Request) => {
  const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
  const ourSecretKey: string | undefined = secretKeys.default;

  const presentedKey = req.headers.get("apikey");
  if (!ourSecretKey || presentedKey !== ourSecretKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  const appUrl = Deno.env.get("VERCEL_APP_URL");
  if (!cronSecret || !appUrl) {
    return new Response(
      JSON.stringify({ error: "CRON_SECRET / VERCEL_APP_URL not configured on this function" }),
      { status: 500 }
    );
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, ourSecretKey);

  const now = new Date();
  const windowStart = new Date(now.getTime() + SYNC_WINDOW_START_MIN * 60_000).toISOString();
  const windowEnd = new Date(now.getTime() + SYNC_WINDOW_END_MIN * 60_000).toISOString();
  const resyncGuard = new Date(now.getTime() - RESYNC_GUARD_MIN * 60_000).toISOString();

  const { data: sessions, error } = await supabase
    .from("session")
    .select("id")
    .not("eactivities_signup_id", "is", null)
    .gte("starts_at", windowStart)
    .lte("starts_at", windowEnd)
    .or(`last_synced_at.is.null,last_synced_at.lt.${resyncGuard}`);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results = await Promise.all(
    (sessions ?? []).map(async (session) => {
      const response = await fetch(`${appUrl}/api/cron/eactivities-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cronSecret}`,
        },
        body: JSON.stringify({ sessionId: session.id }),
      });
      return { sessionId: session.id, status: response.status };
    })
  );

  return new Response(JSON.stringify({ dispatched: results }), {
    headers: { "Content-Type": "application/json" },
  });
});
