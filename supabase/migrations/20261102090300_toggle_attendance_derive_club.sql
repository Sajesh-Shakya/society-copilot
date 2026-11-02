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
    (select club_id from public.session where id = target_session_id),
    target_person_id,
    target_session_id,
    target_attended,
    'manual_tick',
    now()
  )
  on conflict (person_id, session_id)
  do update set attended = excluded.attended, recorded_at = excluded.recorded_at;
$function$;
