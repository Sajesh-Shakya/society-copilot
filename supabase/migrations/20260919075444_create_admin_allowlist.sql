-- Migration: create admin_allowlist table
-- docs/superpowers/specs/2026-09-19-admin-auth-design.md
-- Binary admin access: presence in this table is sufficient, no role column.

create table public.admin_allowlist (
  email text primary key,
  added_at timestamptz not null default now()
);

comment on table public.admin_allowlist is
  'Emails allowed to sign in and use the attendance-tracking admin tools. Checked before sending a magic link (lib/auth/actions.ts) and re-checked on every privileged call (lib/auth/require-admin.ts) so removal takes effect immediately. Not domain-restricted -- seed data spans @ic.ac.uk and @imperial.ac.uk.';

-- RLS: deny-all, same pattern as every other table in this project. Only
-- ever queried via the admin (secret-key) client, server-side.
alter table public.admin_allowlist enable row level security;
alter table public.admin_allowlist force row level security;

insert into public.admin_allowlist (email) values
  ('ss5123@ic.ac.uk'),
  ('carina.pravinata24@imperial.ac.uk'),
  ('g.tyukin25@imperial.ac.uk');
