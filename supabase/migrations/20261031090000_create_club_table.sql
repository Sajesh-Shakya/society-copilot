create table club (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

alter table club enable row level security;
alter table club force row level security;

insert into club (name, slug) values
  ('Judo', 'judo'),
  ('Taekwondo', 'taekwondo');
