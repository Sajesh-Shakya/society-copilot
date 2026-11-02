create or replace view public.outstanding_attendance as
select
  ar.id,
  ar.person_id,
  ar.session_id,
  s.starts_at,
  ar.club_id
from attendance_record ar
join session s on s.id = ar.session_id
where ar.waived_by_purchase_id is null
  and ar.attended
  and ar.id <> (
    select ar2.id
    from attendance_record ar2
    join session s2 on s2.id = ar2.session_id
    where ar2.person_id = ar.person_id and ar2.attended
    order by s2.starts_at, ar2.id
    limit 1
  )
  and not exists (
    select 1
    from purchase p
    join product pr on pr.id = p.product_id
    where p.person_id = ar.person_id
      and pr.kind = any (array['term_pass', 'annual_pass'])
      and s.starts_at >= p.purchased_at
      and (
        (pr.covers_until is not null and s.starts_at < pr.covers_until)
        or (pr.covers_until is null and pr.covers_days is not null and s.starts_at < p.purchased_at + (pr.covers_days || ' days')::interval)
      )
  );

create or replace view public.active_debt_cycle as
select
  p.id as person_id,
  p.full_name,
  p.email,
  min(oa.starts_at) as debt_cycle_started_at,
  count(*) as debt_count,
  p.club_id
from outstanding_attendance oa
join person p on p.id = oa.person_id
where not p.is_exempt
group by p.id, p.full_name, p.email, p.club_id;
