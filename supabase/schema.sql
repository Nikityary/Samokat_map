-- Схема базы для карты домофонов (проект Samokat_map).
-- Выполните целиком в Supabase Dashboard → SQL Editor → New query → Run.

create table if not exists public.entries (
  id text primary key,
  lat double precision not null,
  lng double precision not null,
  address text not null default '',
  entrance text not null default '1',
  code text not null default '',
  note text not null default '',
  stale boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.entries enable row level security;

-- Права на таблицу: только авторизованным (anon не получает ничего).
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.entries to authenticated;

-- Доступ только авторизованным сотрудникам: читать и менять могут все вошедшие.
drop policy if exists "entries_select_authenticated" on public.entries;
create policy "entries_select_authenticated" on public.entries
  for select to authenticated using (true);

drop policy if exists "entries_insert_authenticated" on public.entries;
create policy "entries_insert_authenticated" on public.entries
  for insert to authenticated with check (true);

drop policy if exists "entries_update_authenticated" on public.entries;
create policy "entries_update_authenticated" on public.entries
  for update to authenticated using (true) with check (true);

drop policy if exists "entries_delete_authenticated" on public.entries;
create policy "entries_delete_authenticated" on public.entries
  for delete to authenticated using (true);

-- Дома: число подъездов задают курьеры, адрес/координаты — из OSM.
create table if not exists public.buildings (
  id text primary key,              -- id дома в OSM, например 'w123456'
  address text not null default '',
  lat double precision,
  lng double precision,
  entrances_count integer,
  updated_at timestamptz not null default now()
);

alter table public.buildings enable row level security;

grant select, insert, update, delete on public.buildings to authenticated;

drop policy if exists "buildings_select_authenticated" on public.buildings;
create policy "buildings_select_authenticated" on public.buildings
  for select to authenticated using (true);

drop policy if exists "buildings_insert_authenticated" on public.buildings;
create policy "buildings_insert_authenticated" on public.buildings
  for insert to authenticated with check (true);

drop policy if exists "buildings_update_authenticated" on public.buildings;
create policy "buildings_update_authenticated" on public.buildings
  for update to authenticated using (true) with check (true);

drop policy if exists "buildings_delete_authenticated" on public.buildings;
create policy "buildings_delete_authenticated" on public.buildings
  for delete to authenticated using (true);

alter table public.entries
  add column if not exists building_id text references public.buildings (id) on delete cascade;

-- Живые обновления: изменения сразу видны у всех открытых карт.
do $$ begin
  alter publication supabase_realtime add table public.entries;
exception when duplicate_object then null;
end $$;

do $$ begin
  alter publication supabase_realtime add table public.buildings;
exception when duplicate_object then null;
end $$;