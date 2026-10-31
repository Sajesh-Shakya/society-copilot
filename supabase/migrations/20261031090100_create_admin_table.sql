create table admin (
  email text not null,
  club_id uuid not null references club(id),
  added_at timestamptz not null default now(),
  primary key (email, club_id)
);

alter table admin enable row level security;
alter table admin force row level security;

insert into admin (email, club_id)
select email, (select id from club where slug = 'judo')
from admin_allowlist;
