-- Migration: chase_email 'sending'/'failed' statuses; provider_message_id
-- docs/superpowers/specs/2026-09-23-chase-email-sending-design.md
--
-- 'sending' is the atomic-claim state a row occupies only for the
-- duration of one sendChaseEmail() call -- it always exits to 'sent' or
-- 'failed'. A row found stuck at 'sending' outside that window is a bug,
-- not a state the UI needs to handle gracefully.
--
-- 'failed' is a terminal state with no automatic retry: an admin must
-- re-approve the row from the chase inbox to try again (see the
-- companion change to lib/chase/approval-writer.ts's approveChaseEmail).

alter table public.chase_email drop constraint chase_email_status_check;
alter table public.chase_email add constraint chase_email_status_check
  check (status in ('draft','pending_approval','approved','sending','sent','cancelled','failed'));

alter table public.chase_email add column provider_message_id text;

comment on column public.chase_email.provider_message_id is
  'Resend''s message id for a sent email. Set only when status = sent. Used for support/debug traceability.';
