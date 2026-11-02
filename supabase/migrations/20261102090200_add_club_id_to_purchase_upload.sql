-- supabase/migrations/20261102090200_add_club_id_to_purchase_upload.sql
alter table purchase_upload add column club_id uuid references club(id);

update purchase_upload pu
set club_id = p.club_id
from product p
where p.id = pu.product_id
and pu.club_id is null;

alter table purchase_upload alter column club_id set not null;

alter table purchase_upload
  add constraint purchase_upload_product_club_fkey
  foreign key (product_id, club_id) references product (id, club_id);
