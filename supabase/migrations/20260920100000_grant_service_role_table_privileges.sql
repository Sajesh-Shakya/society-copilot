-- Migration: grant service_role standard CRUD privileges
--
-- Discovered during the final review of docs/superpowers/plans/2026-09-19-purchase-ingestion.md:
-- service_role had only REFERENCES/TRIGGER/TRUNCATE on every public-schema
-- table (confirmed via information_schema.role_table_grants), missing
-- SELECT/INSERT/UPDATE/DELETE project-wide. This blocked every feature that
-- writes via createAdminClient() (lib/supabase/admin.ts) -- attendance sync,
-- session creation, walk-ins, purchase ingestion, etc. -- against this
-- project. Pre-existing gap, not introduced by any application code.
--
-- service_role already bypasses RLS by Supabase convention; it still needs
-- ordinary Postgres table grants, which is what this migration adds.

grant select, insert, update, delete on all tables in schema public to service_role;

-- Ensures tables created by future migrations get the same grants
-- automatically, without needing a repeat of this migration.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
