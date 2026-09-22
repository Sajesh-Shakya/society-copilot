-- Migration: add eActivities signup binding + per-session sync tracking to session
-- specs/attendance-payment-chasing/tasks.md 2.x (Phase 2 prep)
-- Enables: AC-8 (new), AC-6, AC-7

alter table public.session
  add column eactivities_signup_id text unique,
  add column last_synced_at timestamptz;

comment on column public.session.eactivities_signup_id is
  'The specific eActivities signup (attendee-roster form) this session ticks attendance against. Picked manually by an admin from the event''s attached signups (GET /csp/{centre}/whatson/{id}) -- not derivable automatically, since an event can have unrelated signup forms with no distinguishing flag.';
comment on column public.session.last_synced_at is
  'Last time this session''s roster was successfully synced from eActivities. Drives the manual-sync debounce (AC-6) and the scheduled-sync window check (AC-7). Independent of the global sync_cursor table, which doesn''t fit a per-session sync pattern.';
