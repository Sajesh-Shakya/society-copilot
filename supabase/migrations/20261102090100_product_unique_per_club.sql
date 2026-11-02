-- supabase/migrations/20261102090100_product_unique_per_club.sql
alter table product drop constraint product_name_unique;
alter table product add constraint product_club_id_name_key unique (club_id, name);
