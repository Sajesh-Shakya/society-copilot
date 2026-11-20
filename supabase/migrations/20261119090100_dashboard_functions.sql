-- Migration: dashboard aggregate functions (per club)
-- docs/superpowers/specs/2026-11-18-dashboard-prices-autosend-design.md
-- Additive only. All totals computed in SQL so PostgREST's 1000-row cap never truncates them.

create or replace function public.dashboard_signups(
  target_club_id uuid,
  range_start timestamptz,
  range_end timestamptz
)
returns table (session_id uuid, title text, starts_at timestamptz, signups bigint, attended bigint)
language sql stable
set search_path = public
as $$
  select s.id, s.title, s.starts_at,
         count(a.id) as signups,
         count(a.id) filter (where a.attended) as attended
  from public.session s
  left join public.attendance_record a
    on a.session_id = s.id and a.club_id = target_club_id
  where s.club_id = target_club_id
    and s.cancelled_at is null
    and s.starts_at >= range_start
    and s.starts_at < range_end
  group by s.id, s.title, s.starts_at
  order by s.starts_at desc;
$$;

create or replace function public.dashboard_revenue(
  target_club_id uuid,
  range_start timestamptz,
  range_end timestamptz
)
returns table (product_id uuid, product_name text, purchases bigint, unpriced bigint, revenue_pence bigint)
language sql stable
set search_path = public
as $$
  select p.id, p.name,
         count(pu.id) as purchases,
         count(pu.id) filter (where pu.price_pence is null) as unpriced,
         coalesce(sum(pu.price_pence), 0)::bigint as revenue_pence
  from public.purchase pu
  join public.product p on p.id = pu.product_id and p.club_id = target_club_id
  where pu.club_id = target_club_id
    and pu.purchased_at >= range_start
    and pu.purchased_at < range_end
  group by p.id, p.name
  order by p.name;
$$;

create or replace function public.dashboard_money_owed(target_club_id uuid)
returns table (sessions bigint, people bigint, bucket_0_14 bigint, bucket_15_30 bigint, bucket_31_plus bigint)
language sql stable
set search_path = public
as $$
  select coalesce(sum(d.debt_count), 0)::bigint,
         count(*)::bigint,
         count(*) filter (where floor(extract(epoch from (now() - d.debt_cycle_started_at)) / 86400) <= 14),
         count(*) filter (where floor(extract(epoch from (now() - d.debt_cycle_started_at)) / 86400) between 15 and 30),
         count(*) filter (where floor(extract(epoch from (now() - d.debt_cycle_started_at)) / 86400) >= 31)
  from public.active_debt_cycle d
  where d.club_id = target_club_id;
$$;
