-- supabase/migrations/20261031090300_add_club_id_to_existing_tables.sql
alter table person add column club_id uuid references club(id);
alter table session add column club_id uuid references club(id);
alter table product add column club_id uuid references club(id);
alter table purchase add column club_id uuid references club(id);
alter table attendance_record add column club_id uuid references club(id);
alter table chase_email add column club_id uuid references club(id);
alter table sync_cursor add column club_id uuid references club(id);

update person set club_id = (select id from club where slug = 'judo') where club_id is null;
update session set club_id = (select id from club where slug = 'judo') where club_id is null;
update product set club_id = (select id from club where slug = 'judo') where club_id is null;
update purchase set club_id = (select id from club where slug = 'judo') where club_id is null;
update attendance_record set club_id = (select id from club where slug = 'judo') where club_id is null;
update chase_email set club_id = (select id from club where slug = 'judo') where club_id is null;
update sync_cursor set club_id = (select id from club where slug = 'judo') where club_id is null;

alter table person alter column club_id set not null;
alter table session alter column club_id set not null;
alter table product alter column club_id set not null;
alter table purchase alter column club_id set not null;
alter table attendance_record alter column club_id set not null;
alter table chase_email alter column club_id set not null;
alter table sync_cursor alter column club_id set not null;
