-- supabase/migrations/20261102090000_add_same_club_foreign_keys.sql
alter table person add constraint person_id_club_id_key unique (id, club_id);
alter table session add constraint session_id_club_id_key unique (id, club_id);
alter table product add constraint product_id_club_id_key unique (id, club_id);
alter table purchase add constraint purchase_id_club_id_key unique (id, club_id);

alter table attendance_record
  add constraint attendance_record_person_club_fkey
  foreign key (person_id, club_id) references person (id, club_id);

alter table attendance_record
  add constraint attendance_record_session_club_fkey
  foreign key (session_id, club_id) references session (id, club_id);

alter table attendance_record
  add constraint attendance_record_waived_purchase_club_fkey
  foreign key (waived_by_purchase_id, club_id) references purchase (id, club_id);

alter table purchase
  add constraint purchase_person_club_fkey
  foreign key (person_id, club_id) references person (id, club_id);

alter table purchase
  add constraint purchase_product_club_fkey
  foreign key (product_id, club_id) references product (id, club_id);

alter table chase_email
  add constraint chase_email_person_club_fkey
  foreign key (person_id, club_id) references person (id, club_id);
