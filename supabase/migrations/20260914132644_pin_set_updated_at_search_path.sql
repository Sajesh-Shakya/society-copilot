-- Fixes function_search_path_mutable advisory raised against the
-- set_updated_at() function created in 20260914130349_create_person_table.sql.
-- An unpinned search_path on a function is a known Postgres privilege-
-- escalation vector (a malicious schema earlier in the caller's search_path
-- could shadow an unqualified reference). This function has no unqualified
-- references (now() resolves via pg_catalog, always implicitly searched
-- first), so search_path = '' is safe here.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
