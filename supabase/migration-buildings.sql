-- Миграция: дома и списки подъездов (для уже созданной базы).
-- Выполните целиком в Supabase Dashboard → SQL Editor → New query → Run.

create table if not exists public.buildings (
  id text primary key,              -- id дома в OSM, например 'w123456'
  address text not null default '',
  lat double precision,
  lng double precision,
  entrances_count integer,          -- число подъездов, заданное курьерами
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

-- Записи теперь привязаны к дому; подъезд хранится в существующей колонке entrance.
alter table public.entries
  add column if not exists building_id text references public.buildings (id) on delete cascade;

do $$ begin
  alter publication supabase_realtime add table public.buildings;
exception when duplicate_object then null;
end $$;