-- Migration: identity trust (CID source, conflict log, duplicate dismissals)
-- docs/superpowers/specs/2026-11-14-identity-trust-and-duplicates-design.md
-- Additive only: one nullable column on person, two columns on purchase, two new tables.

-- 1. person.cid_source -------------------------------------------------------
alter table public.person add column if not exists cid_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'person_cid_source_check' and conrelid = 'public.person'::regclass
  ) then
    alter table public.person
      add constraint person_cid_source_check
      check (cid_source is null or cid_source in ('sso','purchase','walk_in'));
  end if;
end $$;

-- Backfill (only rows not yet classified, so re-running is safe):
--   cid null                                  -> null
--   provisional, or only walk-in-style
--   attendance (>=1 record, none from
--   signup_sync/csv_import)                   -> walk_in
--   every other person with a CID             -> sso
update public.person p
set cid_source = case
  when p.identity_confidence = 'provisional' then 'walk_in'
  when exists (select 1 from public.attendance_record a where a.person_id = p.id)
       and not exists (
         select 1 from public.attendance_record a
         where a.person_id = p.id and a.source in ('signup_sync','csv_import')
       ) then 'walk_in'
  else 'sso'
end
where p.cid is not null and p.cid_source is null;

-- 2. purchase manual-match audit columns -------------------------------------
alter table public.purchase add column if not exists manual_matched_by text;
alter table public.purchase add column if not exists manual_matched_at timestamptz;

-- 3. person_identity_conflict -------------------------------------------------
create table if not exists public.person_identity_conflict (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.club (id),
  person_id uuid not null,
  existing_cid text,
  existing_source text check (existing_source is null or existing_source in ('sso','purchase','walk_in')),
  incoming_cid text not null,
  incoming_source text not null check (incoming_source in ('sso','purchase','walk_in')),
  other_person_id uuid,
  outcome text not null check (outcome in ('overwritten','flagged','ignored')),
  status text not null default 'resolved' check (status in ('open','resolved','dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  -- Same-club FKs; other_person_id null skips the check (MATCH SIMPLE).
  constraint person_identity_conflict_person_club_fkey
    foreign key (person_id, club_id) references public.person (id, club_id),
  constraint person_identity_conflict_other_person_club_fkey
    foreign key (other_person_id, club_id) references public.person (id, club_id)
);

comment on table public.person_identity_conflict is
  'Log of CID conflicts between sources. See docs/superpowers/specs/2026-11-14-identity-trust-and-duplicates-design.md.';

alter table public.person_identity_conflict enable row level security;
alter table public.person_identity_conflict force row level security;

-- One open/ignored record per distinct incoming claim; overwrites may repeat.
create unique index if not exists person_identity_conflict_dedup_idx
  on public.person_identity_conflict (club_id, person_id, incoming_cid, incoming_source)
  where outcome in ('flagged','ignored');

create index if not exists person_identity_conflict_club_status_idx
  on public.person_identity_conflict (club_id, status);

-- 4. person_duplicate_dismissal ----------------------------------------------
create table if not exists public.person_duplicate_dismissal (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.club (id),
  name_key text not null,
  members_hash text not null,
  dismissed_by text not null,
  dismissed_at timestamptz not null default now(),
  constraint person_duplicate_dismissal_key unique (club_id, name_key, members_hash)
);

comment on table public.person_duplicate_dismissal is
  'Dismissed duplicate-person groups, keyed by name and a hash of the member set.';

alter table public.person_duplicate_dismissal enable row level security;
alter table public.person_duplicate_dismissal force row level security;
