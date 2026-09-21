-- Migration: active_debt_cycle view
-- specs/attendance-payment-chasing/tasks.md 6.1, 6.4
-- Enables: DC-2, DC-5

-- One row per non-exempt person who currently has outstanding debt, giving
-- the start of their active debt cycle (oldest currently-outstanding
-- session) and their current debt count. Exempt persons (DC-5) never appear
-- here, so chase-email generation naturally never considers them. A person
-- with zero debt also never appears here (DC-1/DC-6): this view IS the
-- "does this person have an active debt cycle" answer.
create or replace view public.active_debt_cycle as
select
  p.id as person_id,
  p.full_name,
  p.email,
  min(oa.starts_at) as debt_cycle_started_at,
  count(*) as debt_count
from public.outstanding_attendance oa
join public.person p on p.id = oa.person_id
where not p.is_exempt
group by p.id, p.full_name, p.email;

comment on view public.active_debt_cycle is
  'DC-2/DC-5/DC-6: one row per non-exempt person with current outstanding debt, with their debt cycle''s start date and count. See specs/attendance-payment-chasing/design.md.';
