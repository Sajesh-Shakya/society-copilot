-- Migration: respect attendance_record.attended in outstanding_attendance;
-- harden apply_purchase_waiver/person_outstanding_debt against unintended
-- PUBLIC execute; guard against concurrent double-waive; require
-- covers_days whenever a product is a term/annual pass.
--
-- Found in the final whole-branch review of
-- docs/superpowers/plans/2026-09-20-debt-calculation.md:
--
-- Critical: outstanding_attendance ignored attendance_record.attended, so
-- a no-show (attended=false is possible, but the eActivities sync inserts
-- attended=true by default for every signup -- a signup is an intention,
-- not an attendance) was counted as unpaid debt, and the attendance-screen's
-- attended toggle (the whole point of AC-1/AC-2) had no effect on debt.
-- A no-show could also consume a person's free trial slot, since the
-- free-trial subquery had the same gap.
--
-- Hardening: apply_purchase_waiver and person_outstanding_debt were left
-- with the default GRANT EXECUTE TO PUBLIC, and outstanding_attendance's
-- comment incorrectly claimed "SECURITY INVOKER (default)" -- the view
-- actually runs with its owner's rights (security_invoker is off by
-- default for views) and bypasses RLS on the tables it joins. This is
-- inert today only because anon/authenticated hold no SELECT/UPDATE grant
-- on the underlying tables -- but attendance_record's own anon-read
-- Realtime policy is already broken for that identical missing-grant
-- reason (see tasks.md 3.3a), making a future "fix Realtime" change a
-- plausible path to arming apply_purchase_waiver as an unauthenticated
-- debt-wiping endpoint. Revoking PUBLIC execute and pinning search_path
-- closes this off now, while it's free to do.
--
-- Data integrity: nothing prevented a term_pass/annual_pass product from
-- being curated with covers_days left NULL, which would waive all of a
-- person's prior debt (the waiver's term/annual branch doesn't consult
-- covers_days) while providing zero forward coverage (the view's window
-- check requires covers_days is not null) -- a silent, money-affecting
-- misconfiguration. A check constraint makes this fail loudly instead.
--
-- Concurrency: apply_purchase_waiver's UPDATE statements didn't re-check
-- waived_by_purchase_id is null, so two concurrent calls for the same
-- person could both count and report the same rows as waived.
--
-- Correction found while verifying this migration live: neither function
-- had ever been granted EXECUTE explicitly to service_role -- both relied
-- solely on the Postgres-default PUBLIC grant (service_role is itself a
-- member of PUBLIC). Revoking PUBLIC execute without also granting
-- service_role explicitly broke the admin client -- the one caller both
-- functions' own comments say is the only intended caller -- with
-- "permission denied", confirmed by tests/integration failing end-to-end.
-- Both revokes below are followed by an explicit grant to service_role so
-- the hardening (locking out anon/authenticated/PUBLIC) holds without
-- locking out the one caller that's supposed to work.

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
      and pr.covers_days is not null
      and s.starts_at >= p.purchased_at
      and s.starts_at < p.purchased_at + (pr.covers_days || ' days')::interval
  );

comment on view public.outstanding_attendance is
  'DC-1: attendance rows that currently count as unpaid debt. Excludes anything not attended, each person''s free trial (earliest ATTENDED session ever), anything already waived, and anything covered by an active term/annual pass window. Runs with the view owner''s rights (security_invoker is off, the Postgres default for views) and so bypasses RLS on the tables it joins -- protection comes from anon/authenticated holding no SELECT grant on this view or the underlying tables, not from RLS. See specs/attendance-payment-chasing/design.md.';

create or replace function public.person_outstanding_debt(target_person_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
  select count(*) from public.outstanding_attendance where person_id = target_person_id;
$$;

revoke execute on function public.person_outstanding_debt(uuid) from public;
grant execute on function public.person_outstanding_debt(uuid) to service_role;

create or replace function public.apply_purchase_waiver(target_purchase_id uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_person_id uuid;
  v_product_kind text;
  v_covers_sessions int;
  v_waived_count int;
begin
  select p.person_id, pr.kind, pr.covers_sessions
  into v_person_id, v_product_kind, v_covers_sessions
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
      order by oa.starts_at asc
      limit v_covers_sessions
    )
    update public.attendance_record
    set waived_by_purchase_id = target_purchase_id
    where id in (select id from to_waive)
      and waived_by_purchase_id is null;
    get diagnostics v_waived_count = row_count;

  elsif v_product_kind in ('term_pass', 'annual_pass') then
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

comment on function public.apply_purchase_waiver(uuid) is
  'MP-3: waives as much of a person''s outstanding debt as the given purchase covers. Only ever called via the admin/service_role client, the same as every other write in this codebase. PUBLIC execute is revoked below since this function WRITES (unlike the read-only person_outstanding_debt) and nothing but the admin client should ever be able to call it.';

revoke execute on function public.apply_purchase_waiver(uuid) from public;
grant execute on function public.apply_purchase_waiver(uuid) to service_role;

alter table public.product
  add constraint product_term_annual_requires_covers_days
  check (kind not in ('term_pass', 'annual_pass') or covers_days is not null);
