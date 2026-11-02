-- supabase/migrations/20261102090700_reapply_waivers_club_scoped_fixup.sql
-- Follow-up fix: the prior migration's DROP FUNCTION + CREATE FUNCTION
-- silently reset reapply_waivers_for_everyone_with_debt's grants to
-- Postgres defaults (EXECUTE to PUBLIC) and dropped its comment, neither of
-- which the brief's migration SQL re-added. Restore both so the function
-- stays exactly service_role-only, as it was before this plan touched it.
revoke execute on function public.reapply_waivers_for_everyone_with_debt(uuid) from public;

comment on function public.reapply_waivers_for_everyone_with_debt(uuid) is
  'Safety-net sweep: re-checks every person currently showing outstanding debt (active_debt_cycle) in one club for leftover purchase waiving capacity, one round trip for the whole sweep instead of one per person times one per purchase. See lib/purchase/interface.ts and the weekly chase-emails cron that calls it.';
