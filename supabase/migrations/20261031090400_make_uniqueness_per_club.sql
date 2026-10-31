drop index person_cid_unique_idx;
create unique index person_club_id_cid_unique_idx on person (club_id, cid) where (cid is not null);

drop index person_email_unique_idx;
create unique index person_club_id_email_unique_idx on person (club_id, lower(email));

alter table session drop constraint session_eactivities_event_id_key;
alter table session add constraint session_club_id_eactivities_event_id_key unique (club_id, eactivities_event_id);

alter table session drop constraint session_eactivities_signup_id_key;
alter table session add constraint session_club_id_eactivities_signup_id_key unique (club_id, eactivities_signup_id);

alter table purchase drop constraint purchase_source_source_row_id_key;
alter table purchase add constraint purchase_club_id_source_source_row_id_key unique (club_id, source, source_row_id);

alter table sync_cursor drop constraint sync_cursor_pkey;
alter table sync_cursor add constraint sync_cursor_pkey primary key (club_id, source);
