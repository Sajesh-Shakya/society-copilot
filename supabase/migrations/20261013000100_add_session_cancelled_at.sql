-- Adds a soft-delete/cancel flag to session rather than supporting a hard
-- delete: a cancelled session (e.g. the club cancels Judo this Wednesday)
-- should stop being treated as active without losing whatever roster/
-- attendance data was already attached to it.
alter table public.session add column cancelled_at timestamptz;

comment on column public.session.cancelled_at is
  'Set when an admin cancels a scheduled session (e.g. event called off). Null means active. Soft-delete only -- never hard-deleted via the app UI.';
