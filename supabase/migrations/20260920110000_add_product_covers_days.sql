-- Migration: add covers_days to product, for term/annual pass coverage windows
-- specs/attendance-payment-chasing/tasks.md 5.1, 5.2
-- Enables: MP-1, MP-2

alter table public.product add column covers_days int;

comment on column public.product.covers_days is
  'For kind = term_pass/annual_pass: number of days a purchase of this product covers attendance for, starting from purchase.purchased_at (inclusive) up to purchased_at + covers_days (exclusive). Null for session_pass/other, which use covers_sessions (a count) instead of a date range.';
