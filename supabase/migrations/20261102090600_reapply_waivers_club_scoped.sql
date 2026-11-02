-- supabase/migrations/20261102090600_reapply_waivers_club_scoped.sql
drop function public.reapply_waivers_for_everyone_with_debt();

create function public.reapply_waivers_for_everyone_with_debt(target_club_id uuid)
returns table(person_id uuid, waived int)
language plpgsql
set search_path to 'public'
as $function$
declare
  v_person_id uuid;
begin
  if target_club_id is null then
    raise exception 'target_club_id is required';
  end if;
  for v_person_id in
    select adc.person_id from public.active_debt_cycle adc where adc.club_id = target_club_id
  loop
    person_id := v_person_id;
    waived := public.reapply_waivers_for_person(v_person_id);
    return next;
  end loop;
  return;
end;
$function$;

grant execute on function public.reapply_waivers_for_everyone_with_debt(uuid) to service_role;
