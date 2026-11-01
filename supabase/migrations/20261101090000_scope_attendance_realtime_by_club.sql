-- supabase/migrations/20261101090000_scope_attendance_realtime_by_club.sql
-- Was checking admin_allowlist directly (any admin, any club, could
-- subscribe to any club's attendance_record rows). Scopes it to admin,
-- per club, so a Taekwondo admin's attendance screen also gets live
-- updates (admin_allowlist never had them) and a Judo admin can no
-- longer subscribe to Taekwondo's rows.
drop policy attendance_record_select_authenticated_admin on public.attendance_record;

create policy attendance_record_select_authenticated_admin on public.attendance_record
  for select
  to authenticated
  using (
    exists (
      select 1 from public.admin
      where email = lower((select auth.jwt() ->> 'email'))
        and club_id = attendance_record.club_id
    )
  );
