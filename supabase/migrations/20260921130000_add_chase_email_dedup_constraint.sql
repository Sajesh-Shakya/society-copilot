-- Migration: unique constraint backing chase_email dedup
-- Final whole-branch review finding: generateChaseEmails()'s dedup was
-- read-then-insert application logic only, with no structural guarantee
-- against a concurrent/retried run double-drafting the same cycle+sequence.
alter table public.chase_email
  add constraint chase_email_person_cycle_sequence_unique
  unique (person_id, debt_cycle_started_at, sequence_number);

comment on constraint chase_email_person_cycle_sequence_unique on public.chase_email is
  'Structural dedup guarantee: at most one chase_email per person per debt cycle per sequence number.';

alter view public.active_debt_cycle set (security_invoker = true);
