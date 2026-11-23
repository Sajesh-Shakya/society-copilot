-- Migration: merge duplicate people (same name, confirmed same person by an admin)
-- Additive only: one new table and one new function.

create table if not exists public.person_merge_log (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.club(id),
  kept_person_id uuid not null,
  merged_person jsonb not null,   -- full snapshot of the removed person row
  moved jsonb not null,           -- counts of rows moved/combined
  merged_by text not null,
  merged_at timestamptz not null default now()
);
create index if not exists person_merge_log_club_idx on public.person_merge_log (club_id, merged_at desc);
alter table public.person_merge_log enable row level security; -- deny-all; admin client only

create or replace function public.merge_people(
  target_club_id uuid,
  keep_person_id uuid,
  merge_person_ids uuid[],
  actor text
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  kp public.person%rowtype;
  lp public.person%rowtype;
  lid uuid;
  ce record;
  n_att int; n_att_dupe int; n_pur int; n_chase int;
  total int := 0;
begin
  if merge_person_ids is null or coalesce(array_length(merge_person_ids, 1), 0) = 0 then
    raise exception 'merge_people: nothing to merge';
  end if;
  if keep_person_id = any (merge_person_ids) then
    raise exception 'merge_people: cannot merge a person into themselves';
  end if;

  select * into kp from public.person where id = keep_person_id and club_id = target_club_id for update;
  if not found then
    raise exception 'merge_people: kept person not found in this club';
  end if;

  foreach lid in array merge_person_ids loop
    select * into lp from public.person where id = lid and club_id = target_club_id for update;
    if not found then
      raise exception 'merge_people: person % not found in this club', lid;
    end if;

    -- Attendance: where both have a record for the same session, combine into the kept one.
    update public.attendance_record k
       set attended = k.attended or l.attended,
           waived_by_purchase_id = coalesce(k.waived_by_purchase_id, l.waived_by_purchase_id)
      from public.attendance_record l
     where l.person_id = lid and k.person_id = keep_person_id and k.session_id = l.session_id;
    delete from public.attendance_record l
     using public.attendance_record k
     where l.person_id = lid and k.person_id = keep_person_id and k.session_id = l.session_id;
    get diagnostics n_att_dupe = row_count;
    update public.attendance_record set person_id = keep_person_id where person_id = lid;
    get diagnostics n_att = row_count;

    update public.purchase set person_id = keep_person_id where person_id = lid;
    get diagnostics n_pur = row_count;

    -- Chase emails: keep them all (history); renumber on a sequence collision.
    n_chase := 0;
    for ce in select id, debt_cycle_started_at, sequence_number from public.chase_email
               where person_id = lid order by debt_cycle_started_at, sequence_number loop
      update public.chase_email
         set person_id = keep_person_id,
             sequence_number = case
               when exists (select 1 from public.chase_email x
                             where x.person_id = keep_person_id
                               and x.debt_cycle_started_at = ce.debt_cycle_started_at
                               and x.sequence_number = ce.sequence_number)
               then (select max(x.sequence_number) + 1 from public.chase_email x
                      where x.person_id = keep_person_id and x.debt_cycle_started_at = ce.debt_cycle_started_at)
               else ce.sequence_number end
       where id = ce.id;
      n_chase := n_chase + 1;
    end loop;

    -- Identity conflicts: drop ones between these two; repoint the rest.
    delete from public.person_identity_conflict
     where (person_id = lid and other_person_id = keep_person_id)
        or (person_id = keep_person_id and other_person_id = lid);
    delete from public.person_identity_conflict c
     where c.person_id = lid and c.outcome in ('flagged', 'ignored')
       and exists (select 1 from public.person_identity_conflict k
                    where k.person_id = keep_person_id and k.incoming_cid = c.incoming_cid
                      and k.incoming_source = c.incoming_source and k.outcome in ('flagged', 'ignored'));
    update public.person_identity_conflict set person_id = keep_person_id where person_id = lid;
    update public.person_identity_conflict set other_person_id = keep_person_id where other_person_id = lid;

    -- Free the duplicate's unique CID, then fill gaps on the kept person.
    update public.person set cid = null, cid_source = null where id = lid;
    update public.person
       set cid = coalesce(cid, lp.cid),
           cid_source = case when cid is null and lp.cid is not null then lp.cid_source else cid_source end,
           shortcode = coalesce(shortcode, lp.shortcode),
           is_student = is_student or lp.is_student,
           is_exempt = is_exempt or lp.is_exempt,
           exempt_reason = coalesce(exempt_reason, lp.exempt_reason),
           chase_auto_approved_at = coalesce(chase_auto_approved_at, lp.chase_auto_approved_at),
           chase_auto_approved_by = coalesce(chase_auto_approved_by, lp.chase_auto_approved_by)
     where id = keep_person_id;

    insert into public.person_merge_log (club_id, kept_person_id, merged_person, moved, merged_by)
    values (target_club_id, keep_person_id, to_jsonb(lp),
            jsonb_build_object('attendance_moved', n_att, 'attendance_combined', n_att_dupe,
                               'purchases', n_pur, 'chase_emails', n_chase),
            actor);

    delete from public.person where id = lid;
    total := total + 1;
  end loop;

  return jsonb_build_object('merged', total);
end;
$$;

revoke execute on function public.merge_people(uuid, uuid, uuid[], text) from public;
grant execute on function public.merge_people(uuid, uuid, uuid[], text) to service_role;
