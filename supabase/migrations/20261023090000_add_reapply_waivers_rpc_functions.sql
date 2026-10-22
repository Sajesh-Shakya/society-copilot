-- Migration: collapse reapplyWaiversForPerson/reapplyWaiversForEveryoneWithDebt
-- from N application-layer round trips (one SELECT + one RPC call per
-- purchase, times one person at a time for the sweep) down to a single
-- round trip each, by pushing the per-purchase loop into Postgres instead
-- of looping in TypeScript and calling apply_purchase_waiver once per
-- iteration. apply_purchase_waiver itself is unchanged and still used
-- directly wherever a caller already knows the one specific purchase to
-- check (ingestPurchases, changeUploadProduct, rematchUnmatchedPurchases).

create or replace function public.reapply_waivers_for_person(target_person_id uuid)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_purchase_id uuid;
  v_total int := 0;
begin
  for v_purchase_id in
    select id from public.purchase where person_id = target_person_id
  loop
    v_total := v_total + public.apply_purchase_waiver(v_purchase_id);
  end loop;
  return v_total;
end;
$$;

comment on function public.reapply_waivers_for_person(uuid) is
  'Re-checks every purchase already matched to this person for leftover waiving capacity against whatever is currently outstanding -- one round trip from the app instead of one per purchase. See lib/purchase/interface.ts.';

revoke execute on function public.reapply_waivers_for_person(uuid) from public;
grant execute on function public.reapply_waivers_for_person(uuid) to service_role;

create or replace function public.reapply_waivers_for_everyone_with_debt()
returns table(person_id uuid, waived int)
language plpgsql
set search_path = public
as $$
declare
  v_person_id uuid;
begin
  for v_person_id in
    select adc.person_id from public.active_debt_cycle adc
  loop
    person_id := v_person_id;
    waived := public.reapply_waivers_for_person(v_person_id);
    return next;
  end loop;
  return;
end;
$$;

comment on function public.reapply_waivers_for_everyone_with_debt() is
  'Safety-net sweep: re-checks every person currently showing outstanding debt (active_debt_cycle) for leftover purchase waiving capacity, one round trip for the whole sweep instead of one per person times one per purchase. See lib/purchase/interface.ts and the weekly chase-emails cron that calls it.';

revoke execute on function public.reapply_waivers_for_everyone_with_debt() from public;
grant execute on function public.reapply_waivers_for_everyone_with_debt() to service_role;
