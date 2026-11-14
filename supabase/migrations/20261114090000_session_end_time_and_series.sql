-- Migration: session end time and weekly recurring series
-- docs/superpowers/specs/2026-11-13-performance-and-recurring-events-design.md
-- Additive only: a new table plus two nullable columns on session.

create table if not exists public.session_series (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.club (id),
  title text not null,
  created_at timestamptz not null default now(),
  -- Target of the composite same-club FK from session (series_id, club_id).
  constraint session_series_id_club_id_key unique (id, club_id)
);

comment on table public.session_series is
  'Groups the weekly occurrences of a recurring session. See docs/superpowers/specs/2026-11-13-performance-and-recurring-events-design.md.';

-- RLS: deny-all, same as session. All access is server-side via the service role.
alter table public.session_series enable row level security;
alter table public.session_series force row level security;

alter table public.session add column if not exists ends_at timestamptz;
alter table public.session add column if not exists series_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'session_ends_after_starts_check' and conrelid = 'public.session'::regclass
  ) then
    alter table public.session
      add constraint session_ends_after_starts_check
      check (ends_at is null or ends_at > starts_at);
  end if;

  -- No ON DELETE action: deleting a series that still has sessions must fail.
  -- series_id null skips the check (MATCH SIMPLE), so standalone sessions are unaffected.
  if not exists (
    select 1 from pg_constraint
    where conname = 'session_series_club_fkey' and conrelid = 'public.session'::regclass
  ) then
    alter table public.session
      add constraint session_series_club_fkey
      foreign key (series_id, club_id) references public.session_series (id, club_id);
  end if;
end $$;

create index if not exists session_series_id_starts_at_idx
  on public.session (series_id, starts_at);
