-- supabase/migrations/20261102090400_search_person_by_name_club_scoped.sql
drop function public.search_person_by_name(text, int);

create function public.search_person_by_name(target_club_id uuid, search_query text, match_limit int default 8)
returns table (id uuid, full_name text, email text, cid text, similarity real)
language sql stable
set search_path to 'public'
as $function$
  select
    id,
    full_name,
    email,
    cid,
    greatest(
      similarity(full_name, search_query),
      (case when email ilike '%' || search_query || '%' then 1 else 0 end)::real
    ) as similarity
  from public.person
  where club_id = target_club_id
    and (full_name % search_query or email ilike '%' || search_query || '%')
  order by similarity desc
  limit match_limit;
$function$;

grant execute on function public.search_person_by_name(uuid, text, int) to authenticated, anon, service_role;
