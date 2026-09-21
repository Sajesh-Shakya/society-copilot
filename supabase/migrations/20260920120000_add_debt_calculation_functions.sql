-- Migration: debt calculation view + person_outstanding_debt function
-- specs/attendance-payment-chasing/tasks.md 5.1, 5.2
-- Enables: MP-1, MP-2, DC-1

-- A person's attendance rows that currently count as outstanding (unpaid)
-- debt: not their free trial (first-ever attendance, chronologically by
-- session date), not already waived by a purchase, and not covered by an
-- active term/annual pass at the time of that session.
--
-- SECURITY INVOKER (default): only ever called via the admin (secret-key)
-- client, which already bypasses RLS regardless -- same convention as
-- search_person_by_name (see 20260917092731_add_person_fuzzy_name_search.sql).
create or replace view public.outstanding_attendance as
select ar.id, ar.person_id, ar.session_id, s.starts_at
from public.attendance_record ar
join public.session s on s.id = ar.session_id
where ar.waived_by_purchase_id is null
  and ar.id <> (
    select ar2.id
    from public.attendance_record ar2
    join public.session s2 on s2.id = ar2.session_id
    where ar2.person_id = ar.person_id
    order by s2.starts_at asc, ar2.id asc
    limit 1
  )
  and not exists (
    select 1
    from public.purchase p
    join public.product pr on pr.id = p.product_id
    where p.person_id = ar.person_id
      and pr.kind in ('term_pass', 'annual_pass')
      and pr.covers_days is not null
      and s.starts_at >= p.purchased_at
      and s.starts_at < p.purchased_at + (pr.covers_days || ' days')::interval
  );

comment on view public.outstanding_attendance is
  'DC-1: attendance rows that currently count as unpaid debt. Excludes each person''s free trial (earliest attendance ever), anything already waived, and anything covered by an active term/annual pass window. See specs/attendance-payment-chasing/design.md.';

-- DC-1: a person's current debt count.
create or replace function public.person_outstanding_debt(target_person_id uuid)
returns bigint
language sql
stable
as $$
  select count(*) from public.outstanding_attendance where person_id = target_person_id;
$$;
