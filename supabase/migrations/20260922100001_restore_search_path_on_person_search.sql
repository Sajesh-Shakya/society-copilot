-- Restore the search_path pin on search_person_by_name() that was
-- accidentally dropped by the email-match migration. The pg_trgm operators
-- (%, similarity()) live in the public schema, so search_path must be
-- explicitly pinned to include it, per the function_search_path_mutable advisory.

create or replace function public.search_person_by_name(search_query text, match_limit int default 8)
returns table (id uuid, full_name text, email text, cid text, similarity real)
language sql
stable
set search_path = public
as $$
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
  where full_name % search_query
     or email ilike '%' || search_query || '%'
  order by similarity desc
  limit match_limit;
$$;
