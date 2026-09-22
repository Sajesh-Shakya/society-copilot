-- Migration: fuzzy name search for person (AC-4)
-- specs/attendance-payment-chasing/tasks.md 3.4

create extension if not exists pg_trgm;

create index person_full_name_trgm_idx on public.person
  using gin (full_name gin_trgm_ops);

-- SECURITY INVOKER (default): only ever called via the admin (secret-key)
-- client, which already bypasses RLS regardless.
create or replace function public.search_person_by_name(search_query text, match_limit int default 8)
returns table (id uuid, full_name text, email text, cid text, similarity real)
language sql
stable
as $$
  select id, full_name, email, cid, similarity(full_name, search_query) as similarity
  from public.person
  where full_name % search_query
  order by similarity desc
  limit match_limit;
$$;
