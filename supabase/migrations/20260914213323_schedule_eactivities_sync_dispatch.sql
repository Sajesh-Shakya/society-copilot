-- Migration: schedule the eActivities sync dispatcher via pg_cron
-- specs/attendance-payment-chasing/tasks.md 2.3
-- Enables: AC-7
-- design.md's Scheduling decision: pg_cron + Edge Functions, not Vercel Cron
-- (Vercel Hobby cron can't do sub-daily, session-specific triggers).
--
-- No secret value lives in this file. The dispatcher's own apikey is read
-- from Vault at call time (see 'eactivities_dispatcher_apikey', set via
-- execute_sql, never committed) -- per Supabase's own guidance for pg_net +
-- Edge Function calls: "Don't hardcode a secret key in SQL ... where it's
-- stored in plain text. Store it in Vault and read it at call time."

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'eactivities-sync-dispatch',
  '*/5 * * * *', -- every 5 minutes; dispatcher itself narrows to sessions actually due
  $$
  select net.http_post(
    url := 'https://gszhsinwewcfyqjixpgu.supabase.co/functions/v1/eactivities-sync-dispatcher',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'eactivities_dispatcher_apikey')
    ),
    body := jsonb_build_object('trigger', 'cron', 'time', now()),
    timeout_milliseconds := 20000
  ) as request_id;
  $$
);
