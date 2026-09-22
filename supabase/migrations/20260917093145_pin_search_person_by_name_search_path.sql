-- Fixes function_search_path_mutable advisory raised against
-- search_person_by_name(), same class of issue as set_updated_at() earlier.
-- pg_trgm's operators/functions (%, similarity()) live in whichever schema
-- the extension was installed into (public here), so search_path must
-- include it explicitly rather than being pinned to ''.

create or replace function public.search_person_by_name(search_query text, match_limit int default 8)
returns table (id uuid, full_name text, email text, cid text, similarity real)
language sql
stable
set search_path = public
as $$
  select id, full_name, email, cid, similarity(full_name, search_query) as similarity
  from public.person
  where full_name % search_query
  order by similarity desc
  limit match_limit;
$$;
