-- Migration: widen person search to also match on email (AC-10)
-- specs/attendance-payment-chasing/requirements.md AC-10
--
-- Email is person's unique identifier. A name search alone can miss a
-- correctly-spelled email attached to an unfamiliar or misspelled name.
-- Same function name/signature/return shape as before -- every existing
-- caller (lib/attendance/actions.ts's searchPeople()) keeps working
-- unchanged.

create or replace function public.search_person_by_name(search_query text, match_limit int default 8)
returns table (id uuid, full_name text, email text, cid text, similarity real)
language sql
stable
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
