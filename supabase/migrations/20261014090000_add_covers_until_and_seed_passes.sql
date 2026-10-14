-- Migration: absolute pass-expiry support + seed the real pass catalog.
--
-- The existing `covers_days` column only expresses "N days after the
-- purchase date" -- but real passes here expire on a FIXED calendar date
-- regardless of when they're bought (e.g. a Term 1 Pass always expires
-- 1 Jan 2027, whether bought in September or December). A rolling day
-- count can't express that: sized for an early buyer, it under-covers a
-- late buyer; sized for a late buyer, it over-covers an early one. This
-- adds `covers_until`, an absolute cutoff, as an alternative to
-- `covers_days`. When both are null for session_pass/other, there's no
-- expiry at all (unchanged default). When set, no session on or after
-- `covers_until` can ever be waived by that purchase, regardless of kind
-- -- this applies to session_pass passes too (a single-session/batch pass
-- bought now but never used also expires at the stated cutoff).
alter table public.product add column covers_until timestamptz;

comment on column public.product.covers_until is
  'Absolute cutoff: no session starting on or after this instant can be waived by a purchase of this product, regardless of kind. Alternative to covers_days (which is relative to purchased_at) for products with a fixed calendar expiry rather than a rolling window. Null means no absolute cutoff.';

alter table public.product drop constraint product_term_annual_requires_covers_days;
alter table public.product add constraint product_term_annual_requires_covers_days
  check (kind not in ('term_pass', 'annual_pass') or covers_days is not null or covers_until is not null);

-- apply_purchase_waiver: session_pass branch now also respects covers_until.
create or replace function public.apply_purchase_waiver(target_purchase_id uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_person_id uuid;
  v_product_kind text;
  v_covers_sessions int;
  v_covers_until timestamptz;
  v_waived_count int;
begin
  select p.person_id, pr.kind, pr.covers_sessions, pr.covers_until
  into v_person_id, v_product_kind, v_covers_sessions, v_covers_until
  from public.purchase p
  join public.product pr on pr.id = p.product_id
  where p.id = target_purchase_id;

  if v_person_id is null then
    return 0;
  end if;

  if v_product_kind = 'session_pass' and v_covers_sessions is not null then
    with to_waive as (
      select oa.id
      from public.outstanding_attendance oa
      where oa.person_id = v_person_id
        and (v_covers_until is null or oa.starts_at < v_covers_until)
      order by oa.starts_at asc
      limit v_covers_sessions
    )
    update public.attendance_record
    set waived_by_purchase_id = target_purchase_id
    where id in (select id from to_waive)
      and waived_by_purchase_id is null;
    get diagnostics v_waived_count = row_count;

  elsif v_product_kind in ('term_pass', 'annual_pass') then
    -- The term/annual covers_days/covers_until window is enforced
    -- continuously by outstanding_attendance's own NOT EXISTS clause (see
    -- below), not here -- this just waives whatever currently qualifies.
    with to_waive as (
      select oa.id
      from public.outstanding_attendance oa
      where oa.person_id = v_person_id
    )
    update public.attendance_record
    set waived_by_purchase_id = target_purchase_id
    where id in (select id from to_waive)
      and waived_by_purchase_id is null;
    get diagnostics v_waived_count = row_count;

  else
    v_waived_count := 0;
  end if;

  return v_waived_count;
end;
$$;

revoke execute on function public.apply_purchase_waiver(uuid) from public;
grant execute on function public.apply_purchase_waiver(uuid) to service_role;

-- outstanding_attendance: term/annual coverage window now prefers
-- covers_until (absolute) over covers_days (relative) when both are set.
create or replace view public.outstanding_attendance as
select ar.id, ar.person_id, ar.session_id, s.starts_at
from public.attendance_record ar
join public.session s on s.id = ar.session_id
where ar.waived_by_purchase_id is null
  and ar.attended
  and ar.id <> (
    select ar2.id
    from public.attendance_record ar2
    join public.session s2 on s2.id = ar2.session_id
    where ar2.person_id = ar.person_id
      and ar2.attended
    order by s2.starts_at asc, ar2.id asc
    limit 1
  )
  and not exists (
    select 1
    from public.purchase p
    join public.product pr on pr.id = p.product_id
    where p.person_id = ar.person_id
      and pr.kind in ('term_pass', 'annual_pass')
      and s.starts_at >= p.purchased_at
      and (
        (pr.covers_until is not null and s.starts_at < pr.covers_until)
        or (pr.covers_until is null and pr.covers_days is not null
            and s.starts_at < p.purchased_at + (pr.covers_days || ' days')::interval)
      )
  );

comment on view public.outstanding_attendance is
  'DC-1: attendance rows that currently count as unpaid debt. Excludes anything not attended, each person''s free trial (earliest ATTENDED session ever), anything already waived, and anything covered by an active term/annual pass window (covers_until if set, else covers_days from purchased_at). Runs with the view owner''s rights (security_invoker is off, the Postgres default for views) and so bypasses RLS on the tables it joins -- protection comes from anon/authenticated holding no SELECT grant on this view or the underlying tables, not from RLS. See specs/attendance-payment-chasing/design.md.';

-- Seed the real pass catalog (previously empty -- nothing had ever been
-- curated here; the ingestion pipeline auto-created bare 'other' products
-- by name instead, which is no longer how products get created now that
-- an admin picks one from this catalog before every XLSX upload).
--
-- Expiry-date assumptions (all exclusive cutoffs -- a session must start
-- strictly BEFORE this instant to be covered); correct with a plain
-- UPDATE if any of these are off:
--   - Single/Batch session passes, Term 3 Pass, All 3 Terms Pass: valid
--     through the end of the 2026/27 academic year -> 2027-09-01.
--   - Term 1 Pass: expires 1 Jan 2027 -> cutoff 2027-01-01.
--   - Term 2 Pass: "expiry April 2027" -- assumed valid through the end
--     of April -> cutoff 2027-05-01.
insert into public.product (name, kind, covers_sessions, covers_until) values
  ('Single Session Pass', 'session_pass', 1, '2027-09-01T00:00:00Z'),
  ('10-Session Batch Pass', 'session_pass', 10, '2027-09-01T00:00:00Z'),
  ('Term 1 Pass', 'term_pass', null, '2027-01-01T00:00:00Z'),
  ('Term 2 Pass', 'term_pass', null, '2027-05-01T00:00:00Z'),
  ('Term 3 Pass', 'term_pass', null, '2027-09-01T00:00:00Z'),
  ('All 3 Terms Pass', 'annual_pass', null, '2027-09-01T00:00:00Z');
