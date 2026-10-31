-- supabase/migrations/20261031090200_create_club_credential_table.sql
create table club_credential (
  club_id uuid not null references club(id),
  provider text not null check (provider in ('eactivities', 'pluto')),
  credentials jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (club_id, provider)
);

alter table club_credential enable row level security;
alter table club_credential force row level security;
