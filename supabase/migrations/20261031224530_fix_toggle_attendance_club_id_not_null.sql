-- Hotfix: the multi-tenancy foundation migrations (20261031174454
-- add_club_id_to_existing_tables) made attendance_record.club_id NOT NULL,
-- but this function's insert never set it -- every attendance tick via
-- toggle_attendance (the atomic RPC added in add_atomic_toggle_attendance_rpc)
-- has been failing in production since that migration landed. Resolves the
-- Judo club inline since no application code threads a real clubId through
-- yet (that's a later plan's job) -- same stopgap as lib/supabase/default-club.ts.
create or replace function public.toggle_attendance(
  target_person_id uuid,
  target_session_id uuid,
  target_attended boolean
)
returns void
language sql
set search_path to 'public'
as $function$
  insert into public.attendance_record (club_id, person_id, session_id, attended, source, recorded_at)
  values (
    (select id from public.club where slug = 'judo'),
    target_person_id,
    target_session_id,
    target_attended,
    'manual_tick',
    now()
  )
  on conflict (person_id, session_id)
  do update set attended = excluded.attended, recorded_at = excluded.recorded_at;
$function$;
