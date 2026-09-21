-- Migration: chase-email content columns; fix admin-identity column types
-- specs/attendance-payment-chasing/tasks.md Phase 6
-- Enables: DC-2, DC-3, DC-5

-- chase_email had no columns to hold the actual drafted email content.
alter table public.chase_email add column subject text;
alter table public.chase_email add column body text;
-- Freeform note: why a row ended up cancelled (this phase's pre-send debt
-- recheck) or, later, why a Phase 7 reviewer rejected it. Same kind of
-- "why this row is in its terminal state" fact either way -- one column.
alter table public.chase_email add column note text;

comment on column public.chase_email.subject is 'Drafted email subject. Set at creation, never regenerated.';
comment on column public.chase_email.body is 'Drafted email body. Set at creation, never regenerated.';
comment on column public.chase_email.note is 'Freeform explanation for a cancelled/rejected row (auto-cancel reason or reviewer feedback).';

-- approved_by was `uuid` with nothing to reference -- admin identity in this
-- app is a Supabase Auth email checked against admin_allowlist (see
-- lib/auth/require-admin.ts), never a person.id or any other uuid. Store the
-- admin's email directly. (Confirmed empty in Step 1 -- USING cast is safe
-- but moot.)
alter table public.chase_email alter column approved_by type text using approved_by::text;

-- Same mistake on person.exempt_set_by: it referenced person(id), but the
-- actor setting an exemption is always an admin (email), never a person
-- record.
alter table public.person drop constraint if exists person_exempt_set_by_fkey;
alter table public.person alter column exempt_set_by type text using exempt_set_by::text;
alter table public.person add column exempt_reason text;

comment on column public.person.exempt_set_by is 'Admin email who set/cleared is_exempt (from admin_allowlist, not a person.id).';
comment on column public.person.exempt_reason is 'Optional freeform reason for the exemption. May be null.';
