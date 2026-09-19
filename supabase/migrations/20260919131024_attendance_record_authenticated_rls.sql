-- Migration: attendance_record RLS -> authenticated + allowlist
-- Closes specs/attendance-payment-chasing/tasks.md task 3.3a
-- docs/superpowers/specs/2026-09-19-admin-auth-design.md
--
-- Replaces the anon-SELECT policy (needed before real auth existed, so
-- Realtime's postgres_changes could reach the browser at all) with a policy
-- scoped to authenticated admins. The browser client (lib/supabase/client.ts)
-- already picks up the signed-in user's session automatically, so the
-- Realtime subscription now connects as `authenticated` instead of `anon`.
-- auth.jwt()/auth.uid() are unaffected by this project's sb_publishable_/
-- sb_secret_ key migration -- that changed the project-level API keys, not
-- per-user session tokens, which remain ordinary Supabase Auth JWTs.

drop policy attendance_record_select_anon on public.attendance_record;

create policy attendance_record_select_authenticated_admin on public.attendance_record
  for select
  to authenticated
  using (
    exists (
      select 1 from public.admin_allowlist
      where email = lower((select auth.jwt() ->> 'email'))
    )
  );
