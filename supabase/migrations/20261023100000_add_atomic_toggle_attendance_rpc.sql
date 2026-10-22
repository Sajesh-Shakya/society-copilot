-- Migration: atomic toggle_attendance function, closing a check-then-act
-- race in toggleAttendance (lib/attendance/actions.ts).
--
-- toggleAttendance previously did SELECT (does a row exist?) then branched
-- to INSERT or UPDATE. If two admins both tick a person who isn't on the
-- roster yet (e.g. a walk-in) at the same instant, both SELECTs can see
-- "no row" before either INSERT lands, and both attempt to INSERT -- the
-- second hits attendance_record_person_id_session_id_key's unique
-- violation and throws, surfacing as an error toast for whichever admin
-- lost the race. Not data corruption (the unique constraint guarantees
-- there can never be two rows for the same person+session, so this can
-- never look like "attended 2 sessions" -- it's a transient error, not a
-- duplicate), but still a real, closeable race.
--
-- A single INSERT ... ON CONFLICT DO UPDATE is atomic and race-free. It
-- can't be expressed via supabase-js's .upsert(), which always overwrites
-- every column it's given on conflict -- the whole point here (preserving
-- a csv_import/signup_sync row's source when someone ticks it, per the
-- 2026-10-13 fix) is to update attended/recorded_at ONLY, leaving source
-- untouched on conflict. SQL's ON CONFLICT DO UPDATE SET <specific
-- columns> expresses exactly that, in one statement, with no window for
-- another transaction to interleave.
create or replace function public.toggle_attendance(
  target_person_id uuid,
  target_session_id uuid,
  target_attended boolean
)
returns void
language sql
set search_path = public
as $$
  insert into public.attendance_record (person_id, session_id, attended, source, recorded_at)
  values (target_person_id, target_session_id, target_attended, 'manual_tick', now())
  on conflict (person_id, session_id)
  do update set attended = excluded.attended, recorded_at = excluded.recorded_at;
$$;

comment on function public.toggle_attendance(uuid, uuid, boolean) is
  'Atomic insert-or-update for a single attendance tick -- source is only ever set on a brand-new row (literal manual_tick in the INSERT values), never touched by the ON CONFLICT DO UPDATE, so ticking an existing csv_import/signup_sync row preserves its provenance. See lib/attendance/actions.ts toggleAttendance.';

revoke execute on function public.toggle_attendance(uuid, uuid, boolean) from public;
grant execute on function public.toggle_attendance(uuid, uuid, boolean) to service_role;
