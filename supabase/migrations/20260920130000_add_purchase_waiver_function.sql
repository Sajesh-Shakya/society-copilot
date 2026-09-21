-- Migration: purchase waiver function
-- specs/attendance-payment-chasing/tasks.md 5.3
-- Enables: MP-3

-- When a purchase is ingested and matched to a person, waive as much of
-- their currently-outstanding debt as that purchase covers:
--   - session_pass: waives up to `covers_sessions` of the person's oldest
--     outstanding attendance rows (FIFO -- oldest debt cleared first).
--   - term_pass / annual_pass: waives ALL of the person's currently
--     outstanding attendance rows, per this plan's ruling that MP-3's
--     "covers prior unpaid attendance" applies broadly, not just within
--     the pass's own forward date window (outstanding_attendance's own
--     date-window check already handles MP-1's forward-looking case
--     separately, so this branch is specifically the retroactive case).
--   - any other kind (including the Phase-4 ingestion shortcut's
--     auto-created 'other' products): waives nothing. An admin must curate
--     the product's kind/covers_sessions/covers_days before it can waive
--     debt.
-- Returns the number of attendance rows waived, for logging/testing.
-- Idempotent: calling this twice for the same purchase waives 0 additional
-- rows the second time, since already-waived rows drop out of
-- outstanding_attendance.
--
-- SECURITY INVOKER (default): only ever called via the admin (secret-key)
-- client, which already bypasses RLS regardless -- same convention as
-- search_person_by_name and person_outstanding_debt.
create or replace function public.apply_purchase_waiver(target_purchase_id uuid)
returns int
language plpgsql
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
    where id in (select id from to_waive);
    get diagnostics v_waived_count = row_count;

  elsif v_product_kind in ('term_pass', 'annual_pass') then
    with to_waive as (
      select oa.id
      from public.outstanding_attendance oa
      where oa.person_id = v_person_id
    )
    update public.attendance_record
    set waived_by_purchase_id = target_purchase_id
    where id in (select id from to_waive);
    get diagnostics v_waived_count = row_count;

  else
    v_waived_count := 0;
  end if;

  return v_waived_count;
end;
$$;
